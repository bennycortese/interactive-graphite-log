/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type {Dag} from '../previews';
import type {ExactRevset, OptimisticRevset, SucceedableRevset} from '../types';

import {CommitPreview} from '../previews';
import {Operation} from './Operation';

export class HideOperation extends Operation {
  constructor(
    protected source: SucceedableRevset | ExactRevset | OptimisticRevset,
    protected branchName?: string,
  ) {
    super('HideOperation');
  }

  static opName = 'Hide';

  /**
   * Git mode: delete the branch with `git branch -D <name>`.
   * Once the branch is deleted, the commit becomes unreachable and
   * won't appear in `git log --branches`.
   * If no branch name is available, this is a no-op.
   */
  getArgs() {
    if (this.branchName) {
      return ['branch', '-D', this.branchName];
    }
    // No branch to delete — commit is already unreachable or has no branch ref
    return ['status'];
  }

  protected hash() {
    return this.source.type === 'optimistic-revset' ? this.source.fake : this.source.revset;
  }

  previewDag(dag: Dag): Dag {
    const hash = this.hash();
    const toHide = dag.descendants(hash);
    return dag.replaceWith(toHide, (h, c) => {
      const previewType = h === hash ? CommitPreview.HIDDEN_ROOT : CommitPreview.HIDDEN_DESCENDANT;
      return c?.merge({previewType});
    });
  }

  optimisticDag(dag: Dag): Dag {
    const hash = this.hash();
    const toHide = dag.descendants(hash);
    const toCleanup = dag.parents(hash);
    // If the head is being hidden, we need to move the head to the parent.
    const newHead = [];
    if (toHide.toHashes().some(h => dag.get(h)?.isDot == true)) {
      const parent = dag.get(hash)?.parents?.at(0);
      if (parent && dag.has(parent)) {
        newHead.push(parent);
      }
    }
    return dag
      .remove(toHide)
      .replaceWith(newHead, (_h, c) => {
        return c?.merge({isDot: true, previewType: CommitPreview.GOTO_DESTINATION});
      })
      .cleanup(toCleanup);
  }
}
