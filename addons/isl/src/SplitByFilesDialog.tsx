/**
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type {CommitInfo, RepoRelativePath} from './types';

import * as stylex from '@stylexjs/stylex';
import {Button} from 'isl-components/Button';
import {Checkbox} from 'isl-components/Checkbox';
import {Icon} from 'isl-components/Icon';
import {useState, useEffect} from 'react';
import {Row} from './ComponentUtils';
import {getChangedFilesForHash} from './ChangedFilesWithFetching';
import {T, t} from './i18n';
import {useRunOperation} from './operationsState';
import {GraphiteSplitOperation} from './operations/GraphiteSplitOperation';
import {showModal} from './useModal';

const styles = stylex.create({
  fileList: {
    maxHeight: '400px',
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    padding: '8px 0',
  },
  fileRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  statusIcon: {
    width: '16px',
    textAlign: 'center',
    fontWeight: 'bold',
  },
  filePath: {
    fontFamily: 'var(--monospace-font-family, monospace)',
    fontSize: '12px',
  },
  actions: {
    display: 'flex',
    gap: '8px',
    justifyContent: 'flex-end',
    paddingTop: '12px',
  },
  selectActions: {
    display: 'flex',
    gap: '8px',
    paddingBottom: '4px',
  },
  description: {
    paddingBottom: '8px',
    opacity: 0.8,
  },
  loading: {
    padding: '20px',
    textAlign: 'center',
  },
});

const STATUS_LABELS: Record<string, string> = {
  A: 'A',
  M: 'M',
  R: 'R',
  '?': '?',
  '!': '!',
  U: 'U',
};

const STATUS_COLORS: Record<string, string> = {
  A: 'var(--signal-success-foreground, green)',
  M: 'var(--signal-info-foreground, blue)',
  R: 'var(--signal-error-foreground, red)',
};

/**
 * Show a modal dialog to select files for `gt split --by-file`.
 * Returns the selected file paths, or undefined if cancelled.
 */
export async function showSplitByFilesDialog(commit: CommitInfo): Promise<RepoRelativePath[] | undefined> {
  return showModal<RepoRelativePath[]>({
    type: 'custom',
    title: <T>Split by files (Graphite)</T>,
    width: 500,
    maxHeight: 600,
    component: ({returnResultAndDismiss}) => (
      <SplitByFilesContent commit={commit} returnResultAndDismiss={returnResultAndDismiss} />
    ),
  });
}

function SplitByFilesContent({
  commit,
  returnResultAndDismiss,
}: {
  commit: CommitInfo;
  returnResultAndDismiss: (data: RepoRelativePath[] | undefined) => void;
}) {
  const runOperation = useRunOperation();
  const [files, setFiles] = useState<Array<{path: string; status: string}> | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getChangedFilesForHash(commit.hash, undefined).then(result => {
      if (result.value != null) {
        const changedFiles = result.value.filesSample.map(f => ({
          path: f.path,
          status: f.status,
        }));
        setFiles(changedFiles);
      } else if (result.error != null) {
        setError(result.error.message);
      }
    });
  }, [commit.hash]);

  if (error != null) {
    return (
      <div>
        <div {...stylex.props(styles.description)}>
          <T>Failed to load changed files: </T>
          {error}
        </div>
        <div {...stylex.props(styles.actions)}>
          <Button onClick={() => returnResultAndDismiss(undefined)}>
            <T>Close</T>
          </Button>
        </div>
      </div>
    );
  }

  if (files == null) {
    return (
      <div {...stylex.props(styles.loading)}>
        <Icon icon="loading" />
        <T> Loading changed files...</T>
      </div>
    );
  }

  const toggleFile = (path: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  const selectAll = () => setSelected(new Set(files.map(f => f.path)));
  const selectNone = () => setSelected(new Set());

  const handleSplit = () => {
    const paths = Array.from(selected);
    runOperation(new GraphiteSplitOperation(paths));
    returnResultAndDismiss(paths);
  };

  return (
    <div>
      <div {...stylex.props(styles.description)}>
        <T>Select files to move to a new branch. Remaining files stay in the current branch.</T>
      </div>
      <div {...stylex.props(styles.selectActions)}>
        <Button kind="icon" onClick={selectAll}>
          <T>Select all</T>
        </Button>
        <Button kind="icon" onClick={selectNone}>
          <T>Select none</T>
        </Button>
      </div>
      <div {...stylex.props(styles.fileList)}>
        {files.map(file => (
          <Row key={file.path} {...stylex.props(styles.fileRow)}>
            <Checkbox
              checked={selected.has(file.path)}
              onChange={() => toggleFile(file.path)}
            />
            <span
              {...stylex.props(styles.statusIcon)}
              style={{color: STATUS_COLORS[file.status]}}>
              {STATUS_LABELS[file.status] ?? file.status}
            </span>
            <span {...stylex.props(styles.filePath)}>{file.path}</span>
          </Row>
        ))}
      </div>
      <div {...stylex.props(styles.actions)}>
        <Button onClick={() => returnResultAndDismiss(undefined)}>
          <T>Cancel</T>
        </Button>
        <Button
          primary
          disabled={selected.size === 0 || selected.size === files.length}
          onClick={handleSplit}>
          <T replace={{$count: selected.size}}>Split $count files to new branch</T>
        </Button>
      </div>
    </div>
  );
}
