// src/dock-walk.js — Dock-walk mode (attach to external window, walk along its top edge)
//
// When the Pomeranian theme is active and dockWalk is supported, the user can
// right-click → 吸附 to enter a 5-second window detection mode. The pet then
// attaches to the top edge of the clicked window and runs its own 3-state
// cycle: lie → walk → lie (with happy interrupt on mouse proximity).
//
// Two independent timers:
// - Visibility timer (500ms): check if target window is occluded/minimized
// - Position sync timer (2s idle / 200ms active drag): follow window moves

const DOCK_WALK_SPEED = 0.06; // px/ms — same as ceiling-walk
const HAPPY_PROXIMITY_RADIUS = 150; // px from pet center
const DOCK_EXIT_TOLERANCE = 80; // px below window edge to exit on drag

// Dock-walk state machine timing (with jitter)
const LIE_DURATION_MIN = 3000;
const LIE_DURATION_RANGE = 2000; // 3~5s
const WALK_DURATION_MIN = 1500;
const WALK_DURATION_RANGE = 1000; // 1.5~2.5s

// Position sync adaptive polling
const POS_SYNC_IDLE_MS = 2000;
const POS_SYNC_ACTIVE_MS = 200;
const POS_SYNC_STABLE_COUNT = 3; // consecutive unchanged checks = drag ended

// Visibility check
const VISIBILITY_CHECK_MS = 500;
const MINIMIZE_RESTORE_TIMEOUT = 10000; // 10s before auto-exit on minimize

// Detection mode
const DETECTION_TIMEOUT_MS = 5000;

module.exports = function initDockWalk(ctx) {
  // ── Dock state ──────────────────────────────────────────────────────────
  let docked = false;
  let detecting = false; // in 5s window-detection mode
  let detectionTimer = null;

  // Target window info
  let targetHandle = null; // platform-specific window ID/handle
  let targetBounds = null; // { x, y, width, height }
  let relativeX = 0.5; // pet's horizontal position as 0~1 ratio of window width

  // Dock-walk 3-state machine
  let dockState = "lie"; // "lie" | "walk" | "happy"
  let preHappyState = "lie"; // state before happy interrupt
  let walkDirection = 1; // 1 = right, -1 = left
  let lieTimer = null;
  let walkTimer = null;
  let walkStepTimer = null;

  // Mouse proximity
  let happyActive = false;

  // Timers for window following
  let visibilityTimer = null;
  let posSyncTimer = null;
  let posSyncInterval = POS_SYNC_IDLE_MS;
  let posSyncStableCount = 0;
  let lastSyncedBounds = null;

  // Minimize restore
  let minimizedAt = 0;
  let minimizeTimeout = null;

  // ── Getters ─────────────────────────────────────────────────────────────
  function isDocked() { return docked; }
  function isDetecting() { return detecting; }
  function getDockState() { return dockState; }

  // ── Detection mode (5s window to click a target) ────────────────────────
  function enterDetectionMode() {
    if (docked || detecting) return;
    detecting = true;
    ctx.sendToRenderer("dock-detecting", true);
    if (ctx.sendToHitWin) ctx.sendToHitWin("hit-dock-detecting-sync", true, typeof ctx.getDetectHint === "function" ? ctx.getDetectHint() : "Click a window to dock");
 if (ctx.expandHitWinFullScreen) ctx.expandHitWinFullScreen();
    detectionTimer = setTimeout(() => {
      // Timeout — no window clicked
      cancelDetection("timeout");
    }, DETECTION_TIMEOUT_MS);
  }

  function cancelDetection(reason) {
    if (!detecting) return;
    detecting = false;
    if (detectionTimer) { clearTimeout(detectionTimer); detectionTimer = null; }
 if (ctx.restoreHitWinSize) ctx.restoreHitWinSize();
    ctx.sendToRenderer("dock-detecting", false);
    if (ctx.sendToHitWin) ctx.sendToHitWin("hit-dock-detecting-sync", false);
    if (reason === "timeout") {
      ctx.sendToRenderer("dock-detect-cancelled");
    }
  }

  // Called when user clicks during detection mode — detect window at point
  async function handleDetectClick(screenX, screenY) {
    if (!detecting) return false;
    cancelDetection("success");

    try {
      const ownIds = typeof ctx.getOwnWindowIds === "function" ? ctx.getOwnWindowIds() : new Set();
    const result = await ctx.detectWindowAtPoint(screenX, screenY, ownIds);
      if (!result) {
        ctx.sendToRenderer("dock-detect-cancelled");
        return false;
      }

      targetHandle = result.handle;
      targetBounds = result.bounds;
      relativeX = Math.max(0, Math.min(1, (screenX - result.bounds.x) / result.bounds.width));
      dock();
      return true;
    } catch (err) {
      console.warn("[dock-walk] window detection failed:", err.message);
      ctx.sendToRenderer("dock-detect-cancelled");
      return false;
    }
  }

  // ── Dock entry ──────────────────────────────────────────────────────────
  function dock() {
    if (docked) return;
    docked = true;
 if (ctx.restoreHitWinSize) ctx.restoreHitWinSize();
  if (ctx.setDockWalkActive) ctx.setDockWalkActive(true);
    dockState = "lie";
    happyActive = false;
    walkDirection = 1;

    // Snap to top edge of target window
    syncPosition();

    // Set always-on-top to floating level
    if (ctx.win && !ctx.win.isDestroyed()) {
      ctx.win.setAlwaysOnTop(true, "floating");
    }

    // Notify renderer
    ctx.sendToRenderer("dock-mode-change", true);

    // Start dock-walk state machine from lie
    applyDockState("lie");
    startLieTimer();

    // Start window following timers
    startVisibilityTimer();
    startPosSyncTimer();
  }

  // ── Dock exit ───────────────────────────────────────────────────────────
  function exitDockWalk() {
    if (!docked) return;
    docked = false;
    dockState = "lie";
    happyActive = false;

    // Stop all timers
    stopLieTimer();
    stopWalkTimer();
    stopWalkStep();
    stopVisibilityTimer();
    stopPosSyncTimer();
    if (minimizeTimeout) { clearTimeout(minimizeTimeout); minimizeTimeout = null; }

    // Release target
    targetHandle = null;
    targetBounds = null;
    lastSyncedBounds = null;

    // Restore normal always-on-top
    if (ctx.win && !ctx.win.isDestroyed()) {
      ctx.win.setAlwaysOnTop(true, "screen-saver");
    }

    // Notify renderer
    ctx.sendToRenderer("dock-mode-change", false);

    // Return to normal idle state
    ctx.applyState("idle");
  }

  // ── Dock-walk 3-state machine ───────────────────────────────────────────
  function applyDockState(state) {
    dockState = state;
    const file = state === "happy" ? "happy.gif"
      : state === "walk" ? "walking.gif"
      : "front.png";
    // Use applyState with svgOverride to force the dock-walk visual
    ctx.applyState(state === "happy" ? "happy" : state === "walk" ? "working" : "idle", file);

    // Flip walking direction via renderer
    if (state === "walk") {
      ctx.sendToRenderer("dock-walk-direction", walkDirection);
    }
  }

  function startLieTimer() {
    stopLieTimer();
    const duration = LIE_DURATION_MIN + Math.random() * LIE_DURATION_RANGE;
    lieTimer = setTimeout(() => {
      if (!docked || happyActive) return;
      applyDockState("walk");
      startWalkTimer();
      startWalkStep();
    }, duration);
  }

  function stopLieTimer() {
    if (lieTimer) { clearTimeout(lieTimer); lieTimer = null; }
  }

  function startWalkTimer() {
    stopWalkTimer();
    const duration = WALK_DURATION_MIN + Math.random() * WALK_DURATION_RANGE;
    walkTimer = setTimeout(() => {
      if (!docked || happyActive) return;
      stopWalkStep();
      applyDockState("lie");
      startLieTimer();
    }, duration);
  }

  function stopWalkTimer() {
    if (walkTimer) { clearTimeout(walkTimer); walkTimer = null; }
  }

  // Walking animation step
  function startWalkStep() {
    stopWalkStep();
    const step = () => {
      if (!docked || dockState !== "walk" || happyActive) return;
      const bounds = ctx.getPetWindowBounds();
      const size = ctx.getCurrentPixelSize();
      const stepPx = walkDirection * DOCK_WALK_SPEED * 16;
      let newX = bounds.x + stepPx;

      // Bounce at window edges
      const winLeft = targetBounds ? targetBounds.x : 0;
      const winRight = targetBounds ? targetBounds.x + targetBounds.width : 800;
      if (newX <= winLeft) {
        newX = winLeft;
        walkDirection = 1;
        ctx.sendToRenderer("dock-walk-direction", walkDirection);
      } else if (newX + size.width >= winRight) {
        newX = winRight - size.width;
        walkDirection = -1;
        ctx.sendToRenderer("dock-walk-direction", walkDirection);
      }

      ctx.applyPetWindowPosition(newX, bounds.y);
      ctx.syncHitWin();
      walkStepTimer = setTimeout(step, 16);
    };
    walkStepTimer = setTimeout(step, 100);
  }

  function stopWalkStep() {
    if (walkStepTimer) { clearTimeout(walkStepTimer); walkStepTimer = null; }
  }

  // ── Mouse proximity (happy state) ───────────────────────────────────────
  function checkProximity(cursorX, cursorY) {
    if (!docked) return;
    const bounds = ctx.getPetWindowBounds();
    const petCenterX = bounds.x + bounds.width / 2;
    const petCenterY = bounds.y + bounds.height / 2;
    const dist = Math.sqrt((cursorX - petCenterX) ** 2 + (cursorY - petCenterY) ** 2);

    if (dist < HAPPY_PROXIMITY_RADIUS) {
      if (!happyActive) {
        triggerHappy();
      }
    } else {
      if (happyActive) {
        releaseHappy();
      }
    }
  }

  function triggerHappy() {
    preHappyState = dockState;
    happyActive = true;
    stopLieTimer();
    stopWalkTimer();
    stopWalkStep();
    applyDockState("happy");
  }

  function releaseHappy() {
    happyActive = false;
    // Resume pre-interrupt state
    if (preHappyState === "walk") {
      applyDockState("walk");
      startWalkTimer();
      startWalkStep();
    } else {
      applyDockState("lie");
      startLieTimer();
    }
  }

  // ── Window following — visibility timer ──────────────────────────────────
  function startVisibilityTimer() {
    stopVisibilityTimer();
    const check = async () => {
      if (!docked) return;
      try {
        const ownIds2 = typeof ctx.getOwnWindowIds === "function" ? ctx.getOwnWindowIds() : new Set();
            const info = await ctx.getWindowVisibility(targetHandle, ownIds2);
        if (!info.exists) {
          // Window closed — auto-exit
          exitDockWalk();
          return;
        }
        if (info.minimized) {
          if (!minimizedAt) {
            minimizedAt = Date.now();
            ctx.win.hide();
            // Start restore timeout
            minimizeTimeout = setTimeout(() => {
              if (!docked) return;
              exitDockWalk(); // window not restored in time
            }, MINIMIZE_RESTORE_TIMEOUT);
          }
        } else {
          if (minimizedAt) {
            // Window restored
            minimizedAt = 0;
            if (minimizeTimeout) { clearTimeout(minimizeTimeout); minimizeTimeout = null; }
            ctx.win.show();
            syncPosition();
          }
          if (info.occluded) {
            ctx.win.hide();
          } else {
            if (!ctx.win.isVisible()) {
              ctx.win.show();
            }
          }
        }
      } catch (err) {
        // If visibility check fails (e.g., handle invalidated), exit
        console.warn("[dock-walk] visibility check failed:", err.message);
      }
      if (docked) {
        visibilityTimer = setTimeout(check, VISIBILITY_CHECK_MS);
      }
    };
    visibilityTimer = setTimeout(check, VISIBILITY_CHECK_MS);
  }

  function stopVisibilityTimer() {
    if (visibilityTimer) { clearTimeout(visibilityTimer); visibilityTimer = null; }
  }

  // ── Window following — position sync timer ──────────────────────────────
  function startPosSyncTimer() {
    stopPosSyncTimer();
    posSyncInterval = POS_SYNC_IDLE_MS;
    posSyncStableCount = 0;

    const sync = async () => {
      if (!docked) return;
      try {
        const newBounds = await ctx.getWindowBounds(targetHandle);
        if (!newBounds) {
          // Window gone
          exitDockWalk();
          return;
        }

        if (!lastSyncedBounds || boundsEqual(newBounds, lastSyncedBounds)) {
          posSyncStableCount++;
          if (posSyncStableCount >= POS_SYNC_STABLE_COUNT && posSyncInterval === POS_SYNC_ACTIVE_MS) {
            // Drag ended — sync position
            targetBounds = newBounds;
            syncPosition();
            posSyncInterval = POS_SYNC_IDLE_MS;
          }
        } else {
          // Bounds changing — window is being dragged
          posSyncStableCount = 0;
          posSyncInterval = POS_SYNC_ACTIVE_MS;
          targetBounds = newBounds;
        }
        lastSyncedBounds = { ...newBounds };
      } catch (err) {
        console.warn("[dock-walk] position sync failed:", err.message);
      }
      if (docked) {
        posSyncTimer = setTimeout(sync, posSyncInterval);
      }
    };
    posSyncTimer = setTimeout(sync, posSyncInterval);
  }

  function stopPosSyncTimer() {
    if (posSyncTimer) { clearTimeout(posSyncTimer); posSyncTimer = null; }
  }

  function boundsEqual(a, b) {
    if (!a || !b) return false;
    return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
  }

  // ── Position sync using relativeX ───────────────────────────────────────
  function syncPosition() {
    if (!docked || !targetBounds) return;
    const size = ctx.getCurrentPixelSize();
    const newPetX = targetBounds.x + targetBounds.width * relativeX - size.width / 2;
    const newPetY = targetBounds.y - size.height;

    // Clamp within window bounds
    const clampedX = Math.max(
      targetBounds.x,
      Math.min(newPetX, targetBounds.x + targetBounds.width - size.width)
    );

    ctx.applyPetWindowPosition(clampedX, newPetY);
    ctx.syncHitWin();

    // Update relativeX after clamping
    relativeX = (clampedX + size.width / 2 - targetBounds.x) / targetBounds.width;
  }

  // ── Drag exit check ─────────────────────────────────────────────────────
  function checkDockDragExit() {
    if (!docked) return false;
    const bounds = ctx.getPetWindowBounds();
    if (!targetBounds) return false;
    // Exit if dragged more than DOCK_EXIT_TOLERANCE below the target window edge
    const windowBottom = bounds.y + bounds.height;
    const edgeY = targetBounds.y;
    if (windowBottom - edgeY > DOCK_EXIT_TOLERANCE + bounds.height) {
      exitDockWalk();
      return true;
    }
    return false;
  }

  // ── Theme switch handler ────────────────────────────────────────────────
  function handleThemeSwitch() {
    if (docked) exitDockWalk();
    if (detecting) cancelDetection("theme-switch");
  }

  // ── Cleanup ─────────────────────────────────────────────────────────────
  function cleanup() {
    if (docked) exitDockWalk();
    if (detecting) cancelDetection("cleanup");
  }

  return {
    isDocked,
    isDetecting,
    getDockState,
    enterDetectionMode,
    handleDetectClick,
    exitDockWalk,
    checkProximity,
    checkDockDragExit,
    handleThemeSwitch,
    syncPosition,
    cleanup,
  };
};
