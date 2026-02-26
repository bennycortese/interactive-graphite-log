/**
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type {ChangedFile, CommitInfo} from '../types';

import {CommandRunner} from '../types';
import {UncommitOperation} from './Uncommit';

/**
 * Uncommit the current branch using Graphite CLI.
 *
 * Runs `gt pop --no-interactive`.
 *
 * `gt pop` deletes the current branch but retains the state of files
 * in the working tree — effectively "uncommitting" while preserving
 * all changes. Graphite metadata is cleaned up and HEAD moves to
 * the parent branch.
 *
 * Inherits optimistic DAG and uncommitted changes preview from
 * UncommitOperation so the UI updates immediately.
 */
export class GraphitePopOperation extends UncommitOperation {
  static override opName = 'gt pop';

  constructor(originalDotCommit: CommitInfo, changedFiles: Array<ChangedFile>) {
    super(originalDotCommit, changedFiles);
    this.runner = CommandRunner.Graphite;
  }

  override getArgs() {
    return ['pop', '--no-interactive'];
  }
}
