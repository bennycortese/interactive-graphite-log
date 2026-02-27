/**
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {CommandRunner} from '../types';
import {ContinueOperation} from './ContinueMergeOperation';

/**
 * Continue a rebase/restack after resolving conflicts using Graphite CLI.
 *
 * Runs `gt continue --no-interactive`.
 *
 * `gt continue` resumes the in-progress Graphite operation (restack, etc.)
 * and maintains Graphite's internal metadata, unlike raw `git rebase --continue`.
 *
 * Extends ContinueOperation so `instanceof` checks in the UI still work.
 */
export class GraphiteContinueOperation extends ContinueOperation {
  static override opName = 'gt continue';

  constructor() {
    super();
    this.runner = CommandRunner.Graphite;
  }

  override getArgs() {
    return ['continue', '--no-interactive'];
  }
}
