/**
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {CommandRunner} from '../types';
import {Operation} from './Operation';

/**
 * Submit stacked branches to GitHub as Pull Requests using Graphite CLI.
 *
 * Runs `gt submit --stack [--draft] [--update-only]`.
 *
 * `--stack` ensures all branches in the current stack are submitted,
 * not just the current branch. This is Graphite's key feature: stacked PRs
 * where each branch targets the one below it.
 */
export class GraphiteSubmitOperation extends Operation {
  static opName = 'gt submit';

  constructor(
    private options?: {
      draft?: boolean;
      /** If true, only update existing PRs; don't create new ones */
      updateOnly?: boolean;
    },
  ) {
    super('GraphiteSubmitOperation');
    this.runner = CommandRunner.Graphite;
  }

  getArgs() {
    const args = ['submit', '--stack'];
    if (this.options?.draft) {
      args.push('--draft');
    }
    if (this.options?.updateOnly) {
      args.push('--update-only');
    }
    return args;
  }
}
