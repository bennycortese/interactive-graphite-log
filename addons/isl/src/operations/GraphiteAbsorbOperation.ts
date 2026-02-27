/**
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type {ExactRevset, OptimisticRevset, RepoRelativePath, SucceedableRevset} from '../types';

import {CommandRunner} from '../types';
import {AmendToOperation} from './AmendToOperation';

/**
 * Absorb staged changes into the correct commits using Graphite CLI.
 *
 * Runs `gt absorb --force --no-interactive`.
 *
 * `gt absorb` automatically distributes staged hunks to the commits
 * that last touched those lines — the Graphite-native equivalent of
 * Sapling's `amend --to`. The `--force` flag skips safety checks.
 *
 * Inherits optimistic uncommitted changes preview from AmendToOperation.
 */
export class GraphiteAbsorbOperation extends AmendToOperation {
  static override opName = 'gt absorb';

  constructor(
    commit: SucceedableRevset | ExactRevset | OptimisticRevset,
    filePathsToAmend?: Array<RepoRelativePath>,
  ) {
    super(commit, filePathsToAmend);
    this.runner = CommandRunner.Graphite;
  }

  override getArgs() {
    return ['absorb', '--force', '--no-interactive'];
  }
}
