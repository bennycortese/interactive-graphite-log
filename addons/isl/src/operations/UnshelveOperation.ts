/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type {
  ApplyUncommittedChangesPreviewsFuncType,
  UncommittedChangesPreviewContext,
} from '../previews';
import type {ShelvedChange, UncommittedChanges} from '../types';

import {Operation} from './Operation';

export class UnshelveOperation extends Operation {
  constructor(
    private shelvedChange: ShelvedChange,
    private keep: boolean,
  ) {
    super('UnshelveOperation');
  }

  static opName = 'Unshelve';

  /**
   * Git mode: `git stash apply` (keep=true) or `git stash pop` (keep=false).
   * The stash entry is identified by its stashRef (e.g. "stash@{0}").
   */
  getArgs() {
    const subcommand = this.keep ? 'apply' : 'pop';
    const ref = this.shelvedChange.stashRef ?? 'stash@{0}';
    return ['stash', subcommand, ref];
  }

  makeOptimisticUncommittedChangesApplier?(
    context: UncommittedChangesPreviewContext,
  ): ApplyUncommittedChangesPreviewsFuncType | undefined {
    const shelvedChangedFiles = this.shelvedChange.filesSample;
    const preexistingChanges = new Set(context.uncommittedChanges.map(change => change.path));

    if (shelvedChangedFiles.every(file => preexistingChanges.has(file.path))) {
      // once every file to unshelve appears in the output, the unshelve has reflected in the latest fetch.
      return undefined;
    }

    const func: ApplyUncommittedChangesPreviewsFuncType = (changes: UncommittedChanges) => {
      // You could have uncommitted changes before unshelving, so we need to include
      // shelved changes AND the existing uncommitted changes.
      // But it's also possible to have changed a file changed by the commit, so we need to de-dupe.
      const newChanges = this.shelvedChange.filesSample.filter(
        file => !preexistingChanges.has(file.path),
      );
      return [...changes, ...newChanges];
    };
    return func;
  }
}
