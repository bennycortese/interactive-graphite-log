/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type {
  ChangedFile,
  CodeReviewSystem,
  CommitInfo,
  CommitPhaseType,
  Hash,
  RepoRelativePath,
  SmartlogCommits,
  StableInfo,
} from 'isl/src/types';
import type {Logger} from './logger';

import path from 'path';
import {MAX_FETCHED_FILES_PER_COMMIT} from './commands';

export const COMMIT_END_MARK = '<<COMMIT_END_MARK>>';
export const FIELD_SEPARATOR = '<<FIELD_SEP>>';

///// Main commits fetch /////

/**
 * The git log format fields, in order. Each field is separated by FIELD_SEPARATOR,
 * and each commit ends with COMMIT_END_MARK.
 *
 * Fields:
 *  0: hash (%H)
 *  1: title/subject (%s)
 *  2: author (%an <%ae>)
 *  3: committer date ISO (%cI)
 *  4: parent hashes space-separated (%P)
 *  5: ref decorations (%D) - contains branch names, remote refs
 *  6: body (%B) - full commit message (must be last, may contain newlines)
 */
const GIT_LOG_FIELD_NAMES = [
  'hash',
  'title',
  'author',
  'date',
  'parents',
  'refs',
  'body',
] as const;

type GitLogFieldName = (typeof GIT_LOG_FIELD_NAMES)[number];

/**
 * Returns the git log --format string for fetching commit data.
 * The format uses FIELD_SEPARATOR between fields and COMMIT_END_MARK at the end.
 * The body (%B) is last since it can contain newlines.
 */
export function getMainFetchFormat(): string {
  // %H = hash, %s = subject, %an <%ae> = author, %cI = committer date ISO,
  // %P = parent hashes, %D = ref names
  // %B = full body (last because it may contain newlines)
  return [
    `%H${FIELD_SEPARATOR}%s${FIELD_SEPARATOR}%an <%ae>${FIELD_SEPARATOR}%cI${FIELD_SEPARATOR}%P${FIELD_SEPARATOR}%D${FIELD_SEPARATOR}%B`,
    COMMIT_END_MARK,
  ].join('');
}

/**
 * Parse refs string from git log %D into local and remote bookmark arrays.
 * Example %D output: "HEAD -> main, origin/main, origin/HEAD, feature-branch"
 */
function parseRefs(refsStr: string): {
  bookmarks: string[];
  remoteBookmarks: string[];
} {
  const bookmarks: string[] = [];
  const remoteBookmarks: string[] = [];

  if (!refsStr || refsStr.trim() === '') {
    return {bookmarks, remoteBookmarks};
  }

  const refs = refsStr.split(',').map(r => r.trim());
  for (const ref of refs) {
    if (ref === '') continue;

    // Skip HEAD pointer decorations
    if (ref === 'HEAD') continue;

    // "HEAD -> branchname" means current branch
    const headArrow = ref.match(/^HEAD -> (.+)$/);
    if (headArrow) {
      bookmarks.push(headArrow[1]);
      continue;
    }

    // "origin/branchname" or "remote/branchname" patterns
    if (ref.includes('/')) {
      // Skip origin/HEAD
      if (ref.endsWith('/HEAD')) continue;
      remoteBookmarks.push(ref);
    } else {
      // Local branch name
      bookmarks.push(ref);
    }
  }

  return {bookmarks, remoteBookmarks};
}

/**
 * Extract CommitInfos from `git log` output using our custom format.
 *
 * @param headHash - the current HEAD hash, used to determine isDot
 * @param publicAncestors - set of commit hashes known to be public (reachable from remote)
 */
export function parseCommitInfoOutput(
  logger: Logger,
  output: string,
  _reviewSystem: CodeReviewSystem,
  headHash: string,
  publicAncestors?: Set<string>,
): SmartlogCommits {
  const revisions = output.split(COMMIT_END_MARK);
  const commitInfos: Array<CommitInfo> = [];

  for (const chunk of revisions) {
    try {
      const trimmed = chunk.trim();
      if (trimmed === '') continue;

      const parts = trimmed.split(FIELD_SEPARATOR);
      if (parts.length < GIT_LOG_FIELD_NAMES.length) {
        continue;
      }

      const hash = parts[0].trim();
      const title = parts[1];
      const author = parts[2];
      const dateStr = parts[3];
      const parentsStr = parts[4].trim();
      const refsStr = parts[5];
      // Body is everything from index 6 onwards (it may contain FIELD_SEPARATOR if present in commit message, though unlikely)
      const body = parts.slice(6).join(FIELD_SEPARATOR).trim();

      const parents = parentsStr ? parentsStr.split(' ').filter(p => p.length > 0) : [];
      const {bookmarks, remoteBookmarks} = parseRefs(refsStr);

      // Determine phase: public if in the publicAncestors set, otherwise draft
      const phase: CommitPhaseType = publicAncestors?.has(hash) ? 'public' : 'draft';

      // Description is the body minus the first line (which is the title/subject)
      const bodyLines = body.split('\n');
      const description = bodyLines.length > 1 ? bodyLines.slice(1).join('\n').trim() : '';

      commitInfos.push({
        hash,
        title,
        author,
        date: new Date(dateStr),
        parents,
        grandparents: [], // git doesn't provide this directly; computed client-side if needed
        phase,
        bookmarks,
        remoteBookmarks,
        isDot: hash === headHash,
        filePathsSample: [], // fetched separately for performance
        totalFileCount: 0, // fetched separately
        successorInfo: undefined, // git has no mutation tracking
        closestPredecessors: undefined,
        description,
        diffId: undefined, // TODO: extract from Graphite PR metadata
        isFollower: false,
        stableCommitMetadata: undefined,
        maxCommonPathPrefix: '',
      });
    } catch (err) {
      logger.error('failed to parse commit', err);
    }
  }
  return commitInfos;
}

/**
 * Given a set of changed files, find the longest common path prefix.
 * See {@link CommitInfo}.maxCommonPathPrefix
 */
export function findMaxCommonPathPrefix(filePaths: Array<RepoRelativePath>): RepoRelativePath {
  let max: null | Array<string> = null;
  let maxLength = 0;

  // Use forward slash since git always uses forward slashes
  const sep = '/';

  for (const filePath of filePaths) {
    if (max == null) {
      max = filePath.split(sep);
      max.pop(); // ignore file part, only care about directory
      maxLength = max.reduce((acc, part) => acc + part.length + 1, 0);
      continue;
    }
    const parts = filePath.slice(0, maxLength).split(sep);
    for (const [i, part] of parts.entries()) {
      if (part !== max[i]) {
        max = max.slice(0, i);
        maxLength = max.reduce((acc, part) => acc + part.length + 1, 0);
        break;
      }
    }
    if (max.length === 0) {
      return '';
    }
  }

  const result = (max ?? []).join(sep);
  if (result == '') {
    return result;
  }
  return result + sep;
}

/**
 * Additional stable locations in the commit fetch will not automatically
 * include "stableCommitMetadata". Insert this data onto the commits.
 */
export function attachStableLocations(commits: Array<CommitInfo>, locations: Array<StableInfo>) {
  const map: Record<Hash, Array<StableInfo>> = {};
  for (const location of locations) {
    const existing = map[location.hash] ?? [];
    map[location.hash] = [...existing, location];
  }

  for (const commit of commits) {
    if (commit.hash in map) {
      commit.stableCommitMetadata = [
        ...(commit.stableCommitMetadata ?? []),
        ...map[commit.hash].map(location => ({
          value: location.name,
          description: location.info ?? '',
        })),
      ];
    }
  }
}

///// Changed Files /////

/**
 * Parse output of `git diff-tree --no-commit-id --name-status -r <hash>`
 * into ChangedFile arrays.
 *
 * Each line is like:
 *   M\tpath/to/file.ts
 *   A\tpath/to/new-file.ts
 *   D\tpath/to/deleted-file.ts
 *   R100\told-path\tnew-path  (rename with similarity score)
 *   C100\tsource-path\tdest-path  (copy with similarity score)
 */
export function parseChangedFilesOutput(output: string): {
  filesSample: Array<ChangedFile>;
  totalFileCount: number;
} {
  const files: Array<ChangedFile> = [];
  const lines = output.trim().split('\n').filter(l => l.length > 0);

  for (const line of lines) {
    const parts = line.split('\t');
    if (parts.length < 2) continue;

    const statusCode = parts[0];
    const filePath = parts[parts.length - 1]; // For renames/copies, use the new path

    let status: ChangedFile['status'];
    let copy: string | undefined;

    if (statusCode === 'M') {
      status = 'M';
    } else if (statusCode === 'A') {
      status = 'A';
    } else if (statusCode === 'D') {
      status = 'R'; // 'R' means "removed" in ISL's type system
    } else if (statusCode.startsWith('R')) {
      // Rename: old path is parts[1], new path is parts[2]
      status = 'A';
      copy = parts[1]; // renamed from
    } else if (statusCode.startsWith('C')) {
      // Copy
      status = 'A';
      copy = parts[1]; // copied from
    } else if (statusCode === 'U') {
      status = 'U'; // unmerged/conflict
    } else {
      status = 'M'; // fallback
    }

    files.push({path: filePath, status, ...(copy ? {copy} : {})});
  }

  return {
    filesSample: files.slice(0, MAX_FETCHED_FILES_PER_COMMIT),
    totalFileCount: files.length,
  };
}
