# Workspace Mode Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new per-session `Workspace` mode that coexists with the current terminal workflow, with a desktop-style experience on desktop and an iOS-style experience on mobile.

**Architecture:** Extend the existing session model so each connected host can render either `Terminal` or `Workspace` without creating a separate connection lifecycle. Build Workspace as a small set of focused app modules (`Overview`, `Files`, `Processes`, `Services`, `Logs`) backed by shared session state and platform-specific layout containers.

**Tech Stack:** React 19, TypeScript, Vite, Tailwind CSS, Tauri frontend APIs, existing ShellBeam session/host/vault contexts, Vitest + Testing Library for new UI/state tests.

---

## File Structure

### Existing files to modify

- `package.json`
  - Add test scripts and frontend test dependencies.
- `vite.config.ts`
  - Add test environment configuration if needed.
- `src/lib/types.ts`
  - Extend session and workspace-related type definitions.
- `src/contexts/sessions-context.tsx`
  - Persist and expose per-session view mode and workspace navigation state.
- `src/layouts/pc-layout.tsx`
  - Render `Terminal` and `Workspace` as sibling session modes on desktop and mobile.
- `src/components/pc-tab-bar.tsx`
  - Add session-level mode switching affordances for desktop.
- `src/components/mobile-session-header.tsx`
  - Add mobile session-level mode switching affordances.
- `src/components/pc-nav-sidebar.tsx`
  - Decide how global app nav and session-level workspace nav coexist visually.
- `src/lib/locales/en.ts`
  - Add Workspace labels and copy.
- `src/lib/locales/zh-CN.ts`
  - Add Workspace labels and copy.
- `src/index.css`
  - Add any reusable workspace surface styles if component-local classes become too noisy.

### New files to create

- `src/lib/workspace.ts`
  - Shared workspace constants, mode defaults, app registry, and pure helpers.
- `src/lib/workspace-recommendations.ts`
  - Rule-based recommendation helpers for `Overview`.
- `src/components/workspace/workspace-shell.tsx`
  - Common shell entry that chooses desktop vs mobile presentation.
- `src/components/workspace/workspace-desktop-shell.tsx`
  - Desktop workspace frame with side navigation and header.
- `src/components/workspace/workspace-mobile-shell.tsx`
  - iOS-style mobile workspace frame.
- `src/components/workspace/workspace-mode-toggle.tsx`
  - Reusable `Terminal | Workspace` segmented control.
- `src/components/workspace/workspace-overview.tsx`
  - Shared overview content.
- `src/components/workspace/workspace-app-grid.tsx`
  - App launcher grid used by both desktop and mobile.
- `src/components/workspace/workspace-status-cards.tsx`
  - Status cards used by overview surfaces.
- `src/components/workspace/workspace-activity-feed.tsx`
  - Recent activity list for overview.
- `src/components/workspace/workspace-files-app.tsx`
  - Workspace wrapper around the current remote file experience.
- `src/components/workspace/workspace-processes-app.tsx`
  - P0 process-management UI shell.
- `src/components/workspace/workspace-services-app.tsx`
  - P0 systemd services UI shell.
- `src/components/workspace/workspace-logs-app.tsx`
  - P0 log viewer UI shell.
- `src/components/workspace/workspace-empty-state.tsx`
  - Shared unsupported/empty-state block.
- `src/components/workspace/index.ts`
  - Re-export barrel for workspace modules.
- `src/test/setup.ts`
  - Testing Library and DOM test setup.
- `src/lib/workspace.test.ts`
  - Unit tests for workspace helpers.
- `src/components/workspace/workspace-overview.test.tsx`
  - Rendering and interaction tests for overview.
- `src/contexts/sessions-context.workspace.test.tsx`
  - State-level tests for per-session mode persistence.

### Optional follow-up files if P0 wrappers get too large

- `src/components/workspace/workspace-process-table.tsx`
- `src/components/workspace/workspace-services-list.tsx`
- `src/components/workspace/workspace-log-stream.tsx`

Keep these out of the first pass unless component size grows too quickly.

## Chunk 1: Test Harness And Workspace Domain Model

### Task 1: Add frontend test tooling

**Files:**
- Modify: `package.json`
- Modify: `vite.config.ts`
- Create: `src/test/setup.ts`

- [ ] **Step 1: Write the failing config expectation down in the plan branch notes**

Expected behavior:
- `npm test` should run a frontend test runner
- React component tests should run in a DOM-like environment

- [ ] **Step 2: Add failing test script references**

Update `package.json` with scripts like:

```json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest"
  }
}
```

Do not add implementation-only tooling without a runnable script.

- [ ] **Step 3: Add minimal test dependencies**

Add dev dependencies:

```json
{
  "vitest": "^3.0.0",
  "@testing-library/react": "^16.0.0",
  "@testing-library/jest-dom": "^6.0.0",
  "jsdom": "^26.0.0"
}
```

Use current compatible versions during implementation.

- [ ] **Step 4: Add test environment setup**

Create `src/test/setup.ts`:

```ts
import '@testing-library/jest-dom'
```

Update `vite.config.ts`:

```ts
test: {
  environment: 'jsdom',
  setupFiles: './src/test/setup.ts',
}
```

- [ ] **Step 5: Run the empty test command**

Run: `npm test`

Expected:
- The command runs Vitest successfully
- It reports no tests found or failing tests added later

- [ ] **Step 6: Commit**

```bash
git add package.json vite.config.ts src/test/setup.ts
git commit -m "test: add frontend test harness"
```

### Task 2: Define workspace domain types and pure helpers

**Files:**
- Modify: `src/lib/types.ts`
- Create: `src/lib/workspace.ts`
- Test: `src/lib/workspace.test.ts`

- [ ] **Step 1: Write the failing unit tests for workspace defaults**

Create `src/lib/workspace.test.ts` with cases like:

```ts
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_WORKSPACE_APP,
  DEFAULT_WORKSPACE_MODE,
  getInitialWorkspaceSessionState,
  isWorkspaceApp,
} from './workspace'

describe('workspace helpers', () => {
  it('returns terminal as the default session mode', () => {
    expect(DEFAULT_WORKSPACE_MODE).toBe('terminal')
  })

  it('creates a fresh session workspace state', () => {
    expect(getInitialWorkspaceSessionState()).toEqual({
      mode: 'terminal',
      activeApp: 'overview',
    })
  })

  it('validates known workspace apps', () => {
    expect(isWorkspaceApp('logs')).toBe(true)
    expect(isWorkspaceApp('bogus')).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test to verify failure**

Run: `npm test -- src/lib/workspace.test.ts`

Expected:
- FAIL because `src/lib/workspace.ts` does not exist yet

- [ ] **Step 3: Add the shared workspace module**

Create `src/lib/workspace.ts` with:

```ts
export const WORKSPACE_APPS = ['overview', 'files', 'processes', 'services', 'logs', 'terminal'] as const
export type WorkspaceAppId = (typeof WORKSPACE_APPS)[number]

export type SessionWorkspaceMode = 'terminal' | 'workspace'

export interface SessionWorkspaceState {
  mode: SessionWorkspaceMode
  activeApp: WorkspaceAppId
}

export const DEFAULT_WORKSPACE_MODE: SessionWorkspaceMode = 'terminal'
export const DEFAULT_WORKSPACE_APP: WorkspaceAppId = 'overview'

export function getInitialWorkspaceSessionState(): SessionWorkspaceState {
  return { mode: DEFAULT_WORKSPACE_MODE, activeApp: DEFAULT_WORKSPACE_APP }
}

export function isWorkspaceApp(value: string): value is WorkspaceAppId {
  return (WORKSPACE_APPS as readonly string[]).includes(value)
}
```

- [ ] **Step 4: Extend shared app types**

Update `src/lib/types.ts` to include:

```ts
import type { SessionWorkspaceMode, WorkspaceAppId } from '@/lib/workspace'

export interface SessionTab {
  sessionId: string
  hostName: string
  hostAddress: string
  status: 'connecting' | 'connected' | 'closed' | 'error' | 'reconnecting'
  mode?: SessionWorkspaceMode
  workspaceApp?: WorkspaceAppId
}
```

If circular imports become awkward, move workspace-specific session types into `src/lib/types.ts` instead and keep `workspace.ts` pure.

- [ ] **Step 5: Run the tests**

Run: `npm test -- src/lib/workspace.test.ts`

Expected:
- PASS

- [ ] **Step 6: Commit**

```bash
git add src/lib/types.ts src/lib/workspace.ts src/lib/workspace.test.ts
git commit -m "feat: add workspace session domain model"
```

## Chunk 2: Session State And Mode Switching

### Task 3: Add per-session workspace state to `SessionsProvider`

**Files:**
- Modify: `src/contexts/sessions-context.tsx`
- Test: `src/contexts/sessions-context.workspace.test.tsx`

- [ ] **Step 1: Write the failing sessions-context tests**

Cover these behaviors:

```ts
it('initializes a new session in terminal mode with overview selected')
it('switches a session between terminal and workspace without affecting other sessions')
it('remembers the active workspace app per session')
it('removes workspace state when a session is closed')
```

Use a small harness component around `SessionsProvider`.

- [ ] **Step 2: Run the tests to verify failure**

Run: `npm test -- src/contexts/sessions-context.workspace.test.tsx`

Expected:
- FAIL because the workspace APIs do not exist yet

- [ ] **Step 3: Add workspace session state to the context value**

In `src/contexts/sessions-context.tsx`, add:

```ts
workspaceBySession: Record<string, SessionWorkspaceState>
setSessionMode: (sessionId: string, mode: SessionWorkspaceMode) => void
setSessionWorkspaceApp: (sessionId: string, app: WorkspaceAppId) => void
```

- [ ] **Step 4: Initialize workspace state with new sessions**

When a tab/session is created, attach default workspace state:

```ts
setWorkspaceBySession((prev) => ({
  ...prev,
  [sessionId]: getInitialWorkspaceSessionState(),
}))
```

- [ ] **Step 5: Keep tab metadata in sync**

When session mode or app changes, mirror it into `pcSessionTabs` so UI consumers can read current mode cheaply.

- [ ] **Step 6: Remove stale workspace state on close**

When `handleCloseSessionTab` or cleanup runs, remove the session key from `workspaceBySession`.

- [ ] **Step 7: Run the tests**

Run: `npm test -- src/contexts/sessions-context.workspace.test.tsx`

Expected:
- PASS

- [ ] **Step 8: Run targeted lint/build checks**

Run:
- `npm test -- src/lib/workspace.test.ts src/contexts/sessions-context.workspace.test.tsx`
- `npm run lint`

Expected:
- PASS

- [ ] **Step 9: Commit**

```bash
git add src/contexts/sessions-context.tsx src/contexts/sessions-context.workspace.test.tsx
git commit -m "feat: add per-session workspace mode state"
```

### Task 4: Build a reusable mode toggle component

**Files:**
- Create: `src/components/workspace/workspace-mode-toggle.tsx`
- Modify: `src/components/pc-tab-bar.tsx`
- Modify: `src/components/mobile-session-header.tsx`

- [ ] **Step 1: Write a failing render test for the toggle**

Add a small test inline with the component or in `workspace-overview.test.tsx`:

```tsx
it('renders terminal and workspace options and calls onChange')
```

- [ ] **Step 2: Run the test to verify failure**

Run: `npm test -- src/components/workspace/workspace-overview.test.tsx`

Expected:
- FAIL because the toggle component does not exist yet

- [ ] **Step 3: Create the shared toggle**

Build `workspace-mode-toggle.tsx` as a segmented control:

```tsx
interface WorkspaceModeToggleProps {
  mode: SessionWorkspaceMode
  onChange: (mode: SessionWorkspaceMode) => void
}
```

- [ ] **Step 4: Add the toggle to desktop session chrome**

Update `src/components/pc-tab-bar.tsx` so the active session exposes a compact `Terminal | Workspace` switch without cluttering inactive tabs.

- [ ] **Step 5: Add the toggle to mobile session chrome**

Update `src/components/mobile-session-header.tsx` with a compact toggle below or within the header bar that still feels native on mobile.

- [ ] **Step 6: Run focused tests**

Run: `npm test -- src/components/workspace/workspace-overview.test.tsx`

Expected:
- PASS

- [ ] **Step 7: Commit**

```bash
git add src/components/workspace/workspace-mode-toggle.tsx src/components/pc-tab-bar.tsx src/components/mobile-session-header.tsx
git commit -m "feat: add terminal and workspace mode switchers"
```

## Chunk 3: Workspace Shells And Overview

### Task 5: Add the top-level workspace shell

**Files:**
- Create: `src/components/workspace/index.ts`
- Create: `src/components/workspace/workspace-shell.tsx`
- Create: `src/components/workspace/workspace-desktop-shell.tsx`
- Create: `src/components/workspace/workspace-mobile-shell.tsx`
- Modify: `src/layouts/pc-layout.tsx`

- [ ] **Step 1: Write a failing integration test for workspace rendering**

Cover:

```tsx
it('renders workspace instead of terminal when the active session is in workspace mode')
it('uses desktop shell on md and above')
it('uses mobile shell below md')
```

- [ ] **Step 2: Run the test to verify failure**

Run: `npm test -- src/components/workspace/workspace-overview.test.tsx`

Expected:
- FAIL because the shell components do not exist yet

- [ ] **Step 3: Create the shell switcher**

In `workspace-shell.tsx`:

```tsx
export function WorkspaceShell(props: WorkspaceShellProps) {
  return isMobile ? <WorkspaceMobileShell {...props} /> : <WorkspaceDesktopShell {...props} />
}
```

- [ ] **Step 4: Add desktop and mobile frames**

Desktop shell responsibilities:
- Host-aware top bar
- Left app nav
- Main content region

Mobile shell responsibilities:
- Large-title style header
- Top status surface
- App grid / drill-in layout

- [ ] **Step 5: Route session rendering through the new shell**

Modify `src/layouts/pc-layout.tsx` so each active session chooses between:
- `SessionTerminalView`
- `WorkspaceShell`

based on the session mode from `useSessions()`.

- [ ] **Step 6: Keep inactive terminal sessions mounted**

Do not break the existing terminal buffering/reconnect behavior. Hidden terminal sessions should still preserve current behavior.

- [ ] **Step 7: Run tests and lint**

Run:
- `npm test -- src/components/workspace/workspace-overview.test.tsx`
- `npm run lint`

Expected:
- PASS

- [ ] **Step 8: Commit**

```bash
git add src/components/workspace/index.ts src/components/workspace/workspace-shell.tsx src/components/workspace/workspace-desktop-shell.tsx src/components/workspace/workspace-mobile-shell.tsx src/layouts/pc-layout.tsx
git commit -m "feat: add workspace shell for desktop and mobile"
```

### Task 6: Implement the shared overview screen

**Files:**
- Create: `src/components/workspace/workspace-overview.tsx`
- Create: `src/components/workspace/workspace-app-grid.tsx`
- Create: `src/components/workspace/workspace-status-cards.tsx`
- Create: `src/components/workspace/workspace-activity-feed.tsx`
- Create: `src/components/workspace/workspace-empty-state.tsx`
- Create: `src/lib/workspace-recommendations.ts`
- Test: `src/components/workspace/workspace-overview.test.tsx`

- [ ] **Step 1: Write the failing overview tests**

Cover:

```tsx
it('shows the workspace app launcher')
it('shows status cards for the current host')
it('shows recent activity entries when available')
it('navigates to a selected workspace app')
it('renders recommendations from rule-based helpers')
```

- [ ] **Step 2: Run the tests to verify failure**

Run: `npm test -- src/components/workspace/workspace-overview.test.tsx`

Expected:
- FAIL because overview pieces do not exist yet

- [ ] **Step 3: Add the app grid and status cards**

Use shared props:

```tsx
interface WorkspaceOverviewProps {
  hostName: string
  hostAddress: string
  activeApp: WorkspaceAppId
  onSelectApp: (app: WorkspaceAppId) => void
}
```

- [ ] **Step 4: Add rule-based recommendations**

In `src/lib/workspace-recommendations.ts`, create pure helpers such as:

```ts
export function getWorkspaceRecommendations(input: RecommendationInput): WorkspaceRecommendation[] {
  // simple status-driven suggestions
}
```

- [ ] **Step 5: Wire activity and host-derived data**

Reuse existing history/activity primitives instead of inventing new persistence.

- [ ] **Step 6: Run tests**

Run: `npm test -- src/components/workspace/workspace-overview.test.tsx`

Expected:
- PASS

- [ ] **Step 7: Commit**

```bash
git add src/components/workspace/workspace-overview.tsx src/components/workspace/workspace-app-grid.tsx src/components/workspace/workspace-status-cards.tsx src/components/workspace/workspace-activity-feed.tsx src/components/workspace/workspace-empty-state.tsx src/lib/workspace-recommendations.ts src/components/workspace/workspace-overview.test.tsx
git commit -m "feat: add workspace overview experience"
```

## Chunk 4: P0 Workspace Apps

### Task 7: Add the Files workspace app

**Files:**
- Create: `src/components/workspace/workspace-files-app.tsx`
- Modify: `src/components/workspace/workspace-desktop-shell.tsx`
- Modify: `src/components/workspace/workspace-mobile-shell.tsx`
- Possibly reuse: `src/components/sftp-dual-pane.tsx`

- [ ] **Step 1: Write a failing rendering test**

Cover:

```tsx
it('shows the files app when selected from workspace')
it('renders a terminal handoff action from files')
```

- [ ] **Step 2: Run the test**

Run: `npm test -- src/components/workspace/workspace-overview.test.tsx`

Expected:
- FAIL

- [ ] **Step 3: Create the wrapper app**

Use the existing file-management experience as the core, but wrap it with Workspace-specific header and terminal handoff CTA.

- [ ] **Step 4: Route app selection**

Update the workspace shells to render `workspace-files-app` for `activeApp === 'files'`.

- [ ] **Step 5: Run tests and lint**

Run:
- `npm test -- src/components/workspace/workspace-overview.test.tsx`
- `npm run lint`

- [ ] **Step 6: Commit**

```bash
git add src/components/workspace/workspace-files-app.tsx src/components/workspace/workspace-desktop-shell.tsx src/components/workspace/workspace-mobile-shell.tsx
git commit -m "feat: add workspace files app"
```

### Task 8: Add the Processes workspace app

**Files:**
- Create: `src/components/workspace/workspace-processes-app.tsx`
- Modify: `src/components/workspace/workspace-desktop-shell.tsx`
- Modify: `src/components/workspace/workspace-mobile-shell.tsx`

- [ ] **Step 1: Write failing tests for process app states**

Cover:

```tsx
it('shows a process list placeholder with clear future hooks')
it('shows a terminal fallback command for process inspection')
```

- [ ] **Step 2: Run the test**

Run: `npm test -- src/components/workspace/workspace-overview.test.tsx`

Expected:
- FAIL

- [ ] **Step 3: Implement the P0 process app shell**

For v1, this can be a structured app surface with:
- Search UI
- Column headings
- Empty/loading states
- Terminal jump actions such as `top`, `htop`, `ps aux --sort=-%mem`

Do not overbuild process fetching if backend commands are not yet prepared.

- [ ] **Step 4: Run tests**

Run: `npm test -- src/components/workspace/workspace-overview.test.tsx`

- [ ] **Step 5: Commit**

```bash
git add src/components/workspace/workspace-processes-app.tsx src/components/workspace/workspace-desktop-shell.tsx src/components/workspace/workspace-mobile-shell.tsx
git commit -m "feat: add workspace processes app"
```

### Task 9: Add the Services workspace app

**Files:**
- Create: `src/components/workspace/workspace-services-app.tsx`
- Modify: `src/components/workspace/workspace-desktop-shell.tsx`
- Modify: `src/components/workspace/workspace-mobile-shell.tsx`

- [ ] **Step 1: Write failing tests for service states**

Cover:

```tsx
it('renders a systemd-focused services workspace app')
it('shows unsupported state copy when systemd data is unavailable')
```

- [ ] **Step 2: Run the test**

Run: `npm test -- src/components/workspace/workspace-overview.test.tsx`

- [ ] **Step 3: Implement the P0 services app shell**

Include:
- Service list frame
- Status badges
- Restart/start/stop action placeholders or command launch actions
- Unsupported-state handling

- [ ] **Step 4: Run tests**

Run: `npm test -- src/components/workspace/workspace-overview.test.tsx`

- [ ] **Step 5: Commit**

```bash
git add src/components/workspace/workspace-services-app.tsx src/components/workspace/workspace-desktop-shell.tsx src/components/workspace/workspace-mobile-shell.tsx
git commit -m "feat: add workspace services app"
```

### Task 10: Add the Logs workspace app

**Files:**
- Create: `src/components/workspace/workspace-logs-app.tsx`
- Modify: `src/components/workspace/workspace-desktop-shell.tsx`
- Modify: `src/components/workspace/workspace-mobile-shell.tsx`

- [ ] **Step 1: Write failing tests for the logs app**

Cover:

```tsx
it('renders a logs app with source filters')
it('shows terminal handoff commands for journalctl and tail')
```

- [ ] **Step 2: Run the test**

Run: `npm test -- src/components/workspace/workspace-overview.test.tsx`

- [ ] **Step 3: Implement the P0 logs app shell**

Include:
- Source switcher
- Search input
- Follow toggle UI
- Copy/open-in-terminal actions

- [ ] **Step 4: Run tests**

Run: `npm test -- src/components/workspace/workspace-overview.test.tsx`

- [ ] **Step 5: Commit**

```bash
git add src/components/workspace/workspace-logs-app.tsx src/components/workspace/workspace-desktop-shell.tsx src/components/workspace/workspace-mobile-shell.tsx
git commit -m "feat: add workspace logs app"
```

## Chunk 5: Copy, Navigation Polish, And Verification

### Task 11: Add localization and nav copy

**Files:**
- Modify: `src/lib/locales/en.ts`
- Modify: `src/lib/locales/zh-CN.ts`
- Modify: `src/components/pc-nav-sidebar.tsx`

- [ ] **Step 1: Write down the copy keys before editing**

Add keys for:
- Workspace mode toggle
- Workspace app labels
- Overview status cards
- Empty/unsupported states
- iOS-style mobile labels

- [ ] **Step 2: Add English copy**

Examples:

```ts
'workspace.mode.terminal': 'Terminal'
'workspace.mode.workspace': 'Workspace'
'workspace.app.overview': 'Overview'
'workspace.app.files': 'Files'
```

- [ ] **Step 3: Add Chinese copy**

Examples:

```ts
'workspace.mode.terminal': '终端'
'workspace.mode.workspace': '工作空间'
'workspace.app.overview': '总览'
'workspace.app.files': '文件'
```

- [ ] **Step 4: Ensure global nav still reads cleanly**

If `pc-nav-sidebar` needs minor copy or visual spacing tweaks because Workspace now exists inside sessions, make them here.

- [ ] **Step 5: Run lint**

Run: `npm run lint`

- [ ] **Step 6: Commit**

```bash
git add src/lib/locales/en.ts src/lib/locales/zh-CN.ts src/components/pc-nav-sidebar.tsx
git commit -m "feat: add workspace localization copy"
```

### Task 12: Final verification

**Files:**
- Review only

- [ ] **Step 1: Run the full targeted frontend test suite**

Run:

```bash
npm test
```

Expected:
- PASS

- [ ] **Step 2: Run lint**

Run:

```bash
npm run lint
```

Expected:
- PASS

- [ ] **Step 3: Run production build**

Run:

```bash
npm run build
```

Expected:
- PASS

- [ ] **Step 4: Smoke-check responsive behavior manually**

Verify:
- Desktop session can switch between `Terminal` and `Workspace`
- Mobile session can switch between `Terminal` and `Workspace`
- Mobile Workspace uses iOS-style structure: top cards, app grid, recent activity
- Terminal sessions still reconnect and preserve existing behavior

- [ ] **Step 5: Commit final integration**

```bash
git add .
git commit -m "feat: add workspace mode for connected sessions"
```

## Notes For Execution

- Keep Workspace additive. Do not regress terminal-first workflows.
- Prefer wrapping existing features before inventing new data pipelines.
- For `Processes`, `Services`, and `Logs`, it is acceptable in v1 to ship strong UI shells with terminal handoff actions before deeper command-backed interactivity lands.
- If component files start stretching past a comfortable size, split them by responsibility rather than by arbitrary layer.
- Preserve mobile ergonomics. Mobile should feel like an iOS-native system app, not a mini desktop.
