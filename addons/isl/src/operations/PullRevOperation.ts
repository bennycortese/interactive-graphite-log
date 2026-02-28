/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type {ExactRevset} from '../types';

import {Operation} from './Operation';

export class PullRevOperation extends Operation {
  static opName = 'PullRev';

  constructor(private rev: ExactRevset) {
    super('PullRevOperation');
  }

  getArgs() {
    // git fetch origin fetches all refs from the remote.
    // Unlike `sl pull --rev`, git fetch doesn't support pulling a single revision.
    return ['fetch', 'origin'];
  }
}
