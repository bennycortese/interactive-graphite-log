/**
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {CommandRunner} from '../types';
import {Operation} from './Operation';

/**
 * Restack dependent branches after amending a commit, using Graphite CLI.
 *
 * Runs `gt restack`.
 *
 * When you amend a commit that has dependent branches stacked on top of it,
 * those branches need to be rebased onto the new version of the amended commit.
 * `gt restack` does this automatically for all downstream branches in the stack.
 */
export class GraphiteRestackOperation extends Operation {
  static opName = 'gt restack';

  constructor() {
    super('GraphiteRestackOperation');
    this.runner = CommandRunner.Graphite;
  }

  getArgs() {
    return ['restack'];
  }
}
