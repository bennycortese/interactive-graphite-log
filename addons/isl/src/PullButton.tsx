/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type {Operation} from './operations/Operation';

import {Button} from 'isl-components/Button';
import {ButtonDropdown} from 'isl-components/ButtonDropdown';
import {Icon} from 'isl-components/Icon';
import {DOCUMENTATION_DELAY, Tooltip} from 'isl-components/Tooltip';
import {useAtom, useAtomValue} from 'jotai';
import {fetchStableLocations} from './BookmarksData';
import {Internal} from './Internal';
import {commandRunnerMode} from './atoms/CommandRunnerModeState';
import {t, T} from './i18n';
import {configBackedAtom} from './jotaiUtils';
import {PullOperation} from './operations/PullOperation';
import {useRunOperation} from './operationsState';
import {uncommittedChangesWithPreviews, useMostRecentPendingOperation} from './previews';

import './PullButton.css';

const pullButtonChoiceKey = configBackedAtom<string>('isl.pull-button-choice', 'pull');

export type PullButtonOption = {
  id: string;
  label: React.ReactNode;
  getOperation: () => Operation;
  isRunning: (op: Operation) => boolean;
  tooltip: string;
  allowWithUncommittedChanges: boolean;
};

export function PullButton() {
  const runOperation = useRunOperation();
  const mode = useAtomValue(commandRunnerMode);

  const DEFAULT_PULL_BUTTON: PullButtonOption = {
    id: 'pull',
    label: <T>Pull</T>,
    getOperation: () => new PullOperation(mode),
    isRunning: (op: Operation) => op instanceof PullOperation,
    tooltip:
      mode === 'graphite'
        ? t('Sync with remote using `gt sync` — fetches and restacks stacked branches.')
        : t('Fetch latest repository and branch information from remote using `git fetch`.'),
    allowWithUncommittedChanges: true,
  };

  const pullButtonOptions: Array<PullButtonOption> = [];
  pullButtonOptions.push(DEFAULT_PULL_BUTTON, ...(Internal.additionalPullOptions ?? []));

  const [dropdownChoiceKey, setDropdownChoiceKey] = useAtom(pullButtonChoiceKey);
  const currentChoice =
    pullButtonOptions.find(option => option.id === dropdownChoiceKey) ?? pullButtonOptions[0];

  const trackedChanges = useAtomValue(uncommittedChangesWithPreviews).filter(
    change => change.status !== '?',
  );
  const hasUncommittedChanges = trackedChanges.length > 0;

  const disabledFromUncommittedChanges =
    currentChoice.allowWithUncommittedChanges === false && hasUncommittedChanges;

  let tooltip =
    currentChoice.tooltip +
    (disabledFromUncommittedChanges == false
      ? ''
      : '\n\n' + t('Disabled due to uncommitted changes.'));
  const pendingOperation = useMostRecentPendingOperation();
  const isRunningPull = pendingOperation != null && currentChoice.isRunning(pendingOperation);
  if (isRunningPull) {
    tooltip += '\n\n' + t('Pull is already running.');
  }

  return (
    <Tooltip placement="bottom" delayMs={DOCUMENTATION_DELAY} title={tooltip}>
      <div className="pull-info">
        {pullButtonOptions.length > 1 ? (
          <ButtonDropdown
            buttonDisabled={!!isRunningPull || disabledFromUncommittedChanges}
            options={pullButtonOptions}
            onClick={() => {
              runOperation(currentChoice.getOperation());
              fetchStableLocations();
            }}
            onChangeSelected={choice => setDropdownChoiceKey(choice.id)}
            selected={currentChoice}
            icon={<Icon slot="start" icon={isRunningPull ? 'loading' : 'repo'} />}
          />
        ) : (
          <Button
            disabled={!!isRunningPull}
            onClick={() => {
              runOperation(new PullOperation(mode));
              fetchStableLocations();
            }}>
            <Icon slot="start" icon={isRunningPull ? 'loading' : 'cloud-download'} />
            <T>Pull</T>
          </Button>
        )}
      </div>
    </Tooltip>
  );
}
