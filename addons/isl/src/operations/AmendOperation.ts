/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type {ImportAmendCommit, ImportStack} from 'shared/types/stack';
import type {PartialSelection} from '../partialSelection';
import type {
  ApplyUncommittedChangesPreviewsFuncType,
  Dag,
  UncommittedChangesPreviewContext,
} from '../previews';
import type {CommandArg, CommitInfo, Hash, RepoRelativePath, UncommittedChanges} from '../types';

import {t} from '../i18n';
import {readAtom} from '../jotaiUtils';
import {authorString} from '../serverAPIState';
import {Operation} from './Operation';

export class AmendOperation extends Operation {
  /**
   * @param filePathsToAmend if provided, only these file paths will be included in the amend operation. If undefined, ALL uncommitted changes are included. Paths should be relative to repo root.
   * @param message if provided, update commit description to use this title & description
   */
  constructor(
    private filePathsToAmend?: Array<RepoRelativePath>,
    public message?: string,
    public author?: string,
  ) {
    super(filePathsToAmend ? 'AmendFileSubsetOperation' : 'AmendOperation');
  }

  static opName = 'Amend';

  getArgs() {
    // git commit --amend -a: amend HEAD with all tracked changes
    const args: Array<CommandArg> = ['commit', '--amend', '-a', '--no-edit'];
    if (this.filePathsToAmend) {
      // If specific files, don't use -a; stage only those files
      // Remove '--no-edit' and '-a' then add specific files
      args.splice(2, 2); // remove '-a' and '--no-edit'
      args.push(
        ...this.filePathsToAmend.map(file => ({
          type: 'repo-relative-file' as const,
          path: file,
        })),
      );
    }

    if (this.author) {
      args.push('--author', this.author);
    }
    if (this.message) {
      // Replace --no-edit with --message when message is provided
      const noEditIdx = args.indexOf('--no-edit');
      if (noEditIdx >= 0) {
        args.splice(noEditIdx, 1);
      }
      args.push('--message', this.message);
    }
    return args;
  }

  makeOptimisticUncommittedChangesApplier?(
    context: UncommittedChangesPreviewContext,
  ): ApplyUncommittedChangesPreviewsFuncType | undefined {
    const filesToAmend = new Set(this.filePathsToAmend);
    if (
      context.uncommittedChanges.length === 0 ||
      (filesToAmend.size > 0 &&
        context.uncommittedChanges.every(change => !filesToAmend.has(change.path)))
    ) {
      return undefined;
    }

    const func: ApplyUncommittedChangesPreviewsFuncType = (changes: UncommittedChanges) => {
      if (this.filePathsToAmend != null) {
        return changes.filter(change => !filesToAmend.has(change.path));
      } else {
        return [];
      }
    };
    return func;
  }

  // Bump the timestamp and update the commit message.
  optimisticDag(dag: Dag): Dag {
    const head = dag.resolve('.');
    if (head?.hash == null) {
      return dag;
    }
    // XXX: amend's auto restack does not bump timestamp yet. We should fix that
    // and remove includeDescendants here.
    return dag.touch(head.hash, false /* includeDescendants */).replaceWith(head.hash, (_h, c) => {
      if (this.message == null) {
        return c;
      }
      const [title] = this.message.split(/\n+/, 1);
      const description = this.message.slice(title.length);
      // TODO: we should also update `filesSample` after amending.
      // These files are visible in the commit info view during optimistic state.
      return c?.merge({title, description});
    });
  }
}

export class PartialAmendOperation extends Operation {
  /**
   * See also `AmendOperation`. This operation takes a `PartialSelection` and
   * uses `debugimportstack` under the hood, to achieve `amend -i` effect.
   */
  constructor(
    public message: string | undefined,
    private originalHeadHash: Hash,
    private selection: PartialSelection,
    // We need "selected" or "all" files since `selection` only tracks deselected files.
    private allFiles: Array<RepoRelativePath>,
  ) {
    super('PartialAmendOperation');
  }

  getArgs(): CommandArg[] {
    return ['debugimportstack'];
  }

  getStdin(): string | undefined {
    const files = this.selection.calculateImportStackFiles(this.allFiles);
    const commitInfo: ImportAmendCommit = {
      mark: ':1',
      node: this.originalHeadHash,
      files,
    };
    if (this.message) {
      commitInfo.text = this.message;
    }
    const importStack: ImportStack = [
      ['amend', commitInfo],
      ['reset', {mark: ':1'}],
    ];
    return JSON.stringify(importStack);
  }

  getDescriptionForDisplay() {
    return {
      description: t('Amending selected changes'),
      tooltip: t(
        'This operation does not have a traditional command line equivalent. \n' +
          'You can use `amend -i` on the command line to select changes to amend.',
      ),
    };
  }
}

/** Choose `PartialAmendOperation` or `AmendOperation` based on input. */
export function getAmendOperation(
  message: string | undefined,
  originalHead: CommitInfo | undefined,
  selection: PartialSelection,
  allFiles: Array<RepoRelativePath>,
): AmendOperation | PartialAmendOperation {
  const originalHeadHash = originalHead?.hash ?? '.';
  const intendedAuthor = readAtom(authorString);
  const authorArg =
    intendedAuthor != null && originalHead?.author !== intendedAuthor ? intendedAuthor : undefined;
  if (selection.hasChunkSelection()) {
    return new PartialAmendOperation(message, originalHeadHash, selection, allFiles);
  } else if (selection.isEverythingSelected(() => allFiles)) {
    return new AmendOperation(undefined, message, authorArg);
  } else {
    const selectedFiles = allFiles.filter(path => selection.isFullyOrPartiallySelected(path));
    return new AmendOperation(selectedFiles, message, authorArg);
  }
}
