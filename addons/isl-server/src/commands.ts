/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type {EjecaOptions, EjecaReturn} from 'shared/ejeca';
import type {RepositoryContext} from './serverTypes';

import {ConflictType, type AbsolutePath, type MergeConflicts} from 'isl/src/types';
import os from 'node:os';
import {ejeca} from 'shared/ejeca';
import {isEjecaError} from './utils';

export const MAX_FETCHED_FILES_PER_COMMIT = 25;
export const MAX_SIMULTANEOUS_CAT_CALLS = 4;
/** Timeout for non-operation commands. Operations like goto and rebase are expected to take longer,
 * but status, log, cat, etc should typically take <10s. */
export const READ_COMMAND_TIMEOUT_MS = 60_000;

export type ConflictFileData = {
  contents: string | null;
  exists: boolean;
  isexec: boolean;
  issymlink: boolean;
};
export type ResolveCommandConflictOutput = [
  | {
      command: null;
      conflicts: [];
      pathconflicts: [];
    }
  | {
      command: string;
      command_details: {cmd: string; to_abort: string; to_continue: string};
      conflicts: Array<{
        base: ConflictFileData;
        local: ConflictFileData;
        output: ConflictFileData;
        other: ConflictFileData;
        path: string;
      }>;
      pathconflicts: Array<never>;
      hashes?: {
        local?: string;
        other?: string;
      };
    },
];

/** Run a git/gt command (without analytics). */
export async function runCommand(
  ctx: RepositoryContext,
  args_: Array<string>,
  options_?: EjecaOptions,
  timeout: number = READ_COMMAND_TIMEOUT_MS,
  logErrors: boolean = true,
): Promise<EjecaReturn> {
  const {command, args, options} = getExecParams(ctx.cmd, args_, ctx.cwd, options_);
  ctx.logger.log('run command: ', ctx.cwd, command, args[0]);
  const result = ejeca(command, args, options);

  let timedOut = false;
  let timeoutId: NodeJS.Timeout | undefined;
  if (timeout > 0) {
    timeoutId = setTimeout(() => {
      result.kill('SIGTERM', {forceKillAfterTimeout: 5_000});
      ctx.logger.error(`Timed out waiting for ${command} ${args[0]} to finish`);
      timedOut = true;
    }, timeout);
    result.on('exit', () => {
      clearTimeout(timeoutId);
    });
  }

  try {
    const val = await result;
    return val;
  } catch (err: unknown) {
    if (isEjecaError(err)) {
      if (err.killed) {
        if (timedOut) {
          throw new Error('Timed out');
        }
        throw new Error('Killed');
      }
    }
    if (logErrors) {
      ctx.logger.error(`Error running ${command} ${args[0]}: ${err?.toString()}`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Root of the repository where the .git folder lives.
 * Throws only if `git` is not found, so this check can double as validation of the command. */
export async function findRoot(ctx: RepositoryContext): Promise<AbsolutePath | undefined> {
  try {
    return (await runCommand(ctx, ['rev-parse', '--show-toplevel'])).stdout.trim();
  } catch (error) {
    if (
      ['ENOENT', 'EACCES'].includes((error as {code: string}).code) ||
      // On Windows, we won't necessarily get an actual ENOENT error code in the error,
      // because execa does not attempt to detect this.
      // Other spawning libraries like node-cross-spawn do, which is the approach we can take.
      // https://github.com/sindresorhus/execa/issues/469#issuecomment-859924543
      (os.platform() === 'win32' && (error as {exitCode: number}).exitCode === 1)
    ) {
      ctx.logger.error(`command ${ctx.cmd} not found`, error);
      throw error;
    }
  }
}

/**
 * Return the repository root. Git doesn't have nested roots like Sapling,
 * so this just returns a single-element array with the root.
 */
export async function findRoots(ctx: RepositoryContext): Promise<AbsolutePath[] | undefined> {
  try {
    const root = await findRoot(ctx);
    return root ? [root] : undefined;
  } catch (error) {
    ctx.logger.error(`Failed to find repository roots starting from ${ctx.cwd}`, error);
    return undefined;
  }
}

export async function findDotDir(ctx: RepositoryContext): Promise<AbsolutePath | undefined> {
  try {
    return (await runCommand(ctx, ['rev-parse', '--git-dir'])).stdout.trim();
  } catch (error) {
    ctx.logger.error(`Failed to find repository dotdir in ${ctx.cwd}`, error);
    return undefined;
  }
}

/**
 * Read multiple git configs.
 * Return a Map from config name to config value for present configs.
 * Missing configs will not be returned.
 * Errors are silenced.
 */
export async function getConfigs<T extends string>(
  ctx: RepositoryContext,
  configNames: ReadonlyArray<T>,
): Promise<Map<T, string>> {
  if (configOverride !== undefined) {
    // Use the override to answer config questions.
    const configMap = new Map(
      configNames.flatMap(name => {
        const value = configOverride?.get(name);
        return value === undefined ? [] : [[name, value]];
      }),
    );
    return configMap;
  }
  const configMap: Map<T, string> = new Map();
  for (const name of configNames) {
    try {
      // logErrors=false: exit code 1 means "key not set", which is expected and not an error
      const result = await runCommand(ctx, ['config', '--get', name], undefined, undefined, false);
      const value = result.stdout.trim();
      if (value !== '') {
        configMap.set(name, value);
      }
    } catch {
      // git config --get exits with code 1 if the key is not found, which is expected
    }
  }
  ctx.logger.info(`loaded configs from ${ctx.cwd}:`, configMap);
  return configMap;
}

export type ConfigLevel = 'global' | 'system' | 'local';
export async function setConfig(
  ctx: RepositoryContext,
  level: ConfigLevel,
  configName: string,
  configValue: string,
): Promise<void> {
  await runCommand(ctx, ['config', `--${level}`, configName, configValue]);
}

export function getExecParams(
  command: string,
  args_: Array<string>,
  cwd: string,
  options_?: EjecaOptions,
  env?: NodeJS.ProcessEnv | Record<string, string>,
): {
  command: string;
  args: Array<string>;
  options: EjecaOptions;
} {
  const args = [...args_];
  // Suppress interactive editors for git commands
  const editor = os.platform() === 'win32' ? 'exit /b 1' : 'false';
  const newEnv = {
    ...options_?.env,
    ...env,
    GIT_EDITOR: editor,
    EDITOR: undefined,
    VISUAL: undefined,
  } as unknown as NodeJS.ProcessEnv;
  let langEnv = newEnv.LANG ?? process.env.LANG;
  if (langEnv === undefined || !langEnv.toUpperCase().endsWith('UTF-8')) {
    langEnv = 'C.UTF-8';
  }
  newEnv.LANG = langEnv;
  const options: EjecaOptions = {
    ...options_,
    env: newEnv,
    cwd,
  };

  return {command, args, options};
}

/**
 * extract repo info from a remote url, typically for GitHub or GitHub Enterprise,
 * in various formats:
 * https://github.com/owner/repo
 * https://github.com/owner/repo.git
 * github.com/owner/repo.git
 * git@github.com:owner/repo.git
 * ssh:git@github.com:owner/repo.git
 * ssh://git@github.com/owner/repo.git
 * git+ssh:git@github.com:owner/repo.git
 *
 * or similar urls with GitHub Enterprise hostnames:
 * https://ghe.myCompany.com/owner/repo
 */
export function extractRepoInfoFromUrl(
  url: string,
): {repo: string; owner: string; hostname: string} | null {
  const match =
    /(?:https:\/\/(.*)\/|(?:git\+ssh:\/\/|ssh:\/\/)?(?:git@)?([^:/]*)[:/])([^/]+)\/(.+?)(?:\.git)?$/.exec(
      url,
    );

  if (match == null) {
    return null;
  }

  const [, hostname1, hostname2, owner, repo] = match;
  return {owner, repo, hostname: hostname1 ?? hostname2};
}

export function computeNewConflicts(
  previousConflicts: MergeConflicts,
  commandOutput: ResolveCommandConflictOutput,
  fetchStartTimestamp: number,
): MergeConflicts | undefined {
  const newConflictData = commandOutput?.[0];
  if (newConflictData?.command == null) {
    return undefined;
  }

  const conflicts: MergeConflicts = {
    state: 'loaded',
    command: newConflictData.command,
    toContinue: newConflictData.command_details.to_continue,
    toAbort: newConflictData.command_details.to_abort,
    files: [],
    fetchStartTimestamp,
    fetchCompletedTimestamp: Date.now(),
    hashes: newConflictData.hashes,
  };

  const previousFiles = previousConflicts?.files ?? [];

  const newConflictSet = new Set(newConflictData.conflicts.map(conflict => conflict.path));
  const conflictFileData = new Map(
    newConflictData.conflicts.map(conflict => [conflict.path, conflict]),
  );
  const previousFilesSet = new Set(previousFiles.map(file => file.path));
  const newlyAddedConflicts = new Set(
    [...newConflictSet].filter(file => !previousFilesSet.has(file)),
  );
  // we may have seen conflicts before, some of which might now be resolved.
  // Preserve previous ordering by first pulling from previous files
  conflicts.files = previousFiles.map(conflict =>
    newConflictSet.has(conflict.path)
      ? {...conflict, status: 'U'}
      : // 'R' is overloaded to mean "removed" for `git status` but 'Resolved' for conflict resolution
        // let's re-write this to make the UI layer simpler.
        {...conflict, status: 'Resolved'},
  );
  if (newlyAddedConflicts.size > 0) {
    conflicts.files.push(
      ...[...newlyAddedConflicts].map(conflict => ({
        path: conflict,
        status: 'U' as const,
        conflictType: getConflictType(conflictFileData.get(conflict)) ?? ConflictType.BothChanged,
      })),
    );
  }

  return conflicts;
}

function getConflictType(
  conflict?: ResolveCommandConflictOutput[number]['conflicts'][number],
): ConflictType | undefined {
  if (conflict == null) {
    return undefined;
  }
  let type;
  if (conflict.local.exists && conflict.other.exists) {
    type = ConflictType.BothChanged;
  } else if (conflict.other.exists) {
    type = ConflictType.DeletedInDest;
  } else {
    type = ConflictType.DeletedInSource;
  }
  return type;
}

/**
 * By default, detect "jest" and enable config override to avoid shelling out.
 * See also `getConfigs`.
 */
let configOverride: undefined | Map<string, string> =
  typeof jest === 'undefined' ? undefined : new Map();

/**
 * Set the "knownConfig" used by new repos.
 * This is useful in tests and prevents shelling out to config commands.
 */
export function setConfigOverrideForTests(configs: Iterable<[string, string]>, override = true) {
  if (override) {
    configOverride = new Map(configs);
  } else {
    configOverride ??= new Map();
    for (const [key, value] of configs) {
      configOverride.set(key, value);
    }
  }
}
