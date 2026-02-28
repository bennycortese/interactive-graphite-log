/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type {Dag} from '../previews';
import type {ExactRevset, OptimisticRevset, SucceedableRevset} from '../types';

import {latestSuccessor} from '../successionUtils';
import {Operation} from './Operation';

export class RebaseAllDraftCommitsOperation extends Operation {
  constructor(
    private timeRangeDays: number | undefined,
    private destination: SucceedableRevset | ExactRevset | OptimisticRevset,
  ) {
    super('RebaseAllDraftCommitsOperation');
  }

  static opName = 'Rebase all draft commits';

  getArgs() {
    // In git, there's no equivalent of Sapling's `draft()` revset.
    // `git rebase <dest>` rebases the current branch onto the destination,
    // which is the closest approximation.
    return ['rebase', this.destination];
  }

  optimisticDag(dag: Dag): Dag {
    const dest = dag.resolve(latestSuccessor(dag, this.destination))?.hash;
    const draft = dag.draft();
    return dag.rebase(draft, dest);
  }
}
