/**
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type {RepoRelativePath} from '../types';

import {CommandRunner} from '../types';
import {Operation} from './Operation';

/**
 * Split the current branch by file using Graphite CLI.
 *
 * Runs `gt split --by-file <paths> --no-interactive`.
 *
 * `gt split --by-file` moves the specified files from the current branch
 * into a new child branch, keeping the remaining files in the current branch.
 * Graphite metadata is updated automatically and descendants are restacked.
 *
 * Only files that are part of the current branch's changes can be split out.
 */
export class GraphiteSplitOperation extends Operation {
  static opName = 'gt split';

  constructor(private filePaths: RepoRelativePath[]) {
    super('GraphiteSplitOperation');
    this.runner = CommandRunner.Graphite;
  }

  getArgs() {
    return ['split', '--by-file', ...this.filePaths, '--no-interactive'];
  }
}
