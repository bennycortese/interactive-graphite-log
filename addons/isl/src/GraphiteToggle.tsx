/**
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import * as stylex from '@stylexjs/stylex';
import {Button} from 'isl-components/Button';
import {Tooltip} from 'isl-components/Tooltip';
import {useAtom} from 'jotai';
import {colors} from '../../components/theme/tokens.stylex';
import {commandRunnerMode} from './atoms/CommandRunnerModeState';
import {T} from './i18n';

const styles = stylex.create({
  graphiteActive: {
    backgroundColor: colors.blue,
    color: 'white',
    fontWeight: 'bold',
  },
  gitActive: {
    backgroundColor: 'transparent',
    fontWeight: 'bold',
  },
  label: {
    fontFamily: 'monospace',
    fontSize: '12px',
    letterSpacing: '0.02em',
    padding: '0 2px',
  },
});

/**
 * Toggle button in the top bar that switches between `git` and `gt` (Graphite CLI) modes.
 *
 * - **gt mode** (default): Stack-aware operations like Pull use `gt sync` which automatically
 *   restacks dependent branches. Future Graphite features (gt submit, gt create) will use this.
 * - **git mode**: All operations use raw `git` commands. Useful when Graphite CLI is not installed
 *   or you want bare git behavior.
 */
export function GraphiteToggle() {
  const [mode, setMode] = useAtom(commandRunnerMode);
  const isGraphite = mode === 'graphite';

  const toggleMode = () => {
    setMode(isGraphite ? 'git' : 'graphite');
  };

  return (
    <Tooltip
      placement="bottom"
      title={
        isGraphite ? (
          <T>
            Graphite mode: stack-aware operations use `gt` CLI (e.g. Pull runs `gt sync`). Click to
            switch to plain Git mode.
          </T>
        ) : (
          <T>
            Git mode: all operations use `git` CLI directly. Click to switch to Graphite mode which
            uses `gt sync` and other stack-aware commands.
          </T>
        )
      }>
      <Button
        icon
        xstyle={isGraphite ? styles.graphiteActive : styles.gitActive}
        onClick={toggleMode}
        data-command-runner-mode={mode}
        data-testid="command-runner-mode-toggle">
        <span {...stylex.props(styles.label)}>{isGraphite ? 'gt' : 'git'}</span>
      </Button>
    </Tooltip>
  );
}
