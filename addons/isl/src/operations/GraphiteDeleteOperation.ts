/**
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type {ExactRevset, OptimisticRevset, SucceedableRevset} from '../types';

import {CommandRunner} from '../types';
import {HideOperation} from './HideOperation';

/**
 * Delete a branch using Graphite CLI.
 *
 * Runs `gt delete <branch> --force --no-interactive`.
 *
 * `gt delete` removes the branch and its Graphite metadata, then
 * restacks any children onto the parent branch. The `--force` flag
 * skips the confirmation prompt and allows deleting branches with
 * unmerged changes.
 *
 * Inherits optimistic DAG preview from HideOperation so the UI
 * updates immediately.
 */
export class GraphiteDeleteOperation extends HideOperation {
  static override opName = 'gt delete';

  constructor(
    source: SucceedableRevset | ExactRevset | OptimisticRevset,
    branchName: string,
  ) {
    super(source, branchName);
    this.runner = CommandRunner.Graphite;
  }

  override getArgs() {
    return ['delete', this.branchName!, '--force', '--no-interactive'];
  }
}
