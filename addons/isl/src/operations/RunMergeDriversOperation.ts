/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {Operation} from './Operation';

export class RunMergeDriversOperation extends Operation {
  static opName = 'RunMergeDrivers';

  constructor() {
    super('RunMergeDriversOperation');
  }

  getArgs() {
    // In git, staging all files marks conflicts as resolved.
    // This is the closest equivalent to Sapling's `sl resolve --all`
    // which runs merge drivers to auto-resolve conflicts.
    return ['add', '-A'];
  }
}
