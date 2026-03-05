/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type {CommitInfo, ExactRevset, OptimisticRevset, SucceedableRevset} from './types';

import {commandRunnerMode} from './atoms/CommandRunnerModeState';
import {readAtom} from './jotaiUtils';
import {AmendToOperation} from './operations/AmendToOperation';
import {GraphiteAbsorbOperation} from './operations/GraphiteAbsorbOperation';
import {GraphiteMoveOperation} from './operations/GraphiteMoveOperation';
import {RebaseOperation} from './operations/RebaseOperation';
import {uncommittedSelection} from './partialSelection';
import {dagWithPreviews, uncommittedChangesWithPreviews} from './previews';
import {latestSuccessorUnlessExplicitlyObsolete} from './successionUtils';

/**
 * Amend --to allows amending to a parent commit other than head.
 * Only allowed on a commit that is a parent of head, and when
 * your current selection is not a partial selection.
 */
export function isAmendToAllowedForCommit(commit: CommitInfo): boolean {
  if (commit.isDot || commit.phase === 'public' || commit.successorInfo != null) {
    // no point, just amend normally
    return false;
  }

  const uncommittedChanges = readAtom(uncommittedChangesWithPreviews);
  if (uncommittedChanges == null || uncommittedChanges.length === 0) {
    // nothing to amend
    return false;
  }

  // amend --to doesn't handle partial chunk selections, only entire files
  const selection = readAtom(uncommittedSelection);
  const hasPartialSelection = selection.hasChunkSelection();

  if (hasPartialSelection) {
    return false;
  }

  const dag = readAtom(dagWithPreviews);
  const head = dag?.resolve('.');
  if (dag == null || head == null || !dag.has(commit.hash)) {
    return false;
  }

  return dag.isAncestor(commit.hash, head.hash);
}

/**
 * Extract the Graphite branch name from a commit's local bookmarks.
 * Returns undefined if the commit has no local branch (not Graphite-tracked).
 */
export function getGraphiteBranchName(commit: CommitInfo): string | undefined {
  return commit.bookmarks[0];
}

/**
 * Extract the destination branch name for `gt move --onto`.
 * Prefers remote bookmark names (stripped of `origin/` prefix) for trunk,
 * falls back to local branch name.
 */
export function getDestBranchName(commit: CommitInfo): string | undefined {
  if (commit.remoteBookmarks.length > 0) {
    return commit.remoteBookmarks[0].replace(/^origin\//, '');
  }
  return commit.bookmarks[0];
}

/**
 * Mode-aware factory for rebase operations.
 * In graphite mode, uses `gt move` when both source and destination
 * have Graphite branch names. Falls back to `git rebase` otherwise.
 */
export function getRebaseOperation(
  source: SucceedableRevset | ExactRevset | OptimisticRevset,
  destination: SucceedableRevset | ExactRevset | OptimisticRevset,
  sourceCommit?: CommitInfo,
  destCommit?: CommitInfo,
): RebaseOperation {
  const runnerMode = readAtom(commandRunnerMode);
  if (runnerMode === 'graphite' && sourceCommit && destCommit) {
    const srcBranch = getGraphiteBranchName(sourceCommit);
    const dstBranch = getDestBranchName(destCommit);
    if (srcBranch && dstBranch) {
      return new GraphiteMoveOperation(source, destination, srcBranch, dstBranch);
    }
  }
  return new RebaseOperation(source, destination);
}

export function getAmendToOperation(commit: CommitInfo): AmendToOperation {
  const selection = readAtom(uncommittedSelection);
  const uncommittedChanges = readAtom(uncommittedChangesWithPreviews);

  const paths = uncommittedChanges
    .filter(change => selection.isFullySelected(change.path))
    .map(change => change.path);
  const revset = latestSuccessorUnlessExplicitlyObsolete(commit);
  const runnerMode = readAtom(commandRunnerMode);
  if (runnerMode === 'graphite') {
    return new GraphiteAbsorbOperation(revset, paths);
  }
  return new AmendToOperation(revset, paths);
}
