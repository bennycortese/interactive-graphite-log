/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type {ExactRevset, OptimisticRevset, SucceedableRevset} from '../types';

import {Operation} from './Operation';

/** Like rebase, but leave the source in place, and don't rebase children.
 * Behaves more like "Graft" than rebase, but without going to the result. Useful for copying public commits.
 * Note: does not use the latest successor by default, rather the exact source revset. */
export class RebaseKeepOperation extends Operation {
  constructor(
    protected source: SucceedableRevset | ExactRevset | OptimisticRevset,
    protected destination: SucceedableRevset | ExactRevset | OptimisticRevset,
  ) {
    super('RebaseKeepOperation');
  }

  static opName = 'Rebase (keep)';

  getArgs() {
    // git cherry-pick copies the source commit onto HEAD without removing the original.
    // Unlike `sl rebase --keep`, git cherry-pick doesn't support an explicit --dest;
    // the destination is always HEAD.
    return ['cherry-pick', this.source];
  }

  // TODO: Support optimistic state. Presently not an issue because its use case in "Download Commits"
  // doesn't support optimistic state anyway.
}
