# Pomeranian Theme & Dock-Walk Mode — Design Spec

**Date:** 2026-05-21
**Scope:** Pomeranian-exclusive feature (not a general theme capability)
**Status:** Approved

---

## 1. Overview

Add a Pomeranian theme to clawd-on-desk using existing PNG/GIF assets, and implement a "dock-walk" (吸附行走) mode where the pet attaches to the top edge of an arbitrary system window, walks back and forth along it, lies down periodically, and reacts to mouse proximity with a happy tail-wag animation.

---

## 2. Theme Resources & State Mapping

### 2.1 Assets

| File | Format | Dimensions | Frames | Used For |
|------|--------|-----------|--------|----------|
| `front.png` | PNG | 1015×1536 | static | 趴着 (idle/lie) |
| `side.png` | PNG | 842×1264 | static | (reserved, not used in v1) |
| `walking.gif` | GIF | 640×852 | ~202 | 走动 (walk) |
| `happy.gif` | GIF | 640×1136 | ~81 | 开心摇尾巴 (happy) |
| `icon.png` | PNG | 512×775 | static | Theme icon (display only, no state mapping) |

### 2.2 Pomeranian State Model (3 states only)

The Pomeranian theme intentionally ignores most of the app's internal state machine (working/thinking/sleeping etc.) and runs its own lie/walk/happy cycle:

| Pomeranian State | Visual | Trigger |
|-----------------|--------|---------|
| **趴着 (lie)** | `front.png` | Default; walks back to this after walking |
| **走动 (walk)** | `walking.gif` | After lying for 3~5s, auto-transitions |
| **开心 (happy)** | `happy.gif` | Mouse enters proximity range (highest priority, interrupts any state) |

### 2.3 App State Machine Mapping (non-dock-walk mode)

When NOT in dock-walk mode, the Pomeranian theme still needs to respond to app state changes:

| App State | Visual File | Notes |
|-----------|------------|-------|
| `idle` | `front.png` | Normal idle |
| `working` | `front.png` | No working distinction, stays idle pose |
| `thinking` | `front.png` | Same |
| `happy` | `happy.gif` | Cursor proximity / attention |
| `attention` | `happy.gif` | fallbackTo → happy |
| `notification` | `happy.gif` | fallbackTo → happy |
| `sleeping` | `front.png` | fallbackTo → idle |
| `dozing` | `front.png` | fallbackTo → idle |
| `collapsing` | `front.png` | fallbackTo → idle |
| `yawning` | `front.png` | fallbackTo → idle |
| `waking` | `front.png` | fallbackTo → idle |
| `error` | `front.png` | fallbackTo → idle |
| `sweeping` | `walking.gif` | fallbackTo → walking |
| `carrying` | `walking.gif` | fallbackTo → walking |
| `juggling` | `walking.gif` | fallbackTo → walking |

### 2.4 Theme Configuration

```json
{
  "schemaVersion": 1,
  "name": "Pomeranian",
  "version": "1.0.0",
  "viewBox": { "x": 0, "y": 0, "width": 640, "height": 1136 },
  "states": {
    "idle": ["front.png"],
    "working": ["front.png"],
    "thinking": ["front.png"],
    "happy": ["happy.gif"],
    "sleeping": { "files": ["front.png"], "fallbackTo": "idle" },
    "dozing": { "files": ["front.png"], "fallbackTo": "idle" },
    "collapsing": { "files": ["front.png"], "fallbackTo": "idle" },
    "yawning": { "files": ["front.png"], "fallbackTo": "idle" },
    "waking": { "files": ["front.png"], "fallbackTo": "idle" },
    "attention": { "files": ["happy.gif"], "fallbackTo": "happy" },
    "notification": { "files": ["happy.gif"], "fallbackTo": "happy" },
    "error": { "files": ["front.png"], "fallbackTo": "idle" },
    "sweeping": { "files": ["walking.gif"], "fallbackTo": "working" },
    "carrying": { "files": ["walking.gif"], "fallbackTo": "working" },
    "juggling": { "files": ["walking.gif"], "fallbackTo": "working" }
  },
  "sleepSequence": { "mode": "direct" },
  "miniMode": { "supported": false },
  "eyeTracking": { "enabled": false },
  "objectScale": {
    "widthRatio": 1.9,
    "heightRatio": 1.3,
    "offsetX": -0.45,
    "offsetY": -0.25,
    "fileScales": {
      "front.png": 1.0,
      "walking.gif": 0.75,
      "happy.gif": 0.75,
      "side.png": 0.9
    }
  },
  "dockWalk": { "supported": true }
}
```

- `sleepSequence.mode: "direct"` — skip yawning/dozing/collapsing/waking, go straight idle↔sleeping
- `miniMode.supported: false` — no mini assets
- `eyeTracking.enabled: false` — no SVG assets
- `dockWalk.supported: true` — declares this theme supports dock-walk mode

---

## 3. Dock-Walk Mode — Behavior State Machine

### 3.1 Three-State Cycle

```
┌──────────────────────────────────────────────────────┐
│                                                      │
│  ┌──────┐  3~5s后   ┌──────┐                        │
│  │趴着  │ ────────→ │走动  │ ←── 碰到窗口边缘反转   │
│  │front │ ←──────── │walk  │                        │
│  └──────┘  1.5~2.5s后└──────┘                        │
│      ↑        ↓                                     │
│      │   鼠标进入范围 (任何时候)                      │
│      │        ↓                                     │
│      │   ┌──────┐  鼠标离开                         │
│      └── │开心  │ ──→ 回到打断前的状态               │
│          │happy │     (趴着→趴着，走动→走动)          │
│          └──────┘                                    │
│                                                      │
└──────────────────────────────────────────────────────┘
```

### 3.2 Timing Parameters (with jitter)

| Phase | Base | Range | Formula |
|-------|------|-------|---------|
| 趴着持续时间 | 3.5s | 3~5s | `3000 + Math.random() * 2000` |
| 走动持续时间 | 2s | 1.5~2.5s | `1500 + Math.random() * 1000` |
| 走动速度 | — | — | ~0.06 px/ms (same as ceiling-walk) |

Each cycle generates fresh random durations.

### 3.3 Walking Bounds & Edge Bounce

- Walk range: left edge to right edge of the target window
- When pet reaches window left/right edge → direction reverses, continues walking
- Edge bounce does NOT reset the walk timer (pet walks for the full random duration)

### 3.4 Mouse Proximity Detection (both dock-walk and normal mode)

| Scenario | Detection | Behavior |
|----------|-----------|----------|
| **Normal mode (not docked)** | tick.js cursor polling, mouse within ~150px of pet center | → `happy.gif`, mouse leaves → back to idle |
| **Dock-walk mode** | Same cursor polling | → `happy.gif`, pause walk timer, mouse leaves → resume pre-interrupt state |

- Mouse proximity takes highest priority, overrides lie/walk cycle
- On mouse leave: return to whichever state was active before the interrupt
- Walk timer pauses during happy, resumes on leave

---

## 4. Dock-Walk — Window Detection & Attachment

### 4.1 Dock Entry Flow

1. User right-clicks pet → context menu shows「吸附」option (only when Pomeranian theme active + dockWalk supported)
2. User clicks「吸附」→ enters 5-second window detection mode
3. Pet displays a visual cue (e.g., subtle pulse or different state) indicating "waiting for target"
4. Within 5s, user clicks any system window
5. System API identifies the topmost window at click coordinates (excluding the pet's own windows)
6. Pet records: window handle/ID, current bounds, and **relativeX** (pet's horizontal position as 0~1 ratio of window width)
7. Pet snaps to the top edge of the target window: `petY = targetWindow.y - petHeight/2`
8. Dock-walk state machine starts (趴着)

### 4.2 Window Detection (per-platform)

Uses existing `koffi` FFI infrastructure already in the project.

| Platform | Detection API | Window Info | Implementation |
|----------|-------------|-------------|----------------|
| **Windows** | Extend `focus.js` P/Invoke: `WindowFromPoint` → `GetWindowRect` | HWND → bounds (x,y,w,h) | koffi → user32.dll |
| **macOS** | koffi → `CGWindowListCopyWindowInfo` (same SkyLight framework level as mac-window.js) | windowID → bounds + ownerPID | koffi → CoreGraphics |
| **Linux** | `xdotool getwindowfocus` + `xwininfo -id` | windowID → bounds | child_process |

Must filter out the pet's own Electron windows from detection results.

### 4.3 Window Bounds Retrieval (per-platform)

| Platform | API | Returns |
|----------|-----|---------|
| **Windows** | `GetWindowRect(HWND)` | `{ left, top, right, bottom }` |
| **macOS** | `CGWindowListCopyWindowInfo` entry with matching windowID | `{ x, y, width, height }` |
| **Linux** | `xwininfo -id <ID> | grep -E 'Absolute|Width|Height'` | parsed bounds |

---

## 5. Dock-Walk — Window Following

### 5.1 Two Independent Timers

| Timer | Interval | Purpose |
|-------|----------|---------|
| **Visibility timer** | 500ms | Check if target window is still the topmost visible window; hide/show pet accordingly |
| **Position sync timer** | 2s (idle) / 200ms (active drag) | Detect bounds changes; sync pet position when drag ends |

### 5.2 Position Sync — Adaptive Polling

```
Normal: 2s interval
  │
  ├─ bounds changed? → switch to 200ms interval, mark "dragging"
  │
  └─ bounds unchanged? → stay at 2s

Dragging (200ms interval):
  │
  ├─ bounds still changing? → keep 200ms, don't sync yet
  │
  └─ bounds same for 3 consecutive checks (~600ms)?
     → sync pet position using relativeX
     → switch back to 2s interval
```

### 5.3 Relative Position Preservation

When syncing after a drag:

```js
// At dock time, record:
relativeX = (petCenterX - targetWin.x) / targetWin.width  // 0~1

// On sync:
newPetX = newTargetWin.x + newTargetWin.width * relativeX - petWidth / 2
newPetY = newTargetWin.y - petHeight / 2  // always on top edge
```

This ensures the pet stays at the same relative horizontal position on the window after it moves.

### 5.4 Walk Range Update

When target window bounds change (after sync), update walk boundaries:
- `walkMinX = newTargetWin.x`
- `walkMaxX = newTargetWin.x + newTargetWin.width - petWidth`

If pet's current position is outside new bounds after sync, clamp to nearest edge.

---

## 6. Dock-Walk — Window Visibility & Z-Order Control

### 6.1 Visibility Rules

| Condition | Pet Action |
|-----------|-----------|
| Target window is the topmost (foreground) window | `win.show()`, pet visible, always-on-top at normal level |
| Another window covers the target window (higher z-order) | `win.hide()` |
| Target window is minimized | `win.hide()` |
| Target window is closed / no longer exists | Auto-exit dock-walk mode |
| Target window returns to foreground | `win.show()` |

### 6.2 Z-Order Detection (per-platform)

| Platform | How to check if target window is occluded |
|----------|------------------------------------------|
| **Windows** | `GetForegroundWindow()` — if result != target HWND, check if foreground window's rect overlaps target |
| **macOS** | `CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly, kCGNullWindowID)` — iterate z-order list, check if any window above target overlaps its bounds |
| **Linux** | `xdotool getwindowfocus` — compare focused window ID with target |

### 6.3 Always-On-Top Strategy

In dock-walk mode, the pet window's always-on-top is set to **"floating"** level (`setAlwaysOnTop(true, "floating")`), which is one step above normal windows but below other always-on-top windows. This keeps the pet just above the target window without conflicting with system overlays.

When NOT in dock-walk mode, restore the pet's normal always-on-top behavior.

---

## 7. Dock-Walk — Entry & Exit

### 7.1 Entry

- Right-click context menu →「吸附」
- Only shown when: active theme has `dockWalk.supported: true`
- 5-second detection window with visual feedback
- Timeout (5s no click) → cancel, return to normal mode with a brief notification

### 7.2 Exit

| Trigger | Behavior |
|---------|----------|
| Right-click menu →「解除吸附」| Immediate exit, pet stays at current screen position |
| Drag pet away from window edge (>80px downward) | Exit dock-walk, pet stays at drag-end position |
| Target window closed | Auto-exit, pet returns to last known screen position |
| Target window minimized | Pet hides; if window restored within 10s, re-dock; otherwise auto-exit |
| Theme switch (away from Pomeranian) | Auto-exit dock-walk |
| App quit | Dock state not persisted (v1 simplification) |

### 7.3 State Cleanup on Exit

- Stop both timers (visibility + position sync)
- Release window handle/ID reference
- Restore normal always-on-top level
- Transition pet to normal idle state

---

## 8. Mouse Proximity — Happy State (Both Modes)

### 8.1 Detection

Reuse `tick.js` cursor polling (already runs at ~16ms intervals in the main tick loop).

**Detection radius:** ~150px from pet window center.

| Mode | On Mouse Enter | On Mouse Leave |
|------|---------------|----------------|
| **Normal** | State → `happy` (happy.gif) | State → `idle` (front.png) |
| **Dock-walk: 趴着** | State → `happy`, pause lie timer | State → `趴着`, resume lie timer |
| **Dock-walk: 走动** | State → `happy`, pause walk timer + stop movement | State → `走动`, resume walk timer + movement |

### 8.2 Proximity Check Implementation

In `tick.js`, add a proximity check when Pomeranian theme is active:

```js
// Pseudocode in tick loop
const dist = distance(cursorPos, petCenter);
if (dist < HAPPY_PROXIMITY_RADIUS) {
  if (!happyActive) triggerHappy();
} else {
  if (happyActive) releaseHappy();
}
```

For dock-walk mode, the pet center is calculated from the current window position (which changes during walking).

---

## 9. New Modules & File Changes

### 9.1 New Files

| File | Purpose |
|------|---------|
| `themes/pomeranian/theme.json` | Theme definition (see Section 2.4) |
| `src/dock-walk.js` | Dock-walk state machine, window detection, following, visibility control |
| `src/dock-walk-detect.js` | Per-platform window detection (koffi FFI / xdotool) |
| `test/dock-walk.test.js` | Unit tests for dock-walk state machine |
| `test/dock-walk-detect.test.js` | Unit tests for window detection |

### 9.2 Modified Files

| File | Change |
|------|--------|
| `src/main.js` | Wire dock-walk module, add IPC handlers, add context menu items |
| `src/renderer.js` | Handle dock-walk visual state switching (lie/walk/happy) |
| `src/tick.js` | Add mouse proximity detection for Pomeranian happy state |
| `src/theme-schema.js` | Add `dockWalk` to optional theme fields |
| `src/context-menu.js` (or wherever context menu is built) | Add「吸附」/「解除吸附」menu items |
| `src/state.js` | Add dock-walk state override (when docked, run own state machine instead of app state machine) |
| `src/pet-interaction-ipc.js` | Handle drag-exit from dock-walk mode |
| `src/mac-window.js` | Add `CGWindowListCopyWindowInfo` binding for macOS window detection |
| `src/focus.js` | Extend Windows P/Invoke with `WindowFromPoint` + `GetWindowRect` for external window bounds |

### 9.3 Context Menu Items

| Item | Shown When | Action |
|------|-----------|--------|
| 「吸附」| Pomeranian theme active + NOT docked | Enter 5s window detection mode |
| 「解除吸附」| Currently in dock-walk mode | Exit dock-walk |

---

## 10. Edge Cases & Constraints

- **Multi-monitor**: If target window is on a different display than the pet, pet moves to that display. Follow uses absolute coordinates.
- **Taskbar/Dock overlap**: Pet sits on the window's title bar area (top edge), not the system taskbar. Should not conflict.
- **Fullscreen windows**: If target window goes fullscreen, pet hides (treated as occluded). When window exits fullscreen, pet reappears.
- **RDP / display topology change**: Same handling as existing ceiling-walk — use `work-area.js` fallbacks.
- **Pet drag during dock-walk**: Pet can be dragged; if dragged >80px away from target window edge, exit dock-walk. Otherwise, snap back to edge on release.
- **macOS Accessibility permission**: `CGWindowListCopyWindowInfo` requires no special permission. `AXUIElement` APIs would, but we're not using those.
- **Walking direction flip**: When walking direction reverses, the walking.gif should play in reverse direction. Since GIF can't be reversed in playback, use `scaleX(-1)` CSS transform on the `<img>` element (same technique as mini-mode asset flip).
- **GIF animation restart**: When switching from happy back to walking, the walking.gif should restart from frame 0. The renderer's cache-bust mechanism (`?_t=timestamp`) already handles this.

---

## 11. Future Considerations (Out of Scope for v1)

- Persist dock state across app restarts
- `side.png` usage for lateral-facing states
- Dock to bottom edge of windows
- Dock to left/right edges of windows
- Generalize dock-walk as a theme capability for other themes
- Smooth animation when snapping to window edge (parabolic jump like mini-mode exit)
- Sound effects for dock/walk/happy transitions
