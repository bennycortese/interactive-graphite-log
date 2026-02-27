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
- `gt sync` (PullOperation), `gt submit --stack`, `gt restack`, `gt branch create --all -m`
- Git/Graphite mode toggle, Windows `.cmd` spawn fix
- **`gt branch checkout` for Goto** — `GotoBaseOperation` now accepts an optional `graphiteBranch` param. When set, uses `CommandRunner.Graphite` to run `gt branch checkout <name>`. `Commit.tsx:gotoAction` reads `commandRunnerMode` and passes `commit.bookmarks[0]` in graphite mode. Falls back to `git checkout` for hash-only destinations (DownloadCommitsMenu, GotoTimeMenu).
- **`gt modify` for Amend** — New `GraphiteModifyOperation` extends `AmendOperation` and uses `CommandRunner.Graphite` to run `gt modify --all --no-interactive` (or with `--message` when the commit message changes). `CommitInfoView.tsx` and `UncommittedChanges.tsx` check `commandRunnerMode` and dispatch `getGraphiteModifyOperation()` in graphite mode, falling back to `getAmendOperation()` (git) otherwise. Chunk-level partial amend falls back to git since `gt modify --patch` requires interactive input. `AmendOperation.filePathsToAmend` changed from `private` to `protected` to allow subclass access.
- **`gt branch create` audit** — Confirmed `gt create` and `gt branch create` are identical aliases. Updated `GraphiteCreateOperation` to use canonical `gt branch create` form (consistent with `gt branch checkout` pattern). Added `--no-interactive` flag to prevent interactive prompts in the non-interactive UI context. Args now: `['branch', 'create', '--all', '--no-interactive', '--message', msg]`.
- **`gt state` for smartlog metadata** — `gt log` does not support `--json`, but `gt state` outputs structured JSON with branch tracking data (trunk flag, `needs_restack`, parent refs). Added `parseGraphiteState()` and `applyGraphiteState()` to `templates.ts`. `fetchSmartlogCommits()` in `Repository.ts` now calls `gt state` after `git log` and overlays metadata onto `CommitInfo` objects. Branches needing restack get a "needs restack" badge via `stableCommitMetadata`. Gracefully degrades — if `gt` is not installed or fails, git-only data is used unchanged.

- **Granular restack operations** — Added `GraphiteUpstackRestackOperation` (`gt upstack restack --no-interactive`) and `GraphiteDownstackRestackOperation` (`gt downstack restack --no-interactive`). Wired into `StackActions.tsx` as context menu items ("Restack upstack" / "Restack downstack") alongside the existing full "Restack" button. Added corresponding `TrackEventName` entries. Upstack restacks current branch + descendants; downstack restacks trunk to current branch.

- **PR status via branch-to-PR matching** — `gt branch list --json` does not exist, so pivoted to using the existing `GitHubCodeReviewProvider` which already fetches PR data via GitHub GraphQL API. Added `getBranchToDiffIdMap()` to `GitHubCodeReviewProvider` (and as optional method on `CodeReviewProvider` interface) which maps branch names from cached PR summaries to their DiffId (PR number). Added `applyDiffIds()` helper in `templates.ts` that matches commits to PRs by comparing `commit.bookmarks` against the branch-to-diffId map. Called in `fetchSmartlogCommits()` after graphite state overlay. Also added a listener in the `Repository` constructor that re-applies diffIds when PR summaries arrive after the initial commit fetch, ensuring PR badges appear even when PR data loads asynchronously. This connects `commit.diffId` (previously hardcoded to `undefined`) to actual PR numbers, enabling the existing `DiffBadge` UI to render PR status (Open/Merged/Closed, CI status, review decision) next to each commit.

- **`gt fold` for Combine/Fold** — New `GraphiteFoldOperation` extends `FoldOperation` and uses `CommandRunner.Graphite` to run `gt fold --no-interactive`. Folds the current branch into its parent and restacks descendants — the Graphite-native way to combine adjacent branches in a stack. `fold.tsx` dispatches `GraphiteFoldOperation` when `commandRunnerMode === 'graphite'`, falling back to `FoldOperation` (git) otherwise. Git mode `FoldOperation.getArgs()` updated from broken Sapling `fold --exact REVSET` to `git reset --soft <parent-hash>` (collapses fold range into staged changes). `FoldOperation.foldRange` and message fields changed from `private` to `protected` for subclass access. Added `GraphiteFoldOperation` to `TrackEventName`.

- **`gt pop` for Uncommit** — New `GraphitePopOperation` extends `UncommitOperation` and uses `CommandRunner.Graphite` to run `gt pop --no-interactive`. Deletes the current branch but retains working tree changes — the Graphite-native way to uncommit while cleaning up branch metadata. `UncommitButton.tsx` checks `commandRunnerMode` and dispatches `GraphitePopOperation` in graphite mode, falling back to `UncommitOperation` (git) otherwise. Git mode `UncommitOperation.getArgs()` updated from broken Sapling `uncommit` to `git reset --soft HEAD~1`. Constructor fields changed from `private` to `protected` for subclass access. Added `GraphitePopOperation` to `TrackEventName`.

- **`gt delete` for Hide** — New `GraphiteDeleteOperation` extends `HideOperation` and uses `CommandRunner.Graphite` to run `gt delete <branch> --force --no-interactive`. Deletes the branch and its Graphite metadata, restacking children onto the parent — the Graphite-native way to hide/remove a branch from a stack. `HideOperation` updated to accept an optional `branchName` parameter: in git mode uses `git branch -D <name>` (falls back to no-op `git status` if no branch name available). All 3 UI dispatch points updated with mode-aware dispatch: `Commit.tsx` (context menu), `selection.ts` (keyboard shortcut), `Cleanup.tsx` (cleanup button + cleanup all). Each passes `commit.bookmarks[0]` as the branch name. Constructor fields changed from `private` to `protected` for subclass access. Added `GraphiteDeleteOperation` to `TrackEventName`.

- **Shelve → `git stash`** — Converted all three shelve operations from Sapling CLI to git stash equivalents. No `gt` equivalent exists for stashing. `ShelveOperation.getArgs()` updated from `sl shelve --unknown` to `git stash push --include-untracked` (with optional `-m name` and `-- files` for partial shelves). `UnshelveOperation.getArgs()` updated from `sl unshelve --keep --name` to `git stash apply/pop <stashRef>` (apply when keep=true, pop when keep=false). `DeleteShelveOperation.getArgs()` updated from `sl shelve --delete` to `git stash drop <stashRef>`. Added `stashRef` optional field to `ShelvedChange` type to identify stash entries by their git ref (e.g. `stash@{0}`). Implemented `getShelvedChanges()` on `Repository` using `git stash list --format=%H\t%at\t%s` to enumerate stash entries and `git stash show --name-status` for each entry's changed files. `ServerToClientAPI.ts` updated to call `repo.getShelvedChanges()` instead of returning an empty stub. Optimistic UI previews preserved from the original operations.

- **Graft → `git cherry-pick`** — `GraftOperation.getArgs()` updated from Sapling `graft <revset>` to `git cherry-pick <revset>`. No `gt` equivalent needed — cherry-pick is a git-level operation. Inline progress text updated from "grafting..." to "cherry-picking...". Used in `DownloadCommitsMenu.tsx` for copying public commits onto the current branch.

- **Bookmark operations → `git branch`** — `BookmarkCreateOperation.getArgs()` updated from Sapling `bookmark NAME --rev REV` to `git branch NAME REV`. `BookmarkDeleteOperation.getArgs()` updated from Sapling `bookmark --delete NAME` to `git branch -d NAME`. Both used in `Bookmark.tsx` — create via the "Create Bookmark" dialog, delete via the bookmark context menu. Optimistic DAG previews preserved from the original operations.

- **AddRemove → `git add`** — `AddRemoveOperation.getArgs()` updated from Sapling `addremove` to `git add -A` (all files) or `git add <files>` (specific files). Used in `UncommittedChanges.tsx` for the "Add/Remove" button that stages untracked files and removes missing files. Optimistic uncommitted changes preview preserved.

- **Push → `git push`** — `PushOperation.getArgs()` updated from Sapling `push --rev REVSET --to BRANCH` to `git push <remote> <branch>` (defaults remote to "origin"). Used in `BranchingPrModalContent.tsx` for pushing branches to remote. In graphite mode, `gt submit` already handles pushing — this operation is for the git-only push path.

### Planned (priority order)

#### Phase 1: Fix broken Sapling operations (high priority — these crash if triggered)

Many operations in `addons/isl/src/operations/` still emit Sapling CLI commands (`sl shelve`, `sl hide`, etc.) that don't exist in git/Graphite. These will error if a user triggers them through the UI. They need to be either **converted to git/Graphite equivalents** or **removed/disabled** if no equivalent exists.

For operations that have a `gt` equivalent, we should follow the same dual-mode pattern established by `GraphiteModifyOperation` etc.: create a Graphite operation class and dispatch it when `commandRunnerMode === 'graphite'`, falling back to the git version otherwise.

**Graphite CLI reference** (relevant commands):
- `gt fold` — Fold current branch into parent, restack descendants
- `gt delete [name] [--force] [--close]` — Delete branch + Graphite metadata, restack children onto parent
- `gt pop` — Delete current branch but keep working tree changes (≈ uncommit)
- `gt squash [-m msg] [--no-edit]` — Squash all commits in current branch into one, restack
- `gt move --onto <branch> [--source <branch>]` — Rebase branch onto target, restack descendants
- `gt absorb [--force] [--all]` — Amend staged changes to relevant commits in current stack
- `gt split [--by-commit | --by-hunk | --by-file <pathspec>]` — Split current branch into multiple
- `gt merge [--dry-run]` — Merge PRs from trunk to current branch via Graphite
- `gt continue` / `gt abort` — Continue/abort after rebase conflict
- `gt undo [--force]` — Undo most recent Graphite mutation
- `gt track [branch] [--parent <branch>]` — Start tracking a branch with Graphite
- `gt untrack [branch]` — Stop tracking a branch
- `gt rename [name]` — Rename a branch and update metadata

9. **AmendTo → `gt absorb`** — `AmendToOperation` uses Sapling `amend --to` (amend staged changes to a non-HEAD commit in the stack). Graphite has a powerful equivalent: `gt absorb --force --no-interactive` automatically distributes staged hunks to the right commits in the current stack. Create `GraphiteAbsorbOperation`. Git fallback: not directly possible without interactive rebase — could disable in git mode.

10. **Conflict handling → `gt continue` / `gt abort`** — `ContinueMergeOperation` uses `git rebase --continue` and `AbortMergeOperation` uses `git rebase --abort`. In graphite mode, should use `gt continue` and `gt abort` instead, since Graphite tracks rebase state and needs its own continue/abort to maintain metadata. Create `GraphiteContinueOperation` and `GraphiteAbortOperation`.

11. **Other broken operations to remove/stub** — `PullRevOperation` (pull specific rev — not a git/gt concept), `RebaseKeepOperation` (rebase with --keep — Sapling-specific), `RebaseAllDraftCommitsOperation` (uses `draft()` revset — no equivalent), `RunMergeDriversOperation` (uses `resolve --all` — Sapling-specific), `ImportStackOperation` (uses `debugimportstack` — Sapling-only), `CreateEmptyInitialCommitOperation` (niche, low priority). These should be stubbed to no-op or removed from the UI.

#### Phase 2: Leverage more Graphite stack features

12. **`gt move` for Rebase** — `RebaseOperation` uses `git rebase --onto`. Graphite equivalent: `gt move --onto <branch> --source <branch> --no-interactive` rebases the branch and automatically restacks all descendants. Create `GraphiteMoveOperation` that dispatches in graphite mode. This is better than raw `git rebase` because it maintains Graphite metadata and handles descendant restacking.

13. **`gt split` for Split** — The stack edit UI exists (`SplitStackEditPanel.tsx`) but split operations use Sapling internals. Graphite supports `gt split --by-file <pathspec>` non-interactively (the `--by-commit` and `--by-hunk` modes require interactive input). Wire `gt split --by-file` as a non-interactive split option in graphite mode.

14. **`gt squash` for multi-commit branches** — `gt squash [-m msg] [--no-edit] --no-interactive` squashes all commits in the current branch into one and restacks. Useful when a branch has accumulated fixup commits. Could add as a context menu action on branches with multiple commits.

15. **`gt merge` for landing PRs** — `gt merge` merges all PRs from trunk to the current branch via Graphite's merge queue. This is the Graphite-native way to land stacked PRs. Add a "Merge stack" button that runs `gt merge --no-interactive`. Supports `--dry-run` for previewing. This replaces the need for raw GitHub `mergePullRequest` API calls.

#### Phase 3: Improve code review integration

16. **PR comment replies** — The `DiffComments` component can display comments fetched from GitHub but there's no reply UI. Add a comment input box that calls `addComment` or `addPullRequestReviewComment` GitHub GraphQL mutation. This enables code review workflow entirely within the UI.

17. **Commit message ↔ PR description sync** — `enableMessageSyncing` is currently `false` in `GithubUICodeReviewProvider`. When enabled, amending a commit message could update the PR title/description via `updatePullRequest` mutation, and vice versa. Note: `gt submit` already syncs commit messages to PR descriptions — could just re-submit after amending.

18. **`gt undo` integration** — `gt undo --force --no-interactive` undoes the most recent Graphite mutation. Wire as an "Undo" button in the UI that appears after Graphite operations complete. Useful for recovering from accidental folds, deletes, or moves.

#### Phase 4: UX polish

19. **Trunk branch configuration** — Currently hardcoded to detect `origin/main` as the public base. `gt` already stores its trunk config (set via `gt init`). Read from `gt trunk` output or the Graphite config file to detect the trunk branch automatically. Add a fallback UI setting for non-Graphite repos.

20. **Stack grouping in UI** — `gt state` gives us parent-child branch relationships. Use this to visually group stacked branches in the commit graph (e.g., indentation, colored connectors, or collapsible stack sections).

21. **Conflict resolution improvements** — Currently merge conflicts are detected and shown, but resolution requires an external merge tool. In graphite mode, `gt continue` / `gt abort` should be surfaced prominently. Could add inline 3-way diff view or at minimum better guidance for resolving conflicts within the UI.
