/**
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {CommandRunner} from '../types';
import {Operation} from './Operation';

/**
 * Merge PRs from trunk to the current branch via Graphite merge queue.
 *
 * Runs `gt merge --no-interactive`.
 *
 * `gt merge` uses Graphite's merge queue to land stacked PRs in order.
 * This is the Graphite-native way to merge PRs, handling the complexities
 * of stacked PR dependencies automatically.
 *
 * Prerequisites: the stack must have submitted PRs (via `gt submit`).
 */
export class GraphiteMergeOperation extends Operation {
  static opName = 'gt merge';

  constructor() {
    super('GraphiteMergeOperation');
    this.runner = CommandRunner.Graphite;
  }

  getArgs() {
    return ['merge', '--no-interactive'];
  }
}
