/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {CommandRunner} from '../types';
import {Operation} from './Operation';

/**
 * Sync using Graphite's `gt sync` command, which fetches from remote
 * and restacks stacked branches automatically.
 */
export class PullOperation extends Operation {
  static opName = 'Sync';

  constructor() {
    super('PullOperation');
    // Use Graphite CLI for sync to handle stack restacking
    this.runner = CommandRunner.Graphite;
  }

  getArgs() {
    return ['sync'];
  }
}
