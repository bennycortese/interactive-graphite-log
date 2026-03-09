/**
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {CommandRunner} from '../types';
import {Operation} from './Operation';

/**
 * Undo the most recent Graphite mutation, using Graphite CLI.
 *
 * Runs `gt undo --force --no-interactive`.
 *
 * Useful for recovering from accidental folds, deletes, moves, or other
 * Graphite stack operations. Only undoes the most recent mutation.
 */
export class GraphiteUndoOperation extends Operation {
  static opName = 'gt undo';

  constructor() {
    super('GraphiteUndoOperation');
    this.runner = CommandRunner.Graphite;
  }

  getArgs() {
    return ['undo', '--force', '--no-interactive'];
  }
}
