/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type {Dag} from '../previews';
import type {CommitInfo} from '../types';

import {firstLine} from 'shared/utils';
import {CommitPreview} from '../previews';
import {Operation} from './Operation';

/**
 * Returns [bottom, top] of an array.
 */
function ends<T>(range: Array<T>): [T, T] {
  return [range[0], range[range.length - 1]];
}

export class FoldOperation extends Operation {
  constructor(
    protected foldRange: Array<CommitInfo>,
    newMessage: string,
  ) {
    super('FoldOperation');
    this.newTitle = firstLine(newMessage);
    this.newDescription = newMessage.substring(firstLine(newMessage).length + 1);
  }
  protected newTitle: string;
  protected newDescription: string;

  static opName = 'Fold';

  /**
   * Git mode: use `git reset --soft <parent-of-bottom>` to collapse the
   * fold range into staged changes. This is a partial fold — the user will
   * see the changes as uncommitted and can commit with the desired message.
   *
   * For a full fold experience, use graphite mode (`gt fold`).
   */
  getArgs() {
    const [bottom] = ends(this.foldRange);
    const parentHash = bottom.parents[0];
    return [
      'reset',
      '--soft',
      parentHash,
    ];
  }

  public getFoldRange(): Array<CommitInfo> {
    return this.foldRange;
  }
  public getFoldedMessage(): [string, string] {
    return [this.newTitle, this.newDescription];
  }

  previewDag(dag: Dag): Dag {
    return this.calculateDagPreview(dag, true);
  }

  optimisticDag(dag: Dag): Dag {
    return this.calculateDagPreview(dag, false);
  }

  private calculateDagPreview(dag: Dag, isPreview: boolean): Dag {
    const hashes = this.foldRange.map(info => info.hash);
    const top = hashes.at(-1);
    const parents = dag.get(hashes.at(0))?.parents;
    if (top == null || parents == null) {
      return dag;
    }
    const hash = getFoldRangeCommitHash(this.foldRange, isPreview);
    const bookmarks = hashes.flatMap(h => dag.get(h)?.bookmarks ?? []).sort();
    return dag
      .replaceWith(hashes, (h, c) => {
        if (h !== top && c == null) {
          return undefined;
        }
        return c?.merge({
          date: new Date(),
          hash,
          bookmarks,
          title: this.newTitle,
          description: this.newDescription,
          previewType: isPreview ? CommitPreview.FOLD_PREVIEW : CommitPreview.FOLD,
          parents,
        });
      })
      .replaceWith(dag.children(top), (_h, c) => {
        return c?.set(
          'parents',
          c.parents.map(p => (p === top ? hash : p)),
        );
      });
  }
}

export const FOLD_COMMIT_PREVIEW_HASH_PREFIX = 'OPTIMISTIC_FOLDED_PREVIEW_';
export const FOLD_COMMIT_OPTIMISTIC_HASH_PREFIX = 'OPTIMISTIC_FOLDED_';
export function getFoldRangeCommitHash(range: Array<CommitInfo>, isPreview: boolean): string {
  const [bottom, top] = ends(range);
  return (
    (isPreview ? FOLD_COMMIT_PREVIEW_HASH_PREFIX : FOLD_COMMIT_OPTIMISTIC_HASH_PREFIX) +
    `${bottom.hash}:${top.hash}`
  );
}
