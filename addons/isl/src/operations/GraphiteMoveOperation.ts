/**
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type {ExactRevset, OptimisticRevset, SucceedableRevset} from '../types';

import {CommandRunner} from '../types';
import {RebaseOperation} from './RebaseOperation';

/**
 * Move a branch onto a new parent using Graphite CLI.
 *
 * Runs `gt move --onto <dest> --source <source> --no-interactive`.
 *
 * `gt move` rebases the source branch and automatically restacks all
 * descendant branches, maintaining Graphite metadata throughout.
 * This is superior to raw `git rebase` because it keeps Graphite's
 * branch tracking and parent relationships intact.
 *
 * Inherits preview and optimistic DAG logic from RebaseOperation
 * so the commit graph shows the expected result immediately.
 */
export class GraphiteMoveOperation extends RebaseOperation {
  static override opName = 'gt move';

  constructor(
    source: SucceedableRevset | ExactRevset | OptimisticRevset,
    destination: SucceedableRevset | ExactRevset | OptimisticRevset,
    private sourceBranch: string,
    private destBranch: string,
  ) {
    super(source, destination);
    this.runner = CommandRunner.Graphite;
  }

  override getArgs() {
    return ['move', '--onto', this.destBranch, '--source', this.sourceBranch, '--no-interactive'];
  }
}
