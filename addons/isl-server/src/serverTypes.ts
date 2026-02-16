/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type {ConfigName} from 'isl/src/types';
import type {ServerSideTracker} from './analytics/serverSideTracker';
import type {Logger} from './logger';

/**
 * Per-connection context with which to access a repository.
 * Repositories instances are shared and reused, but
 * this context is not. It's used for any state that cannot be shared.
 */
export type RepositoryContext = {
  /** The SCM command to run, typically 'git'. For graphite operations, 'gt' is used separately. */
  cmd: string;
  cwd: string;
  logger: Logger;
  tracker: ServerSideTracker;

  knownConfigs?: ReadonlyMap<ConfigName, string> | undefined;
  // TODO: visible commit age range
};
