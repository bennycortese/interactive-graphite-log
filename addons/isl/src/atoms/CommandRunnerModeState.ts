/**
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {atomWithStorage} from 'jotai/utils';
import {CommandRunner} from '../types';

/**
 * The preferred command runner mode for operations.
 * - 'git': Use raw git commands for all operations
 * - 'graphite': Use Graphite CLI (gt) for stack-aware operations (sync, submit, etc.)
 *
 * Persisted to localStorage so the choice survives page refreshes.
 * Defaults to 'graphite' since Graphite is the primary use case.
 */
export const commandRunnerMode = atomWithStorage<'git' | 'graphite'>(
  'isl.command-runner-mode',
  'graphite',
);

/** Returns the CommandRunner enum value for the current mode. */
export function commandRunnerForMode(mode: 'git' | 'graphite'): CommandRunner {
  return mode === 'graphite' ? CommandRunner.Graphite : CommandRunner.Git;
}
