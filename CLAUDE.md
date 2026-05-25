# CLAUDE.md This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Electron desktop pet that reacts to AI coding agent sessions via hooks/log polling/plugins/extensions. Pure JavaScript (CommonJS), no build/compile step. Supports Claude Code, Codex CLI, Copilot CLI, Gemini CLI, Cursor Agent, CodeBuddy, Kiro, Kimi Code, opencode, Pi, and OpenClaw. Three built-in themes (Clawd/Calico/Cloudling). Platforms: Windows, macOS, Linux.

## Commands

```bash
npm start                 # Launch app (also fetches sidecar binaries)
npm test                  # Run all tests via node test/run-tests.js
node --test test/foo.test.js  # Run a single test
npm run build             # electron-builder --win
npm run build:win:x64     # Windows x64 NSIS installer
npm run build:mac         # macOS DMG
npm run build:linux       # Linux AppImage + deb
npm run create-theme      # Scaffold a new theme
npm run fetch:sidecars    # Download sidecar binaries
```

Hook install/uninstall commands (for debugging/reinstall; auto-sync runs at startup for enabled agents):
```bash
npm run install:claude-hooks / uninstall:claude-hooks
npm run install:cursor-hooks
npm run install:gemini-hooks / install:kiro-hooks / install:kimi-hooks
npm run install:codex-hooks / uninstall:codex-hooks
npm run install:pi-extension / uninstall:pi-extension
npm run install:openclaw-plugin / uninstall:openclaw-plugin
node hooks/codebuddy-install.js   # CodeBuddy (manual only)
node hooks/opencode-install.js    # opencode (manual only)
```

Manual test scripts (curl-based, target running app):
```bash
bash test-demo.sh [seconds]
bash test-mini.sh [seconds]
bash test-oneshot-gate.sh [state] [seconds]
```

## Architecture

Data flow: **hook/log monitor → `src/server.js` → `src/state.js` → IPC → `src/renderer.js`**

**Dual-window model**: Render window (SVG display + eye tracking) + Input/Hit window (pointer events, dragging). Both managed from `src/main.js`.

### Key modules

- `src/main.js` — Electron main process: window creation, IPC, lifecycle, context assembly
- `src/server.js` — HTTP server (`/state`, `/permission`), port 23333-23337, writes port to `~/.clawd/runtime.json`; auto-syncs hooks/plugins for enabled agents
- `src/state.js` — State machine: multi-session merging, priority resolution, auto-return, sleep/DND; delegates to `src/state-priority.js`, `src/state-visual-resolver.js`, `src/state-session-snapshot.js`, `src/state-hitbox-resolver.js`, `src/state-stale-cleanup.js`, `src/state-agent-icons.js`
- `src/renderer.js` — SVG swap, eye tracking, low-power idle, animation cycle
- `src/permission.js` + `src/bubble-renderer.js` + `src/bubble-policy.js` — Permission bubble UI (stacking, auto-dismiss, global hotkeys Ctrl+Shift+Y/N)
- `src/dashboard.js` + `src/session-hud.js` — Multi-session visibility (Dashboard for details/aliases/terminal jump, HUD for live session near pet)

### Settings system (single source of truth)

`src/prefs.js` (schema/load/save/migrate) → `src/settings-controller.js` (sole writer) → `src/settings-store.js` (immutable snapshot store). Effects routed through `src/settings-actions.js` → `src/settings-effect-router.js`. **Do not bypass settings-controller.**

### Theme system

`src/theme-loader.js` (load/validate/merge), `src/theme-runtime.js`, `src/theme-schema.js`, `src/theme-sanitizer.js` (SVG sanitization for 3rd-party themes). Theme.json defines states, SVG mappings, eye tracking, hitboxes, mini mode, sounds, timings. Fade sequencer for smooth transitions. `src/codex-pet-adapter.js` + `src/codex-pet-importer.js` for Codex Pet import.

### Agent integration

Each agent: config file in `agents/` (id, name, processNames, eventMap, capabilities) + hook installer in `hooks/`. `src/agent-gate.js` controls enable/disable per agent. `src/integration-sync.js` auto-registers hooks on startup.

### Remote SSH (5 modules)

`src/remote-ssh-runtime.js` (connection state machine), `src/remote-ssh-deploy.js` (deploy/repair), `src/remote-ssh-node.js` (remote Node ≥14 detection), `src/remote-ssh-profile.js` (profile schema), `src/remote-ssh-ipc.js` (IPC handlers).

## Constraints & Gotchas

- **Hook scripts** can only use Node built-in modules + same-directory helpers (`server-config.js`, `shared-process.js`, `json-utils.js`, `codex-subagent-fields.js`). No external deps.
- **Stable PID**: Hook scripts must use `getStablePid()`, not `process.ppid`, for terminal PID resolution.
- **SVG cache-bust**: `renderer.js` appends `?_t=` to SVG `<img>` src — do not remove. Chromium reuses animation timelines for same-URL SVGs, causing one-shot animations to freeze on last frame.
- **DND must not make permission decisions**: opencode → silent drop back to TUI; Pi → fallback to terminal confirmation; Claude Code/CodeBuddy → disconnect back to built-in confirmation; Codex → no-decision `{}` back to native prompt.
- **`hitWin.focusable = true`** is critical for Windows drag fix — do not revert.
- **`miniTransitioning`** guard: all window positioning paths must check this flag first to prevent concurrent `setPosition()` crashes.
- **Session HUD** shows all non-headless, non-sleeping live sessions including `badge=Done` idle sessions. Do not filter by `state !== "idle"` or completed sessions vanish.
- **Claude settings watcher** must watch the **directory** (not file) on Windows due to atomic replace; must be gated by both `manageClaudeHooksAutomatically` and `claude-code.enabled`.
- **Disabling an agent** stops monitors, clears sessions/bubbles, makes HTTP hook entries fast-fallback — but does NOT uninstall hooks/plugins/extensions. Re-enabling triggers one integration sync.
- **Copilot CLI** is the only agent not auto-synced locally; requires manual `~/.copilot/hooks/hooks.json` config. Remote deploy via `scripts/remote-deploy.sh` auto-writes.
- **Codex Windows hooks** must use PowerShell `& "node" ...` format; bare `"node" "hook.js"` exits with code 1.
- **Codex official hooks** are primary; JSONL polling is fallback for uncovered events (WebSearch, compaction, abort) and history compat.
- **opencode permissions** cannot use `permission.ask` hook; use event hook + reverse bridge instead.
- **Kiro** has no global hooks — injected into `~/.kiro/agents/*.json` only.
- **Resource paths**: Always use `path.join(__dirname, ...)`.
- **Assets**: Edit published assets by copying to `assets/source/` first. Do not delete `assets/source/cloudling-pointer-bridge/` (reserved source directory).
- **Windows NSIS**: Must produce architecture-specific x64/ARM64 installers; `buildUniversalInstaller` stays `false`.
- **`mini-working`** is an optional theme capability; must gracefully degrade when absent.
- **`contextMenuOwner`** must retain `parent: win` + `closable:false` or exit flow deadlocks.
- **Language submenu truncation** is an Electron transparent-window + Windows DWM issue. Do not attempt fixes via `alwaysOnTop`, transparency, or JS menu layout.

## Testing

- Node built-in test runner (`node:test` + `node:assert`). No external test framework.
- ~140 test files in `test/*.test.js`. Tests create mock contexts with factory functions (e.g., `makeCtx(overrides)`).
- No linting/formatting tooling configured.
- Windows-first dev environment. macOS path changes require code-review-first approach describing behavior changes and residual risk.
- Hook payload changes (especially `/permission`, `permission_suggestions`, `updatedPermissions`, elicitation) must be verified with a real Claude Code session — curl with hand-crafted payloads is insufficient.
- Electron behaviors (transparent windows, tray, drag, cross-platform focus) rely on manual verification.

## Deep docs

See `docs/project/` for architecture details: `project-introduction.md`, `agent-runtime-architecture.md`, `project-architecture.md`, `theme-state-ui.md`, `release-process.md`.
