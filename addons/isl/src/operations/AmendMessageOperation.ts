/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type {Dag} from '../previews';
import type {CommandArg, ExactRevset, Hash, OptimisticRevset, SucceedableRevset} from '../types';

import {Operation} from './Operation';

export class AmendMessageOperation extends Operation {
  constructor(
    public revset: SucceedableRevset | ExactRevset | OptimisticRevset,
    public message: string,
    public author?: string,
  ) {
    super('AmendMessageOperation');
  }

  static opName = 'AmendMessage';

  /** If the input revset refers to a specific commit hash, return it */
  getCommitHash(): Hash | undefined {
    if (this.revset.type === 'optimistic-revset') {
      return this.revset.fake;
    }
    if (/[a-fA-F0-9]{12,40}/.test(this.revset.revset)) {
      return this.revset.revset;
    }
    return undefined;
  }

  getArgs() {
    // git commit --amend --only --message works for HEAD only.
    // For non-HEAD commits this is a known limitation in the MVP.
    const args: Array<CommandArg> = ['commit', '--amend', '--only', '--message', this.message];
    if (this.author) {
      args.push('--author', this.author);
    }
    return args;
  }

  optimisticDag(dag: Dag): Dag {
    const hash = this.revset.revset;
    return dag.touch(hash).replaceWith(hash, (_h, c) => {
      if (c === undefined) {
        // metaedit succeeds when we no longer see original commit
        // Note: this assumes we always restack children and never render old commit as obsolete.
        return c;
      }
      const [title] = this.message.split(/\n+/, 1);
      const description = this.message.slice(title.length);
      return c?.merge({title, description});
    });
  }
}
