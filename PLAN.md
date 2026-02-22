# Interactive Graphite Log - Adaptation Plan

## Context

We're adapting Meta's Interactive Smartlog (ISL) to work with **Graphite** (`gt` CLI) instead of **Sapling** (`sl`). The ISL codebase lives in `addons/` as a Yarn monorepo with packages: `isl` (React frontend), `isl-server` (Node.js backend), `shared` (utilities), `components` (UI), and `vscode` (VS Code extension).

The core challenge: Sapling has a rich template/revset system (`sl log --template`, revsets like `smartlog()`, mutation tracking). Graphite sits on top of git and has no equivalent. Our strategy is to use **`git log --format=...`** for structured commit data, augmented with **Graphite stack metadata** where available.

---

## Design Decisions

1. **Commit data**: Use `git log --format=<custom>` with `COMMIT_END_MARK` separator (same parsing pattern as Sapling templates, just different placeholders)
2. **Phase detection**: Commits reachable from `origin/main` = `public`, others = `draft`
3. **Stack info**: Use Graphite branch names as "bookmarks" in the UI. Run `gt log` to annotate stack structure
4. **Graph scope**: Default to Graphite-tracked stacks, with a toggle to show all branches
5. **Pull/sync**: Use `gt sync` (Graphite-aware, handles restacking)
6. **No mutation tracking**: Git has no successor/predecessor tracking. Set `successorInfo`/`closestPredecessors` to `undefined` always
7. **Build target**: Browser-first (`yarn dev browser`). VSCode extension deferred
8. **MVP scope**: View commit graph, uncommitted changes, goto, commit, amend, pull/sync, rebase, diff viewing. Defer shelve, commitcloud, bookmarks, partial operations, blame

---

## Implementation Steps

### Step 1: Command Infrastructure
**File: `addons/isl-server/src/commands.ts`**

- `getExecParams()` (line 186-250): Remove `--noninteractive`, all Sapling env vars (`SL_AUTOMATION`, `HGENCODING`, `SL_ENCODING`, `HGUSER`, `HGEDITOR`, `SL_AUTOMATION_EXCEPT`), blackbox extension logic, watchman lock config, IPC progress config. Keep UTF-8 LANG setting. Set `GIT_EDITOR=false` instead of `HGEDITOR`
- `findRoot()` (line 98-115): Change from `['root']` to use `git rev-parse --show-toplevel`
- `findRoots()` (line 120-127): Return `[findRoot()]` (git doesn't have `debugroots`)
- `findDotDir()` (line 129-136): Change from `['root', '--dotdir']` to `git rev-parse --git-dir`
- `getConfigs()` (line 144-174): Replace `sl config -Tjson` with `git config --get` calls for the configs we actually need (mostly `remote.origin.url`)
- `setConfig()` (line 177-184): Change to `git config` syntax

### Step 2: Server Types
**File: `addons/isl-server/src/serverTypes.ts`**

- Update `RepositoryContext.cmd` documentation from `sl` to `git`
- Remove `cachedMergeTool` if Sapling-specific

### Step 3: Templates & Commit Parsing (CRITICAL)
**File: `addons/isl-server/src/templates.ts`**

This is the most critical rewrite.

- Replace `mainFetchTemplateFields()` (line 35-65): Define a `git log --format=` string instead of Sapling template. Map:

  | Sapling Template | Git Format | Notes |
  |---|---|---|
  | `{node}` | `%H` | Full commit hash |
  | `{desc\|firstline}` | `%s` | Subject line |
  | `{author}` | `%an <%ae>` | Author name + email |
  | `{committerdate\|isodatesec}` | `%cI` | ISO committer date |
  | `{phase}` | (derived) | Public if ancestor of remote, else draft |
  | `{bookmarks}` | from `%D` | Parse ref decorations for local branches |
  | `{remotenames}` | from `%D` | Parse ref decorations for remote branches |
  | `{parents}` | `%P` | Space-separated parent hashes |
  | `{isDot}` | compare vs HEAD | Check if hash matches HEAD |
  | `{files}` | separate call | `git diff-tree --name-only` |
  | `{desc}` | `%B` | Full commit body |
  | `successorInfo` | `undefined` | No git equivalent |
  | `closestPredecessors` | `undefined` | No git equivalent |
  | `isFollower` | `false` | No git equivalent |
  | `diffId` | from Graphite/PR | Extract from metadata |

- Rewrite `parseCommitInfoOutput()` (line 74-132): Parse the new git format. Key differences: `%P` uses spaces not null chars, `%D` encodes branch/remote info, phase is derived not a field

- Remove/stub shelve templates (`SHELVE_FIELDS`, `parseShelvedCommitsOutput`)
- Replace `CHANGED_FILES_FIELDS` with `git diff-tree --name-status` parsing

### Step 4: Repository Core (CRITICAL)
**File: `addons/isl-server/src/Repository.ts`**

This is the largest file with the most changes.

- `getRepoInfo()`: Replace `sl root` with `git rev-parse --show-toplevel`, `sl root --dotdir` with `git rev-parse --git-dir`. Remove Phabricator/EdenFS detection. Keep GitHub detection via `remote.origin.url` (already works)

- `fetchSmartlogCommits()`: Replace `sl log --template <template> --rev smartlog(...)` with a **dual-mode** approach:
  - **Default (Graphite stacks)**: Run `gt log` to identify tracked branches, then `git log --format=<format> <branch1> <branch2> ... --topo-order` for just those branches + their merge base with trunk
  - **All branches mode**: `git log --format=<format> --all --topo-order -n 100`
  - A toggle in the UI switches between modes (stored in local config)
  - Always include `origin/main` (or detected trunk) as the public base

- `fetchUncommittedChanges()`: Replace `sl status -Tjson --copies` with `git status --porcelain=v1 -z`. Parse porcelain status codes (`M`, `A`, `D`/`R`, `??`, `UU`)

- `checkForMergeConflicts()`: Check for `.git/MERGE_HEAD` or `.git/REBASE_HEAD` instead of `.sl/merge`. Parse `git status --porcelain` for `UU` entries

- `cat()`: Replace `sl cat <file> --rev <rev>` with `git show <rev>:<file>`

- `runDiff()`: Replace `sl diff --noprefix --no-binary --nodate --unified N` with `git diff --no-prefix --unified=N`

- `getAllChangedFiles()`: Replace `sl log --template <CHANGED_FILES_TEMPLATE>` with `git diff-tree --no-commit-id --name-status -r <hash>`

- `normalizeOperationArgs()`: Remove Sapling revset wrapping (`max(successors(...))`) for `succeedable-revset` and `optimistic-revset` args. Just pass hashes directly. Replace `listfile0:-` (Sapling stdin file list) with `--pathspec-from-file=-` or direct args

- Remove: `getShelvedChanges()`, `getCommitCloudState()`, `getRagePaste()`, `fetchSubmoduleMap()` (or stub)
- Remove: `getMergeToolEnvVars()` (Sapling-specific `HGMERGE`/`SL_MERGE`)
- Change `IGNORE_COMMIT_MESSAGE_LINES_REGEX` from `^((?:HG|SL):.*)\n?` to match git comment lines `^#`
- Change operation dispatch from `CommandRunner.Sapling` to new enum value

### Step 5: File Watching
**File: `addons/isl-server/src/WatchForChanges.ts`**

- Change `.sl/` directory watching to `.git/` watching. Watch for changes to:
  - `HEAD` (checkout changes)
  - `refs/` directory (branch changes)
  - `index` (staging area changes)
  - `MERGE_HEAD` / `REBASE_HEAD` (conflict state)
- Remove EdenFS notification support
- Change `WATCHMAN_DEFER` from `hg.update` to appropriate value or remove

### Step 6: Frontend Types
**File: `addons/isl/src/types.ts`**

- `CommandRunner` enum (line 462-473): Change `Sapling = 'sl'` to `Git = 'git'`, add `Graphite = 'gt'` for operations that need the gt CLI (e.g., sync, submit). Remove `InternalArcanist` and `Conf`
- `ValidatedRepoInfo` (line 226-252): Update docs, remove `isEdenFs`
- `RepositoryError` (line 198-210): Remove `edenFsUnhealthy` variant
- `PreferredSubmitCommand` (line 296): Change to `'submit'` for Graphite's `gt submit`
- Update config name lists to remove Sapling-specific configs

### Step 7: Operations
**Directory: `addons/isl/src/operations/`**

**Modify for git/graphite:**

| Operation | Current (Sapling) | New (Git/Graphite) |
|-----------|---------|-----|
| PullOperation | `['pull']` | Run as `gt sync` (Graphite-aware, handles restacking) |
| GotoBaseOperation | `['goto', '--rev', dest]` | `['checkout', dest]` |
| CommitBaseOperation | `['commit', '--addremove', '-m', msg]` | `['commit', '-a', '-m', msg]` |
| AmendOperation | `['amend', '--addremove']` | `['commit', '--amend', '-a']` |
| AmendMessageOperation | `['metaedit', '--rev', rev, '-m', msg]` | `['commit', '--amend', '-m', msg, '--allow-empty']` (HEAD only) |
| RebaseOperation | `['rebase', '-s', src, '-d', dest]` | `['rebase', '--onto', dest, src+'^']` |
| DiscardOperation | `['goto', '--clean', '.']` | `['checkout', '--', '.']` |
| PurgeOperation | `['purge', '--files']` | `['clean', '-f']` |
| AddOperation | `['add', file]` | `['add', file]` (same) |
| ForgetOperation | `['forget', file]` | `['rm', '--cached', file]` |
| AbortMergeOperation | `['rebase', '--abort']` | `['rebase', '--abort']` (same) |
| ContinueMergeOperation | `['continue']` | `['rebase', '--continue']` |

**Remove/stub (Sapling-specific, no Graphite equivalent):**
- BookmarkCreate/DeleteOperation
- CommitCloudSync/ChangeWorkspace/CreateWorkspaceOperation
- Shelve/Unshelve/DeleteShelveOperation
- HideOperation (mutation tracking)
- FoldOperation (interactive rebase)
- GraftOperation (cherry-pick, defer)
- ImportStackOperation (`debugimportstack`)
- PrSubmitOperation / GhStackSubmitOperation (replace with `gt submit` later)
- PullRevOperation, PushOperation, BulkRebaseOperation
- PartialCommit/PartialAmend/PartialDiscardOperation
- CreateEmptyInitialCommitOperation, AddRemoveOperation, UncommitOperation

### Step 8: Server API
**File: `addons/isl-server/src/ServerToClientAPI.ts`**

- Change default command from `'sl'` to `'git'`
- Remove/stub handlers for CommitCloud, Shelve, `debugimportstack` messages

### Step 9: Proxy Server
**File: `addons/isl-server/proxy/startServer.ts`**

- Change branding from "Sapling Web" to "Interactive Graphite Log"
- Change default command from `sl` to `git`
- Change env var from `SL` to `GT` or `GIT`

### Step 10: UI String Cleanup
**Across `addons/isl/src/`:**

- Search and replace "Sapling" references with "Graphite" or generic terms
- Remove UI for CommitCloud, Shelve, Bookmarks panels
- Adjust submit button to reference `gt submit`

---

## Build & Verification

### Building
```bash
cd addons
yarn install
# Development (browser mode):
yarn dev browser --launch /path/to/a/graphite-repo
# Production build:
cd isl && npx vite build
cd isl-server && npx rollup --config
```

### Testing Checklist
1. Build compiles without TypeScript errors
2. Server starts and connects to a git/graphite repository
3. Commit graph renders with correct parent-child relationships
4. HEAD commit is highlighted (isDot)
5. Draft vs public commits are visually distinguished
6. Uncommitted changes appear in the sidebar
7. `goto` (checkout) operation works
8. `commit` operation creates a new commit
9. `amend` operation amends the current commit
10. `pull` (sync) fetches from remote and restacks
11. Diff view shows file changes for selected commit

### Known Risks
- **Revsets**: All Sapling revset expressions must be eliminated. Git uses simple ref specs
- **Optimistic state**: Operations that create optimistic commits use Sapling revsets to resolve. For git, use simpler `HEAD` resolution after operations complete
- **IPC progress**: Sapling streams progress via IPC. Git does not. Operations will show spinner until complete
- **Partial operations**: Hunk-level commit/amend uses `debugimportstack`. Disabled for MVP; full-file operations work

---

## Architecture Notes

### Why this approach works
The ISL frontend is almost entirely data-driven -- it renders from `CommitInfo` objects and dispatches `Operation` commands. This means ~90% of the frontend React code works unchanged as long as we produce compatible `CommitInfo` data on the server side. The work is concentrated in the server layer (~5 key files).

### Key files by importance
1. `addons/isl-server/src/templates.ts` - Defines how commit data is fetched and parsed
2. `addons/isl-server/src/Repository.ts` - Main server logic, all SCM interactions
3. `addons/isl-server/src/commands.ts` - Command execution wrapper
4. `addons/isl/src/types.ts` - Type definitions and enums
5. `addons/isl/src/operations/*.ts` - Individual operation implementations

### What can be deleted entirely
Much of the ISL codebase handles Meta-internal features (Phabricator, CommitCloud, EdenFS, internal AI features). These can be aggressively removed. The `Internal` import pattern (used throughout) stubs to no-ops for OSS, so many internal features are already dead code.

### Graphite-specific opportunities (post-MVP)
- **Stack visualization**: Graphite's `gt log` shows stack structure. Parse this to add stack grouping in the UI
- **`gt submit`**: Replace submit flow to use Graphite's stacked PR creation
- **`gt create`**: Use instead of raw `git commit` to keep branches tracked in Graphite metadata
- **`gt restack`**: After amends, use instead of manual git rebase to maintain stacks

### Incremental strategy
Don't try to make everything work at once. The order of steps above is designed so each step produces a compilable (though possibly non-functional) codebase. Steps 3-4 (templates + Repository) are the critical pair that makes the commit graph render. Once those work, everything else is incremental improvement.

---

## Implementation Status

**All 10 steps completed** as of February 2026.

### What was done

**Step 1 — Command Infrastructure (`commands.ts`)**
- Removed all Sapling env vars (`SL_AUTOMATION`, `HGENCODING`, `HGUSER`, `HGEDITOR`, etc.)
- `findRoot()` → `git rev-parse --show-toplevel`
- `findDotDir()` → `git rev-parse --git-dir`
- `getConfigs()` → `git config --get` for `remote.origin.url`
- Set `GIT_EDITOR=false` instead of `HGEDITOR`

**Step 2 — Server Types (`serverTypes.ts`)**
- Updated `RepositoryContext.cmd` docs from `sl` to `git`
- Removed `cachedMergeTool` Sapling field

**Step 3 — Templates & Commit Parsing (`templates.ts`)**
- Replaced Sapling `--template` string with `git log --format=` using `%H`, `%s`, `%an <%ae>`, `%cI`, `%P`, `%D`, `%B`
- Phase detection: public if commit is ancestor of a remote tracking branch, else draft
- Rewrote `parseCommitInfoOutput()` to parse git format (space-separated parents from `%P`, branch refs from `%D`)
- `successorInfo`, `closestPredecessors` always `undefined` (no git equivalent)
- Removed shelve templates (`SHELVE_FIELDS`, `parseShelvedCommitsOutput`)
- `CHANGED_FILES_FIELDS` → `git diff-tree --name-status` parsing

**Step 4 — Repository Core (`Repository.ts`)**
- `getRepoInfo()`: `sl root` → `git rev-parse`, removed Phabricator/EdenFS detection
- `fetchSmartlogCommits()`: `sl log --rev smartlog(...)` → dual-mode `git log` (Graphite stacks default, all branches toggle)
- `fetchUncommittedChanges()`: `sl status -Tjson` → `git status --porcelain=v1 -z`
- `checkForMergeConflicts()`: `.sl/merge` → `.git/MERGE_HEAD` / `.git/REBASE_HEAD`
- `cat()`: `sl cat` → `git show <rev>:<file>`
- `runDiff()`: `sl diff` → `git diff --no-prefix`
- `getAllChangedFiles()`: → `git diff-tree --no-commit-id --name-status -r`
- `normalizeOperationArgs()`: removed Sapling revset wrapping; pass hashes directly
- `IGNORE_COMMIT_MESSAGE_LINES_REGEX`: `^((?:HG|SL):.*)\n?` → `^#.*\n?`
- **Removed entirely**: `blame()`, all CommitCloud methods, all SLOC methods, bookmark infrastructure (`fetchAndSetRecommendedBookmarks`, `pullRecommendedBookmarks`, etc.), `getActiveAlerts()`, `getRagePaste()`, EdenFS helpers (`isUnhealthyEdenFs`, `isEdenFsRepo`), all submodule tracking (`submodulesByRoot`, `fetchSubmoduleMap`, etc.)

**Step 5 — File Watching (`WatchForChanges.ts`)**
- Complete rewrite: removed all EdenFS imports and code paths
- `.sl/dirstate`, `.sl/bookmarks` watching → `.git/HEAD`, `.git/index`, `MERGE_HEAD`, `REBASE_HEAD`, `CHERRY_PICK_HEAD`
- `WATCHMAN_DEFER = 'hg.update'` → `''`
- Subscription names updated to `graphite-log-*`
- `poll()` simplified (no `isEdenFs` branch)

**Step 6 — Frontend Types (`types.ts`)**
- `CommandRunner`: `Sapling = 'sl'` → `Git = 'git'`, added `Graphite = 'gt'`, removed `InternalArcanist` and `Conf`
- `ValidatedRepoInfo`: removed `isEdenFs: boolean`
- `RepositoryError`: removed `edenFsUnhealthy` variant
- `PreferredSubmitCommand`: added `'submit'` for `gt submit`
- Removed Sapling-specific config names: `amend.autorestack`, `ui.merge`, `extensions.commitcloud`, etc.

**Step 7 — Operations (`operations/`)**

| File | Before | After |
|------|--------|-------|
| `Operation.tsx` | `CommandRunner.Sapling` | `CommandRunner.Git` |
| `GotoBaseOperation.ts` | `goto --rev` | `checkout` |
| `CommitBaseOperation.ts` | `commit --addremove` | `commit -a` |
| `AmendOperation.ts` | `amend --addremove` | `commit --amend -a --no-edit` |
| `AmendMessageOperation.ts` | `metaedit --rev` | `commit --amend --only --message` |
| `PullOperation.ts` | `pull` via Sapling | `sync` via `CommandRunner.Graphite` (`gt sync`) |
| `RebaseOperation.ts` | `rebase -s src -d dest` | `rebase --onto dest src` |
| `DiscardOperation.ts` | `goto --clean .` | `checkout -- .` |
| `PurgeOperation.ts` | `purge --files` | `clean -fd` |
| `ForgetOperation.ts` | `forget` | `rm --cached` |
| `ContinueMergeOperation.ts` | `continue` | `rebase --continue` |

**Step 8 — Server API (`ServerToClientAPI.ts`)**
- Default command: `'sl'` → `'git'` (all 3 call sites)
- `fetchShelvedChanges` → returns empty array stub
- `exportStack`/`importStack` → return error stubs (Sapling-only)
- `handleFetchCommitMessageTemplate` → returns empty template (removed `debugcommitmessage` call)

**Step 9 — Proxy Server (`startServer.ts`)**
- Branding: "Sapling Web" → "Interactive Graphite Log"
- Default command: `process.env.SL ?? 'sl'` → `process.env.GIT ?? process.env.GT ?? 'git'`
- Help text updated throughout

**Step 10 — UI String Cleanup**
- `App.tsx`: "Sapling repository" → "git repository"; removed `edenFsUnhealthy` error case; install link → `git-scm.com`
- `BugButton.tsx`: links → `graphite.dev/docs`, `github.com/withgraphite/graphite-cli/issues`
- `TopLevelErrors.tsx`, `CwdSelector.tsx`, `SettingsTooltip.tsx`: Sapling → git/Graphite
- `CommitInfoView.tsx`: submit description and link updated for Graphite
- `CommandHistoryAndProgress.tsx`: `CommandRunner.Sapling` → `Git`/`Graphite` cases
- All `__tests__/` files: bulk replaced `CommandRunner.Sapling` → `CommandRunner.Git`

### Current state

The codebase compiles and all Sapling command references have been replaced with git/Graphite equivalents.

**Bug fix applied**: Windows `spawn('gt', ...)` was failing with ENOENT because `gt` is a `.cmd` wrapper (npm install). Fixed in `addons/shared/ejeca.ts` by adding `shell: true` on Windows so `spawn` can resolve `.cmd`/`.bat` files.

---

## Next: Extend Graphite Support

### Already done
- `gt sync` (PullOperation), `gt submit --stack`, `gt restack`, `gt create --all -m`
- Git/Graphite mode toggle, Windows `.cmd` spawn fix
- **`gt branch checkout` for Goto** — `GotoBaseOperation` now accepts an optional `graphiteBranch` param. When set, uses `CommandRunner.Graphite` to run `gt branch checkout <name>`. `Commit.tsx:gotoAction` reads `commandRunnerMode` and passes `commit.bookmarks[0]` in graphite mode. Falls back to `git checkout` for hash-only destinations (DownloadCommitsMenu, GotoTimeMenu).
- **`gt modify` for Amend** — New `GraphiteModifyOperation` extends `AmendOperation` and uses `CommandRunner.Graphite` to run `gt modify --all --no-interactive` (or with `--message` when the commit message changes). `CommitInfoView.tsx` and `UncommittedChanges.tsx` check `commandRunnerMode` and dispatch `getGraphiteModifyOperation()` in graphite mode, falling back to `getAmendOperation()` (git) otherwise. Chunk-level partial amend falls back to git since `gt modify --patch` requires interactive input. `AmendOperation.filePathsToAmend` changed from `private` to `protected` to allow subclass access.

### Planned (priority order)

1. **`gt branch create` audit** — Verify GraphiteCreateOperation args match current CLI. Newer GT versions use `gt branch create` instead of `gt create`. Check and update if needed.

2. **`gt log --json` for smartlog** — Commit graph fetching uses raw `git log`. Optionally use `gt log --json` to get Graphite-aware stack info (parent tracking, PR status) for richer UI without needing the GitHub API.

3. **Granular restack operations** — Add `gt upstack restack` / `gt downstack restack` as options beyond the current full `gt restack`, useful for the stack actions UI.

4. **PR status via `gt branch list --json`** — Returns PR merge/review status per branch. Could feed into the code review sidebar without separate GitHub API calls.
