/**
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {CommandRunner} from '../types';
import {Operation} from './Operation';

/**
 * Restack the current branch and all its descendants using Graphite CLI.
 *
 * Runs `gt upstack restack --no-interactive`.
 *
 * Ensures the current branch and each of its descendants is based on its
 * parent, rebasing if necessary. This is more targeted than `gt restack`
 * which restacks the entire repository.
 */
export class GraphiteUpstackRestackOperation extends Operation {
  static opName = 'gt upstack restack';

  constructor() {
    super('GraphiteUpstackRestackOperation');
    this.runner = CommandRunner.Graphite;
  }

  getArgs() {
    return ['upstack', 'restack', '--no-interactive'];
  }
}
