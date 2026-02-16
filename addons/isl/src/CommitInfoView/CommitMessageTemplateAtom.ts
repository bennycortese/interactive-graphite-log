/**
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type {EditedMessage} from './types';

import {atom} from 'jotai';
import {firstLine} from 'shared/utils';
import serverAPI from '../ClientToServerAPI';
import {commitMessageFieldsSchema, parseCommitMessageFields} from './CommitMessageFields';
import {readAtom, writeAtom} from '../jotaiUtils';
import {registerCleanup, registerDisposable} from '../utils';

/**
 * Template for new commit messages, fetched from the server.
 * Defined in this file (not CommitInfoState) to break the circular dependency
 * between CodeReviewInfo and CommitInfoState:
 *   CodeReviewInfo → CommitInfoState → CodeReviewInfo (cycle)
 * is replaced by:
 *   CodeReviewInfo → CommitMessageTemplateAtom (no cycle)
 *   CommitInfoState → CommitMessageTemplateAtom (no cycle)
 */
export const commitMessageTemplate = atom<EditedMessage | undefined>(undefined);
registerDisposable(
  commitMessageTemplate,
  serverAPI.onMessageOfType('fetchedCommitMessageTemplate', event => {
    const title = firstLine(event.template);
    const description = event.template.slice(title.length + 1);
    const schema = readAtom(commitMessageFieldsSchema);
    const fields = parseCommitMessageFields(schema, title, description);
    writeAtom(commitMessageTemplate, fields);
  }),
  import.meta.hot,
);
registerCleanup(
  commitMessageTemplate,
  serverAPI.onSetup(() =>
    serverAPI.postMessage({
      type: 'fetchCommitMessageTemplate',
    }),
  ),
  import.meta.hot,
);
