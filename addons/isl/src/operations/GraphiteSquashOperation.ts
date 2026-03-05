/**
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {CommandRunner} from '../types';
import {Operation} from './Operation';

/**
 * Squash all commits in the current branch into one using Graphite CLI.
 *
 * Runs `gt squash --no-edit --no-interactive`.
 *
 * `gt squash` consolidates multiple commits within the current Graphite
 * branch into a single commit, then restacks all descendants.
 * This is useful when a branch has accumulated fixup commits that should
 * be combined before submitting for review.
 *
 * The `--no-edit` flag keeps the existing commit message without opening
 * an editor.
 */
export class GraphiteSquashOperation extends Operation {
  static opName = 'gt squash';

  constructor() {
    super('GraphiteSquashOperation');
    this.runner = CommandRunner.Graphite;
  }

  getArgs() {
    return ['squash', '--no-edit', '--no-interactive'];
  }
}
