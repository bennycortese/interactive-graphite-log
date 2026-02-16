/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {commandRunnerForMode} from '../atoms/CommandRunnerModeState';
import {CommandRunner} from '../types';
import {Operation} from './Operation';

/**
 * Sync/pull from remote.
 *
 * In Graphite mode (default): runs `gt sync` which fetches from remote and
 * automatically restacks stacked branches. This is the recommended mode when
 * using Graphite for stacked diffs.
 *
 * In Git mode: runs `git fetch --all --prune` to fetch all remotes.
 */
export class PullOperation extends Operation {
  static opName = 'Sync';

  constructor(mode: 'git' | 'graphite' = 'graphite') {
    super('PullOperation');
    this.runner = commandRunnerForMode(mode);
  }

  getArgs() {
    if (this.runner === CommandRunner.Graphite) {
      return ['sync'];
    }
    // git mode: fetch all remotes and prune deleted remote branches
    return ['fetch', '--all', '--prune'];
  }
}
