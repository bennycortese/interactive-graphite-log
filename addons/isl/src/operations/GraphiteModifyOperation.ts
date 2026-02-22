/**
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type {CommitInfo, RepoRelativePath} from '../types';
import type {PartialSelection} from '../partialSelection';

import {readAtom} from '../jotaiUtils';
import {authorString} from '../serverAPIState';
import {CommandRunner} from '../types';
import {AmendOperation, PartialAmendOperation} from './AmendOperation';

/**
 * Amend the current commit using `gt modify`, preserving Graphite stack metadata.
 *
 * Runs `gt modify --all --no-interactive` (or with `--message` if message is provided).
 *
 * This is the recommended way to amend in Graphite mode because `gt modify`:
 * 1. Amends the current commit (like `git commit --amend`)
 * 2. Automatically restacks dependent branches in the stack
 * 3. Preserves Graphite's branch tracking metadata
 *
 * Without this, using raw `git commit --amend` can desync Graphite's tracked state,
 * requiring a manual `gt restack` to fix dependent branches.
 *
 * Inherits optimistic state from AmendOperation so the commit graph
 * shows the amended commit immediately.
 */
export class GraphiteModifyOperation extends AmendOperation {
  static opName = 'gt modify';

  constructor(
    filePathsToAmend?: Array<RepoRelativePath>,
    message?: string,
    author?: string,
  ) {
    super(filePathsToAmend, message, author);
    this.runner = CommandRunner.Graphite;
  }

  getArgs() {
    const args: Array<string> = ['modify', '--no-interactive'];

    if (this.filePathsToAmend) {
      // When specific files are selected, we need to stage them via git first,
      // then run `gt modify` without --all so it only picks up staged changes.
      // For now, gt modify without --all amends with whatever is staged.
      // The caller is responsible for staging specific files before this runs.
    } else {
      // Stage all tracked changes
      args.push('--all');
    }

    if (this.message) {
      args.push('--message', this.message);
    }

    return args;
  }
}

/**
 * In Graphite mode, use `gt modify` instead of `git commit --amend`.
 *
 * `gt modify` amends the current commit AND automatically restacks any
 * dependent branches in the stack. Without it, amending via `git commit --amend`
 * can desync Graphite's tracked state.
 *
 * Note: partial selection (chunk-level amend) is not supported by `gt modify`
 * and falls back to a plain `AmendOperation` (git-based).
 */
export function getGraphiteModifyOperation(
  message: string | undefined,
  originalHead: CommitInfo | undefined,
  selection: PartialSelection,
  allFiles: Array<RepoRelativePath>,
): GraphiteModifyOperation | AmendOperation | PartialAmendOperation {
  const originalHeadHash = originalHead?.hash ?? '.';
  const intendedAuthor = readAtom(authorString);
  const authorArg =
    intendedAuthor != null && originalHead?.author !== intendedAuthor ? intendedAuthor : undefined;

  // Partial/chunk selection requires git-level internals; fall back to git commit --amend
  if (selection.hasChunkSelection()) {
    return new PartialAmendOperation(message, originalHeadHash, selection, allFiles);
  }

  if (selection.isEverythingSelected(() => allFiles)) {
    return new GraphiteModifyOperation(undefined, message, authorArg);
  } else {
    const selectedFiles = allFiles.filter(path => selection.isFullyOrPartiallySelected(path));
    return new GraphiteModifyOperation(selectedFiles, message, authorArg);
  }
}
