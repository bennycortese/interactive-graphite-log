/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type {
  AbsolutePath,
  ChangedFile,
  CommitInfo,
  ConfigName,
  CwdInfo,
  DiffId,
  Disposable,
  FetchedCommits,
  FetchedUncommittedChanges,
  Hash,
  MergeConflicts,
  OperationCommandProgressReporter,
  OperationProgress,
  PageVisibility,
  RepoInfo,
  RepoRelativePath,
  Revset,
  RunnableOperation,
  SettableConfigName,
  StableInfo,
  ValidatedRepoInfo,
} from 'isl/src/types';
import type {Comparison} from 'shared/Comparison';
import type {EjecaOptions} from 'shared/ejeca';
import type {CodeReviewProvider} from './CodeReviewProvider';
import type {KindOfChange, PollKind} from './WatchForChanges';
import type {TrackEventName} from './analytics/eventNames';
import type {ConfigLevel} from './commands';
import type {RepositoryContext} from './serverTypes';

import {
  CommandRunner,
  allConfigNames,
  settableConfigNames,
} from 'isl/src/types';
import fs from 'node:fs';
import path from 'node:path';
import {revsetArgsForComparison} from 'shared/Comparison';
import {LRU} from 'shared/LRU';
import {RateLimiter} from 'shared/RateLimiter';
import {TypedEventEmitter} from 'shared/TypedEventEmitter';
import {ejeca, simplifyEjecaError} from 'shared/ejeca';
import {exists} from 'shared/fs';
import {notEmpty, nullthrows, randomId} from 'shared/utils';
import {Internal} from './Internal';
import {OperationQueue} from './OperationQueue';
import {PageFocusTracker} from './PageFocusTracker';
import {WatchForChanges} from './WatchForChanges';
import {
  MAX_SIMULTANEOUS_CAT_CALLS,
  READ_COMMAND_TIMEOUT_MS,
  extractRepoInfoFromUrl,
  findDotDir,
  findRoot,
  findRoots,
  getConfigs,
  getExecParams,
  runCommand,
  setConfig,
} from './commands';
import {ErrorShortMessages} from './constants';
import {GitHubCodeReviewProvider} from './github/githubCodeReviewProvider';
import {isGithubEnterprise} from './github/queryGraphQL';
import {
  applyDiffIds,
  attachStableLocations,
  applyGraphiteState,
  getMainFetchFormat,
  parseChangedFilesOutput,
  parseCommitInfoOutput,
  parseGraphiteState,
} from './templates';
import {
  findPublicAncestor,
  handleAbortSignalOnProcess,
  isEjecaError,
  serializeAsyncCall,
} from './utils';

/**
 * This class is responsible for providing information about the working copy
 * for a git/graphite repository.
 *
 * A Repository may be reused by multiple connections, not just one ISL window.
 * This is so we don't duplicate watchman subscriptions and calls to status/log.
 * A Repository does not have a pre-defined `cwd`, so it may be reused across cwds.
 *
 * Prefer using `RepositoryCache.getOrCreate()` to access and dispose `Repository`s.
 */
export class Repository {
  public IGNORE_COMMIT_MESSAGE_LINES_REGEX = /^#.*\n?/gm;

  private mergeConflicts: MergeConflicts | undefined = undefined;
  private uncommittedChanges: FetchedUncommittedChanges | null = null;
  private smartlogCommits: FetchedCommits | null = null;

  private mergeConflictsEmitter = new TypedEventEmitter<'change', MergeConflicts | undefined>();
  private uncommittedChangesEmitter = new TypedEventEmitter<'change', FetchedUncommittedChanges>();
  private smartlogCommitsChangesEmitter = new TypedEventEmitter<'change', FetchedCommits>();

  private smartlogCommitsBeginFetchingEmitter = new TypedEventEmitter<'start', undefined>();
  private uncommittedChangesBeginFetchingEmitter = new TypedEventEmitter<'start', undefined>();

  private disposables: Array<() => void> = [
    () => this.mergeConflictsEmitter.removeAllListeners(),
    () => this.uncommittedChangesEmitter.removeAllListeners(),
    () => this.smartlogCommitsChangesEmitter.removeAllListeners(),
    () => this.smartlogCommitsBeginFetchingEmitter.removeAllListeners(),
    () => this.uncommittedChangesBeginFetchingEmitter.removeAllListeners(),
  ];
  public onDidDispose(callback: () => unknown): void {
    this.disposables.push(callback);
  }

  private operationQueue: OperationQueue;
  private watchForChanges: WatchForChanges;
  private pageFocusTracker = new PageFocusTracker();
  public codeReviewProvider?: CodeReviewProvider;

  /**
   * Config: milliseconds to hold off log/status refresh during the start of a command.
   * This is to avoid showing messy indeterminate states (like millions of files changed
   * during a long distance checkout, or commit graph changed but '.' is out of sync).
   *
   * Default: 10 seconds. Can be set by the `isl.hold-off-refresh-ms` setting.
   */
  public configHoldOffRefreshMs = 10000;

  private configRateLimiter = new RateLimiter(1);

  private currentVisibleCommitRangeIndex = 0;
  private visibleCommitRanges: Array<number | undefined> = [14, 60, undefined];

  /**
   * Additional commits to include in batched `log` fetch,
   * used for additional remote bookmarks / known stable commit hashes.
   * After fetching commits, stable names will be added to commits in "stableCommitMetadata"
   */
  public stableLocations: Array<StableInfo> = [];

  /**
   * The context used when the repository was created.
   * This is needed for subscriptions to have access to ANY logger, etc.
   * Avoid using this, and prefer using the correct context for a given connection.
   */
  public initialConnectionContext: RepositoryContext;

  public fullRepoBranchModule = Internal.RepositoryFullRepoBranchModule?.create(
    this,
    this.smartlogCommitsChangesEmitter,
  );

  /**  Prefer using `RepositoryCache.getOrCreate()` to access and dispose `Repository`s. */
  constructor(
    public info: ValidatedRepoInfo,
    ctx: RepositoryContext,
  ) {
    this.initialConnectionContext = ctx;

    const remote = info.codeReviewSystem;
    if (remote.type === 'github') {
      this.codeReviewProvider = new GitHubCodeReviewProvider(remote, ctx.logger);
    }

    const shouldWait = (): boolean => {
      const startTime = this.operationQueue.getRunningOperationStartTime();
      if (startTime == null) {
        return false;
      }
      // Prevent auto-refresh during the first 10 seconds of a running command.
      // When a command is running, the intermediate state can be messy:
      // - status errors out (edenfs), is noisy (long distance goto)
      // - commit graph and the `.` are updated separately and hard to predict
      // Let's just rely on optimistic state to provide the "clean" outcome.
      // In case the command takes a long time to run, allow refresh after
      // the time period.
      // Fundamentally, the intermediate states have no choice but have to
      // be messy because filesystems are not transactional (and reading in
      // `sl` is designed to be lock-free).
      const elapsedMs = Date.now() - startTime.valueOf();
      const result = elapsedMs < this.configHoldOffRefreshMs;
      return result;
    };
    const callback = (kind: KindOfChange, pollKind?: PollKind) => {
      if (pollKind !== 'force' && shouldWait()) {
        // Do nothing. This is fine because after the operation
        // there will be a refresh.
        ctx.logger.info('polling prevented from shouldWait');
        return;
      }
      if (kind === 'uncommitted changes') {
        this.fetchUncommittedChanges();
      } else if (kind === 'commits') {
        this.fetchSmartlogCommits();
      } else if (kind === 'merge conflicts') {
        this.checkForMergeConflicts();
      } else if (kind === 'everything') {
        this.fetchUncommittedChanges();
        this.fetchSmartlogCommits();
        this.checkForMergeConflicts();

        this.codeReviewProvider?.triggerDiffSummariesFetch(
          // We could choose to only fetch the diffs that changed (`newDiffs`) rather than all diffs,
          // but our UI doesn't cache old values, thus all other diffs would appear empty
          this.getAllDiffIds(),
        );
        this.initialConnectionContext.tracker.track('DiffFetchSource', {
          extras: {source: 'watch_for_changes', kind, pollKind},
        });
      }
    };
    this.watchForChanges = new WatchForChanges(info, this.pageFocusTracker, callback, ctx);

    this.operationQueue = new OperationQueue(
      (
        ctx: RepositoryContext,
        operation: RunnableOperation,
        handleCommandProgress,
        signal: AbortSignal,
      ): Promise<unknown> => {
        const {cwd} = ctx;
        if (operation.runner === CommandRunner.Git || operation.runner === CommandRunner.Graphite) {
          return this.runOperation(ctx, operation, handleCommandProgress, signal);
        } else if (operation.runner === CommandRunner.CodeReviewProvider) {
          if (this.codeReviewProvider?.runExternalCommand == null) {
            return Promise.reject(
              Error('CodeReviewProvider does not support running external commands'),
            );
          }

          return (
            this.codeReviewProvider?.runExternalCommand(
              cwd,
              operation.args,
              handleCommandProgress,
              signal,
            ) ?? Promise.resolve()
          );
        }
        return Promise.resolve();
      },
    );

    // refetch summaries whenever we see new diffIds
    const seenDiffs = new Set();
    const subscription = this.subscribeToSmartlogCommitsChanges(fetched => {
      if (fetched.commits.value) {
        const newDiffs = [];
        const diffIds = fetched.commits.value
          .filter(commit => commit.diffId != null)
          .map(commit => commit.diffId);
        for (const diffId of diffIds) {
          if (!seenDiffs.has(diffId)) {
            newDiffs.push(diffId);
            seenDiffs.add(diffId);
          }
        }
        if (newDiffs.length > 0) {
          this.codeReviewProvider?.triggerDiffSummariesFetch(
            // We could choose to only fetch the diffs that changed (`newDiffs`) rather than all diffs,
            // but our UI doesn't cache old values, thus all other diffs would appear empty
            this.getAllDiffIds(),
          );
          this.initialConnectionContext.tracker.track('DiffFetchSource', {
            extras: {source: 'saw_new_diffs'},
          });
        }
      }
    });

    // the repo may already be in a conflict state on startup
    this.checkForMergeConflicts();

    this.disposables.push(() => subscription.dispose());

    // When PR summaries arrive (possibly after initial commit fetch),
    // apply diffIds to cached commits so PR badges appear without a refetch
    if (this.codeReviewProvider) {
      const diffSub = this.codeReviewProvider.onChangeDiffSummaries(result => {
        if (result.value && this.smartlogCommits?.commits.value) {
          const branchToDiffId = this.codeReviewProvider?.getBranchToDiffIdMap?.();
          if (branchToDiffId && branchToDiffId.size > 0) {
            const commits = this.smartlogCommits.commits.value;
            const previousDiffIds = commits.map(c => c.diffId);
            applyDiffIds(commits, branchToDiffId);
            const changed = commits.some((c, i) => c.diffId !== previousDiffIds[i]);
            if (changed) {
              this.smartlogCommitsChangesEmitter.emit('change', this.smartlogCommits);
            }
          }
        }
      });
      this.disposables.push(() => diffSub.dispose());
    }

    this.applyConfigInBackground(ctx);

    const headTracker = this.subscribeToHeadCommit(head => {
      const allCommits = this.getSmartlogCommits();
      const ancestor = findPublicAncestor(allCommits?.commits.value, head);
      this.initialConnectionContext.tracker.track('HeadCommitChanged', {
        extras: {
          hash: head.hash,
          public: ancestor?.hash,
          bookmarks: ancestor?.remoteBookmarks,
        },
      });
    });
    this.disposables.push(headTracker.dispose);

    if (this.fullRepoBranchModule != null) {
      this.disposables.push(() => this.fullRepoBranchModule?.dispose());
    }
  }

  public nextVisibleCommitRangeInDays(): number | undefined {
    if (this.currentVisibleCommitRangeIndex + 1 < this.visibleCommitRanges.length) {
      this.currentVisibleCommitRangeIndex++;
    }
    return this.visibleCommitRanges[this.currentVisibleCommitRangeIndex];
  }

  public isPathInsideRepo(p: AbsolutePath): boolean {
    return path.normalize(p).startsWith(this.info.repoRoot);
  }

  /**
   * Typically, disposing is handled by `RepositoryCache` and not used directly.
   */
  public dispose() {
    this.disposables.forEach(dispose => dispose());
    this.codeReviewProvider?.dispose();
    this.watchForChanges.dispose();
  }

  public onChangeConflictState(
    callback: (conflicts: MergeConflicts | undefined) => unknown,
  ): Disposable {
    this.mergeConflictsEmitter.on('change', callback);

    if (this.mergeConflicts) {
      // if we're already in merge conflicts, let the client know right away
      callback(this.mergeConflicts);
    }

    return {dispose: () => this.mergeConflictsEmitter.off('change', callback)};
  }

  public checkForMergeConflicts = serializeAsyncCall(async () => {
    this.initialConnectionContext.logger.info('checking for merge conflicts');
    const wasAlreadyInConflicts = this.mergeConflicts != null;

    // Check if we're in a conflict state by looking for MERGE_HEAD, REBASE_HEAD, or CHERRY_PICK_HEAD
    const conflictIndicators = ['MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD'];
    let inConflictState = false;
    let conflictCommand = '';
    for (const indicator of conflictIndicators) {
      if (await exists(path.join(this.info.dotdir, indicator))) {
        inConflictState = true;
        conflictCommand = indicator.replace('_HEAD', '').toLowerCase();
        break;
      }
    }

    if (!inConflictState) {
      if (wasAlreadyInConflicts) {
        this.mergeConflicts = undefined;
        this.mergeConflictsEmitter.emit('change', this.mergeConflicts);
        this.initialConnectionContext.tracker.track('ExitMergeConflicts', {extras: {}});
      }
      return;
    }

    if (this.mergeConflicts == null) {
      this.mergeConflicts = {state: 'loading'};
      this.mergeConflictsEmitter.emit('change', this.mergeConflicts);
    }

    const fetchStartTimestamp = Date.now();
    try {
      // Use git status --porcelain to find unmerged files (UU, AA, DD, etc.)
      const proc = await this.runCommand(
        ['status', '--porcelain=v1'],
        'GetConflictsCommand',
        this.initialConnectionContext,
      );
      const conflictFiles = proc.stdout
        .split('\n')
        .filter(line => line.length >= 2 && (line.startsWith('UU') || line.startsWith('AA') || line.startsWith('DD') || line.startsWith('AU') || line.startsWith('UA') || line.startsWith('DU') || line.startsWith('UD')))
        .map(line => ({
          path: line.slice(3).trim(),
          status: 'U' as const,
          conflictType: 'both_changed' as const,
        }));

      if (conflictFiles.length === 0) {
        this.mergeConflicts = undefined;
      } else {
        this.mergeConflicts = {
          state: 'loaded',
          command: conflictCommand,
          toContinue: `git ${conflictCommand} --continue`,
          toAbort: `git ${conflictCommand} --abort`,
          files: conflictFiles,
          fetchStartTimestamp,
          fetchCompletedTimestamp: Date.now(),
        };
      }
    } catch (err) {
      this.initialConnectionContext.logger.error(`failed to check for merge conflicts: ${err}`);
      this.mergeConflicts = undefined;
    }

    this.initialConnectionContext.logger.info(
      `repo ${this.mergeConflicts ? 'IS' : 'IS NOT'} in merge conflicts`,
    );
    this.mergeConflictsEmitter.emit('change', this.mergeConflicts);

    if (!wasAlreadyInConflicts && this.mergeConflicts) {
      this.initialConnectionContext.tracker.track('EnterMergeConflicts', {
        extras: {numConflicts: this.mergeConflicts.files?.length ?? 0},
      });
    }
  });

  public getMergeConflicts(): MergeConflicts | undefined {
    return this.mergeConflicts;
  }

  // getMergeTool removed - not needed for git/graphite

  /**
   * Determine basic repo info including the root and important config values.
   * Resulting RepoInfo may have null fields if cwd is not a valid repo root.
   * Throws if `command` is not found.
   */
  static async getRepoInfo(ctx: RepositoryContext): Promise<RepoInfo> {
    const {cmd, cwd, logger} = ctx;
    const [repoRoot, repoRoots, dotdir, configs] = await Promise.all([
      findRoot(ctx).catch((err: Error) => err),
      findRoots(ctx),
      findDotDir(ctx),
      getConfigs(ctx, [
        'remote.origin.url',
      ]),
    ]);
    const remoteUrl = configs.get('remote.origin.url') ?? '';

    if (repoRoot instanceof Error) {
      const cwdExists = await exists(cwd);
      if (!cwdExists) {
        return {type: 'cwdDoesNotExist', cwd};
      }

      return {
        type: 'invalidCommand',
        command: cmd,
        path: process.env.PATH,
      };
    }
    if (repoRoot == null || dotdir == null) {
      return {type: 'cwdNotARepository', cwd};
    }

    let codeReviewSystem: ValidatedRepoInfo['codeReviewSystem'];
    let pullRequestDomain;
    if (remoteUrl === '') {
      codeReviewSystem = {type: 'none'};
    } else {
      const repoInfo = extractRepoInfoFromUrl(remoteUrl);
      if (
        repoInfo != null &&
        (repoInfo.hostname === 'github.com' || (await isGithubEnterprise(repoInfo.hostname)))
      ) {
        const {owner, repo, hostname} = repoInfo;
        codeReviewSystem = {
          type: 'github',
          owner,
          repo,
          hostname,
        };
      } else {
        codeReviewSystem = {type: 'unknown', path: remoteUrl};
      }
    }

    const result: RepoInfo = {
      type: 'success',
      command: cmd,
      dotdir,
      repoRoot,
      repoRoots,
      codeReviewSystem,
      pullRequestDomain,
      preferredSubmitCommand: 'submit' as ValidatedRepoInfo['preferredSubmitCommand'],
    };
    logger.info('repo info: ', result);
    return result;
  }

  /**
   * Determine basic information about a cwd, without fetching the full RepositoryInfo.
   * Useful to determine if a cwd is valid and find the repo root without constructing a Repository.
   */
  static async getCwdInfo(ctx: RepositoryContext): Promise<CwdInfo> {
    const root = await findRoot(ctx).catch((err: Error) => err);

    if (root instanceof Error || root == null) {
      return {cwd: ctx.cwd};
    }

    const [realCwd, realRoot] = await Promise.all([
      fs.promises.realpath(ctx.cwd),
      fs.promises.realpath(root),
    ]);
    // Since we found `root` for this particular `cwd`, we expect realpath(root) is a prefix of realpath(cwd).
    // That is, the relative path does not contain any ".." components.
    const repoRelativeCwd = path.relative(realRoot, realCwd);
    return {
      cwd: ctx.cwd,
      repoRoot: realRoot,
      repoRelativeCwdLabel: path.normalize(path.join(path.basename(realRoot), repoRelativeCwd)),
    };
  }

  /**
   * Run long-lived command which mutates the repository state.
   * Progress is streamed back as it comes in.
   * Operations are run immediately. For queueing, see OperationQueue.
   * This promise resolves when the operation exits.
   */
  async runOrQueueOperation(
    ctx: RepositoryContext,
    operation: RunnableOperation,
    onProgress: (progress: OperationProgress) => void,
  ): Promise<void> {
    const result = await this.operationQueue.runOrQueueOperation(ctx, operation, onProgress);

    if (result !== 'skipped') {
      // After any operation finishes, make sure we poll right away,
      // so the UI is guaranteed to get the latest data.
      this.watchForChanges.poll('force');
    }
  }

  /**
   * Abort the running operation if it matches the given id.
   */
  abortRunningOperation(operationId: string) {
    this.operationQueue.abortRunningOperation(operationId);
  }

  /** The currently running operation tracked by the server. */
  getRunningOperation() {
    return this.operationQueue.getRunningOperation();
  }

  private normalizeOperationArgs(
    cwd: string,
    operation: RunnableOperation,
  ): {args: Array<string>; stdin?: string | undefined} {
    const repoRoot = nullthrows(this.info.repoRoot);
    let stdin = operation.stdin;
    const args = [];
    for (const arg of operation.args) {
      if (typeof arg === 'object') {
        switch (arg.type) {
          case 'config':
            // Git uses -c key=value for config overrides
            if (!(settableConfigNames as ReadonlyArray<string>).includes(arg.key)) {
              throw new Error(`config ${arg.key} not allowed`);
            }
            args.push('-c', `${arg.key}=${arg.value}`);
            continue;
          case 'repo-relative-file':
            args.push(path.normalize(path.relative(cwd, path.join(repoRoot, arg.path))));
            continue;
          case 'repo-relative-file-list':
            // For git, pass files via --pathspec-from-file=- (stdin)
            args.push('--pathspec-from-file=-');
            if (stdin != null) {
              throw new Error('stdin already set when using repo-relative-file-list');
            }
            stdin = arg.paths
              .map(p => path.normalize(path.relative(cwd, path.join(repoRoot, p))))
              .join('\n');
            continue;
          case 'exact-revset':
            if (arg.revset.startsWith('-')) {
              throw new Error('invalid revset');
            }
            // In git, just pass the hash/ref directly
            args.push(arg.revset);
            continue;
          case 'succeedable-revset':
            // Git has no successor tracking; just use the hash directly
            args.push(arg.revset);
            continue;
          case 'optimistic-revset':
            // Git has no successor tracking; just use the hash directly
            args.push(arg.revset);
            continue;
        }
      }
      args.push(arg);
    }
    return {args, stdin};
  }

  /**
   * Called by this.operationQueue in response to runOrQueueOperation when an operation is ready to actually run.
   */
  private async runOperation(
    ctx: RepositoryContext,
    operation: RunnableOperation,
    onProgress: OperationCommandProgressReporter,
    signal: AbortSignal,
  ): Promise<void> {
    const {cwd} = ctx;
    const {args: cwdRelativeArgs, stdin} = this.normalizeOperationArgs(cwd, operation);

    const additionalEnv = await Internal.additionalEnvForCommand?.(operation);

    const fullArgs = [...cwdRelativeArgs];
    // For Graphite operations, use 'gt' command; otherwise use git
    const cmdToUse = operation.runner === CommandRunner.Graphite ? 'gt' : this.info.command;
    const {command, args, options} = getExecParams(
      cmdToUse,
      fullArgs,
      cwd,
      stdin ? {input: stdin} : {},
      additionalEnv ?? {},
    );

    ctx.logger.log('run operation: ', command, fullArgs.join(' '));

    const execution = ejeca(command, args, options);
    onProgress('spawn');
    execution.stdout?.on('data', data => {
      onProgress('stdout', data.toString());
    });
    execution.stderr?.on('data', data => {
      onProgress('stderr', data.toString());
    });
    signal.addEventListener('abort', () => {
      ctx.logger.log('kill operation: ', command, fullArgs.join(' '));
    });
    handleAbortSignalOnProcess(execution, signal);
    try {
      const result = await execution;
      onProgress('exit', result.exitCode || 0);
    } catch (err) {
      onProgress('exit', isEjecaError(err) ? err.exitCode : -1);
      throw err;
    }
  }

  // getMergeToolEnvVars removed - not needed for git/graphite

  setPageFocus(page: string, state: PageVisibility) {
    this.pageFocusTracker.setState(page, state);
    this.initialConnectionContext.tracker.track('FocusChanged', {extras: {state}});
  }

  private refcount = 0;
  ref() {
    this.refcount++;
    if (this.refcount === 1) {
      this.watchForChanges.setupSubscriptions(this.initialConnectionContext);
    }
  }
  unref() {
    this.refcount--;
    if (this.refcount === 0) {
      this.watchForChanges.disposeWatchmanSubscriptions();
    }
  }

  /** Return the latest fetched value for UncommittedChanges. */
  getUncommittedChanges(): FetchedUncommittedChanges | null {
    return this.uncommittedChanges;
  }

  subscribeToUncommittedChanges(
    callback: (result: FetchedUncommittedChanges) => unknown,
  ): Disposable {
    this.uncommittedChangesEmitter.on('change', callback);
    return {
      dispose: () => {
        this.uncommittedChangesEmitter.off('change', callback);
      },
    };
  }

  fetchUncommittedChanges = serializeAsyncCall(async () => {
    const fetchStartTimestamp = Date.now();
    try {
      this.uncommittedChangesBeginFetchingEmitter.emit('start');
      const proc = await this.runCommand(
        ['status', '--porcelain=v1'],
        'StatusCommand',
        this.initialConnectionContext,
      );
      const files: Array<ChangedFile> = proc.stdout
        .split('\n')
        .filter((line: string) => line.length >= 2)
        .map((line: string) => {
          const statusCode = line.substring(0, 2).trim();
          const filePath = line.substring(3);
          let status: ChangedFile['status'];
          if (statusCode === '??') {
            status = '?';
          } else if (statusCode === 'M' || statusCode === 'MM' || statusCode === 'AM') {
            status = 'M';
          } else if (statusCode === 'A') {
            status = 'A';
          } else if (statusCode === 'D') {
            status = 'R'; // 'R' = removed in ISL's type system
          } else if (statusCode === 'R') {
            status = 'A'; // renamed = new file
          } else if (statusCode === 'UU' || statusCode === 'AA' || statusCode === 'DD') {
            status = 'U'; // unmerged
          } else if (statusCode === '!') {
            status = '!';
          } else {
            status = 'M'; // fallback
          }
          return {path: filePath, status};
        });

      this.uncommittedChanges = {
        fetchStartTimestamp,
        fetchCompletedTimestamp: Date.now(),
        files: {value: files},
      };
      this.uncommittedChangesEmitter.emit('change', this.uncommittedChanges);
    } catch (err) {
      let error = err;
      this.initialConnectionContext.logger.error('Error fetching files: ', error);
      if (isEjecaError(error)) {
        error = simplifyEjecaError(error);
      }

      this.uncommittedChangesEmitter.emit('change', {
        fetchStartTimestamp,
        fetchCompletedTimestamp: Date.now(),
        files: {error: error instanceof Error ? error : new Error(error as string)},
      });
    }
  });

  /** Return the latest fetched value for SmartlogCommits. */
  getSmartlogCommits(): FetchedCommits | null {
    return this.smartlogCommits;
  }

  subscribeToSmartlogCommitsChanges(callback: (result: FetchedCommits) => unknown) {
    this.smartlogCommitsChangesEmitter.on('change', callback);
    return {
      dispose: () => {
        this.smartlogCommitsChangesEmitter.off('change', callback);
      },
    };
  }

  subscribeToSmartlogCommitsBeginFetching(callback: (isFetching: boolean) => unknown) {
    const onStart = () => callback(true);
    this.smartlogCommitsBeginFetchingEmitter.on('start', onStart);
    return {
      dispose: () => {
        this.smartlogCommitsBeginFetchingEmitter.off('start', onStart);
      },
    };
  }

  subscribeToUncommittedChangesBeginFetching(callback: (isFetching: boolean) => unknown) {
    const onStart = () => callback(true);
    this.uncommittedChangesBeginFetchingEmitter.on('start', onStart);
    return {
      dispose: () => {
        this.uncommittedChangesBeginFetchingEmitter.off('start', onStart);
      },
    };
  }

  fetchSmartlogCommits = serializeAsyncCall(async () => {
    const fetchStartTimestamp = Date.now();
    try {
      this.smartlogCommitsBeginFetchingEmitter.emit('start');

      const format = getMainFetchFormat();

      // Get current HEAD hash for isDot detection
      const headProc = await this.runCommand(
        ['rev-parse', 'HEAD'],
        undefined,
        this.initialConnectionContext,
      );
      const headHash = headProc.stdout.trim();

      // Get public ancestor hashes (commits reachable from remote tracking branches)
      let publicAncestors: Set<string> | undefined;
      try {
        const publicProc = await this.runCommand(
          ['log', '--format=%H', '--remotes', '--max-count=200'],
          undefined,
          this.initialConnectionContext,
        );
        publicAncestors = new Set(
          publicProc.stdout.trim().split('\n').filter((h: string) => h.length > 0),
        );
      } catch {
        // If no remote commits, that's fine
        publicAncestors = new Set();
      }

      // Fetch commits: all local branches + remote tracking branches, limited
      const proc = await this.runCommand(
        ['log', `--format=${format}`, '--branches', '--remotes', '--topo-order', '--max-count=200'],
        'LogCommand',
        this.initialConnectionContext,
      );
      const commits = parseCommitInfoOutput(
        this.initialConnectionContext.logger,
        proc.stdout.trim(),
        this.info.codeReviewSystem,
        headHash,
        publicAncestors,
      );
      if (commits.length === 0) {
        throw new Error(ErrorShortMessages.NoCommitsFetched);
      }
      attachStableLocations(commits, this.stableLocations);

      // Augment with Graphite metadata (needs_restack badges, etc.)
      try {
        const gtProc = await runCommand(
          {...this.initialConnectionContext, cmd: 'gt'},
          ['state'],
          {},
          5000,
          false,
        );
        const graphiteState = parseGraphiteState(gtProc.stdout);
        applyGraphiteState(commits, graphiteState);
      } catch {
        // gt not available or not a Graphite repo — continue with git-only data
      }

      // Match commits to PRs by branch name to enable PR status badges
      const branchToDiffId = this.codeReviewProvider?.getBranchToDiffIdMap?.();
      if (branchToDiffId && branchToDiffId.size > 0) {
        applyDiffIds(commits, branchToDiffId);
      }

      this.smartlogCommits = {
        fetchStartTimestamp,
        fetchCompletedTimestamp: Date.now(),
        commits: {value: commits},
      };
      this.smartlogCommitsChangesEmitter.emit('change', this.smartlogCommits);
    } catch (err) {
      let error = err;
      this.initialConnectionContext.logger.error('Error fetching commits: ', error);
      if (isEjecaError(error)) {
        error = simplifyEjecaError(error);
      }

      this.smartlogCommitsChangesEmitter.emit('change', {
        fetchStartTimestamp,
        fetchCompletedTimestamp: Date.now(),
        commits: {error: error instanceof Error ? error : new Error(error as string)},
      });
    }
  });

  /** Get the current head commit if loaded */
  getHeadCommit(): CommitInfo | undefined {
    return this.smartlogCommits?.commits.value?.find(commit => commit.isDot);
  }

  /** Watch for changes to the head commit, e.g. from checking out a new commit */
  subscribeToHeadCommit(callback: (head: CommitInfo) => unknown) {
    let headCommit = this.getHeadCommit();
    if (headCommit != null) {
      callback(headCommit);
    }
    const onData = (data: FetchedCommits) => {
      const newHead = data?.commits.value?.find(commit => commit.isDot);
      if (newHead != null && newHead.hash !== headCommit?.hash) {
        callback(newHead);
        headCommit = newHead;
      }
    };
    this.smartlogCommitsChangesEmitter.on('change', onData);
    return {
      dispose: () => {
        this.smartlogCommitsChangesEmitter.off('change', onData);
      },
    };
  }

  private catLimiter = new RateLimiter(MAX_SIMULTANEOUS_CAT_CALLS, s =>
    this.initialConnectionContext.logger.info('[cat]', s),
  );
  /** Return file content at a given revset, e.g. hash or HEAD */
  public cat(ctx: RepositoryContext, file: AbsolutePath, rev: Revset): Promise<string> {
    return this.catLimiter.enqueueRun(async () => {
      const options = {stripFinalNewline: false};
      return (await this.runCommand(['show', `${rev}:${file}`], 'CatCommand', ctx, options))
        .stdout;
    });
  }

  private commitCache = new LRU<string, CommitInfo>(100);
  public async lookupCommits(
    ctx: RepositoryContext,
    hashes: Array<string>,
  ): Promise<Map<string, CommitInfo>> {
    const hashesToFetch = hashes.filter(hash => this.commitCache.get(hash) == undefined);

    // Get HEAD hash for isDot detection
    let headHash = '';
    try {
      headHash = (await this.runCommand(['rev-parse', 'HEAD'], undefined, ctx)).stdout.trim();
    } catch {
      // ignore
    }

    const format = getMainFetchFormat();
    const commits =
      hashesToFetch.length === 0
        ? []
        : await this.runCommand(
            [
              'log',
              `--format=${format}`,
              '--no-walk',
              ...hashesToFetch,
            ],
            'LookupCommitsCommand',
            ctx,
          ).then(output => {
            return parseCommitInfoOutput(
              ctx.logger,
              output.stdout.trim(),
              this.info.codeReviewSystem,
              headHash,
            );
          });

    const result = new Map();
    for (const hash of hashes) {
      const found = this.commitCache.get(hash);
      if (found != undefined) {
        result.set(hash, found);
      }
    }

    for (const commit of commits) {
      if (commit) {
        this.commitCache.set(commit.hash, commit);
        result.set(commit.hash, commit);
      }
    }

    return result;
  }

  public async getAllChangedFiles(ctx: RepositoryContext, hash: Hash): Promise<Array<ChangedFile>> {
    const output = (
      await this.runCommand(
        ['diff-tree', '--no-commit-id', '--name-status', '-r', '-M', hash],
        undefined,
        ctx,
      )
    ).stdout;

    const {filesSample} = parseChangedFilesOutput(output);
    return filesSample;
  }

  // getShelvedChanges removed - shelve is Sapling-specific, deferred for MVP

  public getAllDiffIds(): Array<DiffId> {
    return (
      this.getSmartlogCommits()
        ?.commits.value?.map(commit => commit.diffId)
        .filter(notEmpty) ?? []
    );
  }

  public async runDiff(
    ctx: RepositoryContext,
    comparison: Comparison,
    contextLines = 4,
  ): Promise<string> {
    const output = await this.runCommand(
      [
        'diff',
        ...revsetArgsForComparison(comparison),
        '--no-prefix',
        '--no-color',
        `--unified=${contextLines}`,
      ],
      'DiffCommand',
      ctx,
    );
    return output.stdout;
  }

  public runCommand(
    args: Array<string>,
    /** Which event name to track for this command. If undefined, generic 'RunCommand' is used. */
    eventName: TrackEventName | undefined,
    ctx: RepositoryContext,
    options?: EjecaOptions,
    timeout?: number,
  ) {
    const id = randomId();
    return ctx.tracker.operation(
      eventName ?? 'RunCommand',
      'RunCommandError',
      {
        // if we don't specify a specific eventName, provide the command arguments in logging
        extras: eventName == null ? {args} : undefined,
        operationId: `isl:${id}`,
      },
      async () =>
        runCommand(
          ctx,
          args,
          {
            ...options,
            env: {
              ...options?.env,
              ...((await Internal.additionalEnvForCommand?.(id)) ?? {}),
            } as NodeJS.ProcessEnv,
          },
          timeout ?? READ_COMMAND_TIMEOUT_MS,
        ),
    );
  }

  /** Read a config. The config name must be part of `allConfigNames`. */
  public async getConfig(
    ctx: RepositoryContext,
    configName: ConfigName,
  ): Promise<string | undefined> {
    return (await this.getKnownConfigs(ctx)).get(configName);
  }

  /**
   * Read a single config, forcing a new dedicated call to `sl config`.
   * Prefer `getConfig` to batch fetches when possible.
   */
  public async forceGetConfig(
    ctx: RepositoryContext,
    configName: string,
  ): Promise<string | undefined> {
    const result = (await runCommand(ctx, ['config', configName])).stdout;
    this.initialConnectionContext.logger.info(
      `loaded configs from ${ctx.cwd}: ${configName} => ${result}`,
    );
    return result;
  }

  /** Load all "known" configs. Cached on `this`. */
  public getKnownConfigs(
    ctx: RepositoryContext,
  ): Promise<ReadonlyMap<ConfigName, string | undefined>> {
    if (ctx.knownConfigs != null) {
      return Promise.resolve(ctx.knownConfigs);
    }
    return this.configRateLimiter.enqueueRun(async () => {
      if (ctx.knownConfigs == null) {
        // Fetch all configs using one command.
        const knownConfig = new Map<ConfigName, string>(
          await getConfigs<ConfigName>(ctx, allConfigNames),
        );
        ctx.knownConfigs = knownConfig;
      }
      return ctx.knownConfigs;
    });
  }

  public setConfig(
    ctx: RepositoryContext,
    level: ConfigLevel,
    configName: SettableConfigName,
    configValue: string,
  ): Promise<void> {
    if (!settableConfigNames.includes(configName)) {
      return Promise.reject(
        new Error(`config ${configName} not in allowlist for settable configs`),
      );
    }
    // Attempt to avoid racy config read/write.
    return this.configRateLimiter.enqueueRun(() => setConfig(ctx, level, configName, configValue));
  }

  /** Load and apply configs to `this` in background. */
  private applyConfigInBackground(ctx: RepositoryContext) {
    this.getConfig(ctx, 'isl.hold-off-refresh-ms').then(configValue => {
      if (configValue != null) {
        const numberValue = parseInt(configValue, 10);
        if (numberValue >= 0) {
          this.configHoldOffRefreshMs = numberValue;
        }
      }
    });
  }
}

export function repoRelativePathForAbsolutePath(
  absolutePath: AbsolutePath,
  repo: Repository,
  pathMod = path,
): RepoRelativePath {
  return pathMod.relative(repo.info.repoRoot, absolutePath);
}

/**
 * Returns absolute path for a repo-relative file path.
 * If the path "escapes" the repository's root dir, returns null
 * Used to validate that a file path does not "escape" the repo, and the file can safely be modified on the filesystem.
 * absolutePathForFileInRepo("foo/bar/file.txt", repo) -> /path/to/repo/foo/bar/file.txt
 * absolutePathForFileInRepo("../file.txt", repo) -> null
 */
export function absolutePathForFileInRepo(
  filePath: RepoRelativePath,
  repo: Repository,
  pathMod = path,
): AbsolutePath | null {
  // Note that resolve() is contractually obligated to return an absolute path.
  const fullPath = pathMod.resolve(repo.info.repoRoot, filePath);
  // Prefix checks on paths can be footguns on Windows for C:\\ vs c:\\, but since
  // we use the same exact path check here and in the resolve, there should be
  // no incompatibility here.
  if (fullPath.startsWith(repo.info.repoRoot + pathMod.sep)) {
    return fullPath;
  } else {
    return null;
  }
}

