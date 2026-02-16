/**
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type {Hash} from '../types';

import {CommandRunner} from '../types';
import {CommitOperation} from './CommitOperation';

/**
 * Create a new Graphite-tracked branch with a commit, using `gt create`.
 *
 * Runs `gt create --all --message <message>`, which:
 * 1. Stages all tracked changes (like `git add -u`)
 * 2. Creates a new commit
 * 3. Creates a new branch tracked in Graphite's stack metadata
 *
 * This is the recommended way to commit in Graphite mode because it keeps
 * the branch tracked by Graphite, enabling `gt sync` to automatically
 * restack it when dependent branches change.
 *
 * Inherits optimistic state from CommitOperation so the commit graph
 * shows the new commit immediately.
 */
export class GraphiteCreateOperation extends CommitOperation {
  static opName = 'gt create';

  constructor(message: string, originalHeadHash: Hash) {
    super(message, originalHeadHash);
    // Override runner to use Graphite CLI
    this.runner = CommandRunner.Graphite;
  }

  getArgs() {
    // gt create --all --message <message>
    // --all: stage all tracked modifications (equivalent to git commit -a)
    // --message: commit message (first line becomes the branch name suggestion)
    return ['create', '--all', '--message', this.message];
  }
}
