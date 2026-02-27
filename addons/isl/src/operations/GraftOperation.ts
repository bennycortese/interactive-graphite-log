/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type {ExactRevset, OptimisticRevset, SucceedableRevset} from '../types';

import {t} from '../i18n';
import {Operation} from './Operation';

/** Graft (copy) a commit onto the current commit. Like Rebasing, without affecting the original commit.
 * Useful for public commits.  */
export class GraftOperation extends Operation {
  constructor(private source: SucceedableRevset | ExactRevset | OptimisticRevset) {
    super('GraftOperation');
  }

  static opName = 'Graft';

  /**
   * Git mode: `git cherry-pick <hash>` copies a commit onto HEAD.
   */
  getArgs() {
    return ['cherry-pick', this.source];
  }

  private hash() {
    return this.source.type === 'optimistic-revset' ? this.source.fake : this.source.revset;
  }

  getInitialInlineProgress(): Array<[string, string]> {
    // TODO: successions
    return [[this.hash(), t('cherry-picking...')]];
  }

  // TODO: Optimistic State
}
