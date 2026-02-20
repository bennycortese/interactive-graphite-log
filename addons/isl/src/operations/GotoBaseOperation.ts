/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type {ExactRevset, OptimisticRevset, SucceedableRevset} from '../types';

import {CommandRunner} from '../types';
import {Operation} from './Operation';

export class GotoBaseOperation extends Operation {
  /**
   * @param destination Revset for the target commit (used by git checkout fallback)
   * @param graphiteBranch If set, use `gt branch checkout <name>` instead of `git checkout`
   */
  constructor(
    protected destination: SucceedableRevset | ExactRevset | OptimisticRevset,
    private graphiteBranch?: string,
  ) {
    super('GotoOperation');
    if (graphiteBranch) {
      this.runner = CommandRunner.Graphite;
    }
  }

  static opName = 'Goto';

  getArgs() {
    if (this.runner === CommandRunner.Graphite && this.graphiteBranch) {
      return ['branch', 'checkout', this.graphiteBranch];
    }
    return ['checkout', this.destination];
  }
}
