/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type {PageVisibility, ValidatedRepoInfo} from 'isl/src/types';
import type {PageFocusTracker} from './PageFocusTracker';
import type {Logger} from './logger';

import fs from 'node:fs/promises';
import path from 'node:path';
import {debounce} from 'shared/debounce';
import {stagedThrottler} from './StagedThrottler';
import {type ServerSideTracker} from './analytics/serverSideTracker';
import {ONE_MINUTE_MS} from './constants';
import type {RepositoryContext} from './serverTypes';
import {Watchman} from './watchman';

const DEFAULT_POLL_INTERVAL = 15 * ONE_MINUTE_MS;
// When the page is hidden, aggressively reduce polling.
const HIDDEN_POLL_INTERVAL = 3 * 60 * ONE_MINUTE_MS;
// When visible or focused, poll frequently
const VISIBLE_POLL_INTERVAL = 2 * ONE_MINUTE_MS;
const FOCUSED_POLL_INTERVAL = 0.5 * ONE_MINUTE_MS;
const ON_FOCUS_REFETCH_THROTTLE = 15_000;
const ON_VISIBLE_REFETCH_THROTTLE = 30_000;

export type KindOfChange = 'uncommitted changes' | 'commits' | 'merge conflicts' | 'everything';
export type PollKind = PageVisibility | 'force';

/**
 * Handles watching for changes to files on disk which should trigger refetching data,
 * and polling for changes when watching is not reliable.
 */
export class WatchForChanges {
  // No meaningful git.update defer; use empty string to disable
  static WATCHMAN_DEFER = ``;
  public watchman: Watchman;

  private dirstateDisposables: Array<() => unknown> = [];
  private watchmanDisposables: Array<() => unknown> = [];
  private logger: Logger;
  private tracker: ServerSideTracker;
  private dirstateSubscriptionPromise: Promise<void>;

  constructor(
    private repoInfo: ValidatedRepoInfo,
    private pageFocusTracker: PageFocusTracker,
    private changeCallback: (kind: KindOfChange, pollKind?: PollKind) => unknown,
    ctx: RepositoryContext,
    watchman?: Watchman | undefined,
  ) {
    this.logger = ctx.logger;
    this.tracker = ctx.tracker;
    this.watchman = watchman ?? new Watchman(ctx.logger, ctx.tracker);

    // Watch .git/ right away for commit/conflict changes
    this.dirstateSubscriptionPromise = this.setupDirstateSubscriptions(ctx);
    this.setupPolling();
    this.pageFocusTracker.onChange(this.poll.bind(this));
    // poll right away so we get data immediately, without waiting for timeout on startup
    this.poll('force');
  }

  private timeout: NodeJS.Timeout | undefined;
  private lastFetch = new Date().valueOf();

  /**
   * Waits for the dirstate subscription to be set up
   * since we can't await in the constructor
   */
  public async waitForDirstateSubscriptionReady(): Promise<void> {
    await this.dirstateSubscriptionPromise;
  }

  private setupPolling() {
    this.timeout = setTimeout(this.poll, DEFAULT_POLL_INTERVAL);
  }

  public poll = (kind?: PollKind) => {
    let desiredNextTickTime = DEFAULT_POLL_INTERVAL;

    if (this.watchman.status !== 'healthy') {
      if (this.pageFocusTracker.hasPageWithFocus()) {
        desiredNextTickTime = FOCUSED_POLL_INTERVAL;
      } else if (this.pageFocusTracker.hasVisiblePage()) {
        desiredNextTickTime = VISIBLE_POLL_INTERVAL;
      }
    } else {
      // if watchman is working normally, and we're not visible, don't poll nearly as often
      if (!this.pageFocusTracker.hasPageWithFocus() && !this.pageFocusTracker.hasVisiblePage()) {
        desiredNextTickTime = HIDDEN_POLL_INTERVAL;
      }
    }

    const now = Date.now();
    const elapsedTickTime = now - this.lastFetch;

    if (
      kind === 'force' ||
      elapsedTickTime >= desiredNextTickTime ||
      (kind === 'focused' && elapsedTickTime >= ON_FOCUS_REFETCH_THROTTLE) ||
      (kind === 'visible' && elapsedTickTime >= ON_VISIBLE_REFETCH_THROTTLE)
    ) {
      this.changeCallback('everything', kind);
      this.lastFetch = Date.now();

      clearTimeout(this.timeout);
      this.timeout = setTimeout(this.poll, desiredNextTickTime);
    } else {
      clearTimeout(this.timeout);
      this.timeout = setTimeout(this.poll, desiredNextTickTime - elapsedTickTime);
    }
  };

  private async setupDirstateSubscriptions(ctx: RepositoryContext) {
    await this.setupWatchmanDirstateSubscriptions(ctx);
  }

  /**
   * Watch .git/ for changes to HEAD, refs, index, and conflict markers.
   * - HEAD / refs/ changes -> commits changed (checkout, branch create/delete)
   * - index changes -> uncommitted changes changed (git add/reset)
   * - MERGE_HEAD / REBASE_HEAD / CHERRY_PICK_HEAD -> merge conflict state
   */
  private async setupWatchmanDirstateSubscriptions(ctx: RepositoryContext) {
    const {repoRoot, dotdir} = this.repoInfo;

    if (repoRoot == null || dotdir == null) {
      this.logger.error(`skipping dirstate subscription since ${repoRoot} is not a repository`);
      return;
    }

    // dotdir from `git rev-parse --git-dir` may be relative; resolve it against repoRoot
    const absoluteDotdir = path.isAbsolute(dotdir) ? dotdir : path.join(repoRoot, dotdir);
    // Resolve symlinks since Watchman doesn't follow them
    const realDotdir = await fs.realpath(absoluteDotdir);

    if (realDotdir !== dotdir) {
      this.logger.info(`resolved dotdir ${dotdir} to ${realDotdir}`);
      // Write out ".watchmanconfig" so realDotdir passes muster as a watchman "root dir"
      await fs.writeFile(path.join(realDotdir, '.watchmanconfig'), '{}');
    }

    const DIRSTATE_WATCHMAN_SUBSCRIPTION = 'graphite-log-gitstate-change';
    try {
      const handleRepositoryStateChange = debounce(() => {
        this.changeCallback('everything');
        this.lastFetch = new Date().valueOf();
      }, 100);

      const handleConflictStateChange = debounce(() => {
        this.changeCallback('merge conflicts');
      }, 100);

      this.logger.info('setting up git dirstate subscription', realDotdir);

      const dirstateSubscription = await this.watchman.watchDirectoryRecursive(
        realDotdir,
        DIRSTATE_WATCHMAN_SUBSCRIPTION,
        {
          fields: ['name'],
          expression: [
            'name',
            // HEAD changes on checkout/commit; refs/ changes on branch create/delete/push
            // index changes on git add/reset; conflict markers indicate merge state
            ['HEAD', 'index', 'MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD'],
            'wholename',
          ],
          empty_on_fresh_instance: true,
        },
      );

      dirstateSubscription.emitter.on('change', (changes: Array<string>) => {
        const hasConflictChange = changes.some(
          c => c === 'MERGE_HEAD' || c === 'REBASE_HEAD' || c === 'CHERRY_PICK_HEAD',
        );
        const hasRepoChange = changes.some(c => c === 'HEAD' || c === 'index' || c.startsWith('refs/'));

        if (hasConflictChange) {
          handleConflictStateChange();
        }
        if (hasRepoChange) {
          handleRepositoryStateChange();
        }
      });
      dirstateSubscription.emitter.on('fresh-instance', handleRepositoryStateChange);

      this.dirstateDisposables.push(() => {
        this.logger.info('unsubscribe git dirstate watcher');
        this.watchman.unwatch(realDotdir, DIRSTATE_WATCHMAN_SUBSCRIPTION);
      });
    } catch (err) {
      this.logger.error('failed to setup dirstate subscriptions', err);
      this.tracker.error(
        'WatchmanEvent',
        'WatchmanError',
        `failed to setup watchman dirstate subscriptions ${err}`,
      );
    }
  }

  public async setupSubscriptions(ctx: RepositoryContext) {
    await this.waitForDirstateSubscriptionReady();
    await this.setupWatchmanSubscriptions();
  }

  /**
   * Watchman subscriptions for working directory file changes.
   * These activate when ISL is actually opened.
   */
  public async setupWatchmanSubscriptions() {
    const {repoRoot, dotdir} = this.repoInfo;

    if (repoRoot == null || dotdir == null) {
      this.logger.error(`skipping watchman subscription since ${repoRoot} is not a repository`);
      return;
    }

    const relativeDotdir = path.relative(repoRoot, dotdir);
    // Typically '.git', but may be deeper for worktrees
    const outerDotDir =
      relativeDotdir.indexOf(path.sep) >= 0 ? path.dirname(relativeDotdir) : relativeDotdir;

    await this.maybeModifyGitignore(repoRoot, outerDotDir);

    const FILE_CHANGE_WATCHMAN_SUBSCRIPTION = 'graphite-log-file-change';
    try {
      const handleUncommittedChanges = stagedThrottler(
        [
          {
            throttleMs: 0,
            numToNextStage: 5,
            resetAfterMs: 5_000,
            onEnter: () => {
              this.logger.info('no longer throttling uncommitted changes');
            },
          },
          {
            throttleMs: 5_000,
            numToNextStage: 10,
            resetAfterMs: 20_000,
            onEnter: () => {
              this.logger.info('slightly throttling uncommitted changes');
            },
          },
          {
            throttleMs: 30_000,
            resetAfterMs: 30_000,
            onEnter: () => {
              this.logger.info('aggressively throttling uncommitted changes');
            },
          },
        ],
        () => {
          this.changeCallback('uncommitted changes');
          this.lastFetch = new Date().valueOf();
        },
      );

      const uncommittedChangesSubscription = await this.watchman.watchDirectoryRecursive(
        repoRoot,
        FILE_CHANGE_WATCHMAN_SUBSCRIPTION,
        {
          fields: ['name'],
          expression: [
            'allof',
            ['type', 'f'],
            ['not', ['dirname', outerDotDir]],
            ['not', ['match', outerDotDir, 'basename']],
          ],
          empty_on_fresh_instance: true,
        },
      );

      uncommittedChangesSubscription.emitter.on('change', handleUncommittedChanges);
      uncommittedChangesSubscription.emitter.on('fresh-instance', handleUncommittedChanges);

      this.watchmanDisposables.push(() => {
        this.logger.info('unsubscribe watchman');
        this.watchman.unwatch(repoRoot, FILE_CHANGE_WATCHMAN_SUBSCRIPTION);
      });
    } catch (err) {
      this.logger.error('failed to setup watchman subscriptions', err);
      this.tracker.error(
        'WatchmanEvent',
        'WatchmanError',
        `failed to setup watchman subscriptions ${err}`,
      );
    }
  }

  /**
   * Add watchman cookie exclusion to .git/info/exclude so git status
   * doesn't include watchman cookie files as untracked.
   */
  private async maybeModifyGitignore(repoRoot: string, outerDotDir: string) {
    if (outerDotDir !== '.git') {
      return;
    }
    const gitIgnorePath = path.join(repoRoot, outerDotDir, 'info', 'exclude');
    const rule = '/.watchman-cookie-*';
    try {
      const gitIgnoreContent = await fs.readFile(gitIgnorePath, 'utf8');
      if (!gitIgnoreContent.includes(rule)) {
        await fs.appendFile(gitIgnorePath, `\n${rule}\n`, 'utf8');
      }
    } catch (err) {
      this.logger.error(`failed to read or write ${gitIgnorePath}`, err);
    }
  }

  public disposeWatchmanSubscriptions() {
    this.watchmanDisposables.forEach(dispose => dispose());
  }

  public dispose() {
    this.dirstateDisposables.forEach(dispose => dispose());
    this.disposeWatchmanSubscriptions();
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = undefined;
    }
  }
}
