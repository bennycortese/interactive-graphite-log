/**
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {CommandRunner} from '../types';
import {Operation} from './Operation';

/**
 * Restack from trunk to the current branch using Graphite CLI.
 *
 * Runs `gt downstack restack --no-interactive`.
 *
 * From trunk to the current branch, ensures each branch is based on its
 * parent, rebasing if necessary. This is useful when upstream branches
 * have changed and you need to rebase your branch onto the latest state.
 */
export class GraphiteDownstackRestackOperation extends Operation {
  static opName = 'gt downstack restack';

  constructor() {
    super('GraphiteDownstackRestackOperation');
    this.runner = CommandRunner.Graphite;
  }

  getArgs() {
    return ['downstack', 'restack', '--no-interactive'];
  }
}
