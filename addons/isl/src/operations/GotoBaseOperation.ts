/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type {ExactRevset, OptimisticRevset, SucceedableRevset} from '../types';

import {Operation} from './Operation';

export class GotoBaseOperation extends Operation {
  constructor(protected destination: SucceedableRevset | ExactRevset | OptimisticRevset) {
    super('GotoOperation');
  }

  static opName = 'Goto';

  getArgs() {
    // git checkout <hash/branch> - equivalent to sl goto --rev
    const args = ['checkout', this.destination];
    return args;
  }
}
