/**
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type {CommitInfo} from '../types';

import {CommandRunner} from '../types';
import {FoldOperation} from './FoldOperation';

/**
 * Fold the current branch into its parent using Graphite CLI.
 *
 * Runs `gt fold --no-interactive`.
 *
 * `gt fold` merges the current branch's changes into its parent branch,
 * restacks all descendants, and removes the current branch's Graphite metadata.
 * This is the Graphite-native way to combine adjacent branches in a stack.
 *
 * Note: `gt fold` does not accept a `--message` flag — it uses its own
 * message merging strategy. If the user edited the combined message in
 * the ISL preview, a follow-up `gt modify --message` is needed.
 *
 * Inherits optimistic DAG preview from FoldOperation so the commit graph
 * shows the combined commit immediately.
 */
export class GraphiteFoldOperation extends FoldOperation {
  static override opName = 'gt fold';

  constructor(foldRange: Array<CommitInfo>, newMessage: string) {
    super(foldRange, newMessage);
    this.runner = CommandRunner.Graphite;
  }

  override getArgs() {
    return ['fold', '--no-interactive'];
  }
}
