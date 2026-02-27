/**
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type {MergeConflicts} from '../types';

import {CommandRunner} from '../types';
import {AbortMergeOperation} from './AbortMergeOperation';

/**
 * Abort a rebase/restack after conflicts using Graphite CLI.
 *
 * Runs `gt abort --no-interactive`.
 *
 * `gt abort` cancels the in-progress Graphite operation and restores
 * the previous state, maintaining Graphite's internal metadata.
 *
 * Extends AbortMergeOperation so `instanceof` checks in the UI still work.
 */
export class GraphiteAbortOperation extends AbortMergeOperation {
  static override opName = 'gt abort';

  constructor(conflicts: MergeConflicts, isPartialAbort: boolean) {
    super(conflicts, isPartialAbort);
    this.runner = CommandRunner.Graphite;
  }

  override getArgs() {
    return ['abort', '--no-interactive'];
  }
}
