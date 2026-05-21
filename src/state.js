// src/state.js — State machine + DND + wake poll
// Extracted from main.js L158-240, L299-505, L544-960

let screen;
try { ({ screen } = require("electron")); } catch { screen = null; }
const {
  createStatePriorityConstants,
  getStatePriority,
} = require("./state-priority");
const {
  buildStateBindings,
  hasOwnVisualFiles: hasOwnVisualFilesWithBindings,
  resolveVisualBinding: resolveVisualBindingWithBindings,
} = require("./state-visual-resolver");
const {
  createHitboxRuntime,
  resolveHitBoxForSvg: resolveHitBoxForSvgWithRuntime,
} = require("./state-hitbox-resolver");

module.exports = function initState(ctx) {

  const _getCursor = ctx.getCursorScreenPoint || (screen ? () => screen.getCursorScreenPoint() : null);

  // ── Theme-driven state (refreshed on hot theme switch) ──
  let theme = null;
  let SVG_IDLE_FOLLOW = null;
  let STATE_SVGS = {};
  let STATE_BINDINGS = {};
  let MIN_DISPLAY_MS = {};
  let AUTO_RETURN_MS = {};
  let DEEP_SLEEP_TIMEOUT = 0;
  let YAWN_DURATION = 0;
  let WAKE_DURATION = 0;
  let DND_SKIP_YAWN = false;
  let DND_SLEEP_TRANSITION_SVG = null;
  let DND_SLEEP_TRANSITION_DURATION = 0;
  let COLLAPSE_DURATION = 0;
  let SLEEP_MODE = "full";
  const { SLEEP_SEQUENCE, STATE_PRIORITY, ONESHOT_STATES } = createStatePriorityConstants();

  // ── Hit-test bounding boxes (from theme) ──
  let HIT_BOXES = {};
  let FILE_HIT_BOXES = {};
  let WIDE_SVGS = new Set();
  let SLEEPING_SVGS = new Set();
  let hitboxRuntime = { hitBoxes: HIT_BOXES, fileHitBoxes: FILE_HIT_BOXES, wideSvgs: WIDE_SVGS, sleepingSvgs: SLEEPING_SVGS };
  let currentHitBox = HIT_BOXES.default;

  // ── State machine internal ──
  let currentState = "idle";
let dockWalkActive = false;
  let previousState = "idle";
  let currentSvg = null;
  let stateChangedAt = Date.now();
  let pendingTimer = null;
  let autoReturnTimer = null;
  let pendingState = null;
  let eyeResendTimer = null;
  let updateVisualState = null;
  let updateVisualKind = null;
  let updateVisualSvgOverride = null;
  let updateVisualPriority = null;

  const UPDATE_VISUAL_STATE_MAP = {
    checking: "thinking",
    available: "notification",
    downloading: "carrying",
  };

  const UPDATE_VISUAL_PRIORITY_MAP = {
    checking: STATE_PRIORITY.notification,
    available: STATE_PRIORITY.notification,
    downloading: STATE_PRIORITY.carrying,
  };

  // ── Wake poll ──
  let wakePollTimer = null;
  let lastWakeCursorX = null, lastWakeCursorY = null;

  function resolveHitBoxForSvg(svg) {
    return resolveHitBoxForSvgWithRuntime(svg, hitboxRuntime);
  }

  function refreshTheme() {
    theme = ctx.theme;
    SVG_IDLE_FOLLOW = theme.states.idle[0];
    STATE_SVGS = { ...theme.states };
    STATE_BINDINGS = buildStateBindings(theme);
    if (theme.miniMode && theme.miniMode.states) {
      Object.assign(STATE_SVGS, theme.miniMode.states);
    }
    MIN_DISPLAY_MS = theme.timings.minDisplay;
    AUTO_RETURN_MS = theme.timings.autoReturn;
    DEEP_SLEEP_TIMEOUT = theme.timings.deepSleepTimeout;
    YAWN_DURATION = theme.timings.yawnDuration;
    WAKE_DURATION = theme.timings.wakeDuration;
    DND_SKIP_YAWN = !!theme.timings.dndSkipYawn;
    DND_SLEEP_TRANSITION_SVG = typeof theme.timings.dndSleepTransitionSvg === "string" && theme.timings.dndSleepTransitionSvg
      ? theme.timings.dndSleepTransitionSvg.split(/[\\/]/).pop()
      : null;
    DND_SLEEP_TRANSITION_DURATION = Number.isFinite(theme.timings.dndSleepTransitionDuration) && theme.timings.dndSleepTransitionDuration > 0
      ? Math.floor(theme.timings.dndSleepTransitionDuration)
      : 0;
    COLLAPSE_DURATION = theme.timings.collapseDuration || 0;
    SLEEP_MODE = theme.sleepSequence && theme.sleepSequence.mode === "direct" ? "direct" : "full";
    hitboxRuntime = createHitboxRuntime(theme);
    HIT_BOXES = hitboxRuntime.hitBoxes;
    FILE_HIT_BOXES = hitboxRuntime.fileHitBoxes;
    WIDE_SVGS = hitboxRuntime.wideSvgs;
    SLEEPING_SVGS = hitboxRuntime.sleepingSvgs;

    currentHitBox = resolveHitBoxForSvg(currentSvg);
    refreshUpdateVisualOverride();
  }

  refreshTheme();

  function refreshUpdateVisualOverride() {
    updateVisualSvgOverride = (updateVisualKind === "checking" && theme && theme.updateVisuals && theme.updateVisuals.checking)
      ? theme.updateVisuals.checking
      : null;
  }

  function shouldDropForDnd() {
    return !!ctx.doNotDisturb;
  }

  function setState(newState, svgOverride) {
    if (shouldDropForDnd()) return;
  if (dockWalkActive && !svgOverride) return;

    if (newState === "yawning" && SLEEP_SEQUENCE.has(currentState)) return;

    if (pendingTimer) {
      if (pendingState && getStatePriority(newState, STATE_PRIORITY) < getStatePriority(pendingState, STATE_PRIORITY)) {
        return;
      }
      clearTimeout(pendingTimer);
      pendingTimer = null;
      pendingState = null;
    }

    const sameState = newState === currentState;
    const sameSvg = !svgOverride || svgOverride === currentSvg;
    if (sameState && sameSvg) return;

    const minTime = MIN_DISPLAY_MS[currentState] || 0;
    const elapsed = Date.now() - stateChangedAt;
    const remaining = minTime - elapsed;

    if (remaining > 0) {
      if (autoReturnTimer) { clearTimeout(autoReturnTimer); autoReturnTimer = null; }
      pendingState = newState;
      const pendingSvgOverride = svgOverride;
      pendingTimer = setTimeout(() => {
        pendingTimer = null;
        const queued = pendingState;
        const queuedSvg = pendingSvgOverride;
        pendingState = null;
        if (ONESHOT_STATES.has(queued)) {
          applyState(queued, queuedSvg);
        } else {
          const resolved = resolveDisplayState();
          applyState(resolved, getSvgOverride(resolved));
        }
      }, remaining);
    } else {
      applyState(newState, svgOverride);
    }
  }

  function isOneshotDisabled(logicalState) {
    if (!ONESHOT_STATES.has(logicalState)) return false;
    if (typeof ctx.isOneshotDisabled !== "function") return false;
    try { return ctx.isOneshotDisabled(logicalState) === true; }
    catch { return false; }
  }

  function hasOwnVisualFiles(state) {
    return hasOwnVisualFilesWithBindings(STATE_BINDINGS, state);
  }

  function resolveVisualBinding(state) {
    return resolveVisualBindingWithBindings(state, STATE_BINDINGS);
  }

  function applyResolvedDisplayState() {
    const resolved = resolveDisplayState();
    applyState(resolved, getSvgOverride(resolved));
  }

  function playWakeTransitionOrResolve() {
    if (SLEEP_MODE === "direct" && !hasOwnVisualFiles("waking")) {
      applyResolvedDisplayState();
      return;
    }
    applyState("waking");
  }

  function applyDndSleepState() {
    if (SLEEP_MODE === "direct") {
      applyState("sleeping");
      return;
    }
    if (DND_SLEEP_TRANSITION_SVG) {
      applyState("collapsing", DND_SLEEP_TRANSITION_SVG);
      return;
    }
    applyState(DND_SKIP_YAWN ? "collapsing" : "yawning");
  }

  function applyState(state, svgOverride) {
    // User-disabled oneshot state — skip visual + sound, fall back to
    // whatever resolveDisplayState picks (usually working/idle).
    if (isOneshotDisabled(state)) {
      const resolved = resolveDisplayState();
      if (resolved !== state) {
        setState(resolved, getSvgOverride(resolved));
      }
      return;
    }

    if (ctx.miniTransitioning && !state.startsWith("mini-")) {
      return;
    }

    if (ctx.miniMode && !state.startsWith("mini-")) {
      if (state === "notification") return applyState("mini-alert");
      if (state === "attention") return applyState("mini-happy");
      if (state === "working" || state === "thinking" || state === "juggling") {
        if (hasOwnVisualFiles("mini-working")) return applyState("mini-working");
        return;
      }
      if ((AUTO_RETURN_MS[currentState] || currentState === "mini-working") && !autoReturnTimer) {
        return applyState(ctx.mouseOverPet ? "mini-peek" : "mini-idle");
      }
      return;
    }

    previousState = currentState;
    currentState = state;
    stateChangedAt = Date.now();
    ctx.idlePaused = false;

    // Sound triggers
    if (state === "attention" || state === "mini-happy") {
      ctx.playSound("complete");
    } else if (state === "notification" || state === "mini-alert") {
      ctx.playSound("confirm");
    }

    const svg = svgOverride || resolveVisualBinding(state);
    currentSvg = svg;

    // Force eye resend after SVG load completes (~300ms)
    // After sweeping → idle, pause eye tracking briefly so eyes stay centered before resuming
    if (eyeResendTimer) { clearTimeout(eyeResendTimer); eyeResendTimer = null; }
    if (state === "idle" || state === "mini-idle") {
      const afterSweep = previousState === "sweeping";
      const delay = afterSweep ? 800 : 300;
      if (afterSweep) ctx.eyePauseUntil = Date.now() + delay;
      eyeResendTimer = setTimeout(() => { eyeResendTimer = null; ctx.forceEyeResend = true; }, delay);
    }

    currentHitBox = resolveHitBoxForSvg(svg);

    ctx.sendToRenderer("state-change", state, svg);
    ctx.syncHitWin();
    ctx.sendToHitWin("hit-state-sync", { currentSvg: svg, currentState: state });
    ctx.sendToHitWin("hit-cancel-reaction");

    if (state !== "idle" && state !== "mini-idle") {
      ctx.sendToRenderer("eye-move", 0, 0);
    }

    if ((state === "dozing" || state === "collapsing" || state === "sleeping") && !ctx.doNotDisturb) {
      setTimeout(() => {
        if (currentState === state) startWakePoll();
      }, 500);
    } else {
      stopWakePoll();
    }

    if (autoReturnTimer) clearTimeout(autoReturnTimer);
    if (state === "yawning") {
      autoReturnTimer = setTimeout(() => {
        autoReturnTimer = null;
        applyState(ctx.doNotDisturb ? "collapsing" : "dozing");
      }, YAWN_DURATION);
    } else if (state === "collapsing") {
      const dndCollapseDuration = (
        ctx.doNotDisturb
        && DND_SLEEP_TRANSITION_SVG
        && svg === DND_SLEEP_TRANSITION_SVG
        && DND_SLEEP_TRANSITION_DURATION > 0
      )
        ? DND_SLEEP_TRANSITION_DURATION
        : 0;
      const collapseDuration = dndCollapseDuration || COLLAPSE_DURATION;
      if (collapseDuration > 0) {
        autoReturnTimer = setTimeout(() => {
          autoReturnTimer = null;
          applyState("sleeping");
        }, collapseDuration);
      }
    } else if (state === "waking") {
      autoReturnTimer = setTimeout(() => {
        autoReturnTimer = null;
        applyResolvedDisplayState();
      }, WAKE_DURATION);
    } else if (AUTO_RETURN_MS[state]) {
      autoReturnTimer = setTimeout(() => {
        autoReturnTimer = null;
        if (ctx.miniMode) {
          if (ctx.mouseOverPet && !ctx.doNotDisturb) {
            if (state === "mini-peek") {
              // Peek animation done — stay peeked but show idle (don't re-trigger peek)
              ctx.miniPeeked = true;
              applyState("mini-idle");
            } else {
              ctx.miniPeekIn();
              applyState("mini-peek");
            }
          } else {
            applyState(ctx.doNotDisturb ? "mini-sleep" : "mini-idle");
          }
        } else {
          applyResolvedDisplayState();
        }
      }, AUTO_RETURN_MS[state]);
    }
  }

  // ── Wake poll ──
  function startWakePoll() {
    if (!_getCursor || wakePollTimer) return;
    const cursor = _getCursor();
    lastWakeCursorX = cursor.x;
    lastWakeCursorY = cursor.y;

    wakePollTimer = setInterval(() => {
      const cursor = _getCursor();
      const moved = cursor.x !== lastWakeCursorX || cursor.y !== lastWakeCursorY;

      if (moved) {
        stopWakePoll();
        wakeFromDoze();
        return;
      }

      if (currentState === "dozing" && Date.now() - ctx.mouseStillSince >= DEEP_SLEEP_TIMEOUT) {
        stopWakePoll();
        applyState("collapsing");
      }
    }, 200);
  }

  function stopWakePoll() {
    if (wakePollTimer) { clearInterval(wakePollTimer); wakePollTimer = null; }
  }

  function wakeFromDoze() {
    if (currentState === "sleeping" || currentState === "collapsing") {
      playWakeTransitionOrResolve();
      return;
    }
    ctx.sendToRenderer("wake-from-doze");
    setTimeout(() => {
      if (currentState === "dozing") {
        applyState("idle", SVG_IDLE_FOLLOW);
      }
    }, 350);
  }

  // ── Resolve display state (simplified: no session tracking) ──
  // Without sessions, the base state is always "idle". An update-visual
  // overlay can override it if its priority is higher. Sleep-sequence
  // states are never returned here — callers that reach this function
  // from a waking/collapse auto-return should land on "idle".
  function resolveDisplayState() {
    let base = "idle";
    const updateVisualSt = updateVisualState;
    if (updateVisualSt) {
      const upPriority = updateVisualPriority || getStatePriority(updateVisualSt, STATE_PRIORITY);
      if (upPriority > getStatePriority(base, STATE_PRIORITY)) {
        base = updateVisualSt;
      }
    }
    return base;
  }

  function setUpdateVisualState(kind) {
    if (!kind) {
      updateVisualState = null;
      updateVisualKind = null;
      updateVisualSvgOverride = null;
      updateVisualPriority = null;
      return null;
    }
    updateVisualKind = kind;
    updateVisualState = UPDATE_VISUAL_STATE_MAP[kind] || kind;
    updateVisualPriority = UPDATE_VISUAL_PRIORITY_MAP[kind] || getStatePriority(updateVisualState, STATE_PRIORITY);
    refreshUpdateVisualOverride();
    return updateVisualState;
  }

  function getSvgOverride(state) {
    // Without session tracking, display hints and tiered working/juggling
    // SVGs are not applicable. Fall back to basic resolution.
    if (updateVisualState && state === updateVisualState && updateVisualSvgOverride) {
      return updateVisualSvgOverride;
    }
    if (state === "idle") return SVG_IDLE_FOLLOW;
    if (state === "thinking") {
      return STATE_SVGS.thinking ? STATE_SVGS.thinking[0] : null;
    }
    return null;
  }

  // ── Do Not Disturb ──
  function enableDoNotDisturb() {
    if (ctx.doNotDisturb) return;
    ctx.doNotDisturb = true;
    ctx.sendToRenderer("dnd-change", true);
    ctx.sendToHitWin("hit-state-sync", { dndEnabled: true });
    if (typeof ctx.dismissPermissionsForDnd === "function") {
      ctx.dismissPermissionsForDnd();
    }
    if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; pendingState = null; }
    if (autoReturnTimer) { clearTimeout(autoReturnTimer); autoReturnTimer = null; }
    stopWakePoll();
    if (ctx.miniMode) {
      applyState("mini-sleep");
    } else {
      applyDndSleepState();
    }
    ctx.buildContextMenu();
    ctx.buildTrayMenu();
  }

  function disableDoNotDisturb() {
    if (!ctx.doNotDisturb) return;
    ctx.doNotDisturb = false;
    ctx.sendToRenderer("dnd-change", false);
    ctx.sendToHitWin("hit-state-sync", { dndEnabled: false });
    if (ctx.miniMode) {
      if (ctx.miniSleepPeeked) { ctx.miniPeekOut(); ctx.miniSleepPeeked = false; }
      ctx.miniPeeked = false;
      applyState("mini-idle");
    } else {
      playWakeTransitionOrResolve();
    }
    ctx.buildContextMenu();
    ctx.buildTrayMenu();
  }

  // ── Stubs for removed agent/session features ──
  // These are kept as no-ops so callers in main.js and settings-effect-router.js
  // don't break during the incremental migration. They can be removed once those
  // callers are updated.
  function updateSession() {}
  function cleanStaleSessions() {}
  function startStaleCleanup() {}
  function stopStaleCleanup() {}
  function startStartupRecovery() {}
  function detectRunningAgentProcesses(cb) { if (cb) cb(false); }
  function buildSessionSnapshot() { return []; }
  function emitSessionSnapshot() { return { changed: false, snapshot: [] }; }
  function broadcastSessionSnapshot() {}
  function getLastSessionSnapshot() { return []; }
  function getActiveSessionAliasKeys() { return []; }
  function dismissSession() { return false; }
  function clearSessionsByAgent() { return 0; }
  function disposeAllKimiPermissionState() { return false; }

  function getCurrentState() { return currentState; }
  function getCurrentSvg() { return currentSvg; }
  function getCurrentHitBox() { return currentHitBox; }

  function cleanup() {
    if (pendingTimer) clearTimeout(pendingTimer);
    if (autoReturnTimer) clearTimeout(autoReturnTimer);
    if (eyeResendTimer) clearTimeout(eyeResendTimer);
    if (wakePollTimer) clearInterval(wakePollTimer);
  }

  return {
    setState, applyState, updateSession, resolveDisplayState, resolveVisualBinding, setUpdateVisualState,
    shouldDropForDnd,
    enableDoNotDisturb, disableDoNotDisturb,
    startStaleCleanup, stopStaleCleanup, startWakePoll, stopWakePoll,
    getSvgOverride, cleanStaleSessions, startStartupRecovery, refreshTheme,
    detectRunningAgentProcesses, buildSessionSnapshot,
    emitSessionSnapshot, broadcastSessionSnapshot, getLastSessionSnapshot,
    getActiveSessionAliasKeys,
    dismissSession,
    clearSessionsByAgent,
    disposeAllKimiPermissionState,
    getCurrentState, getCurrentSvg, getCurrentHitBox,
    STATE_PRIORITY, ONESHOT_STATES, SLEEP_SEQUENCE,
    get STATE_SVGS() { return STATE_SVGS; },
    get HIT_BOXES() { return HIT_BOXES; },
    get FILE_HIT_BOXES() { return FILE_HIT_BOXES; },
    get WIDE_SVGS() { return WIDE_SVGS; },
    cleanup,
  setDockWalkActive(v) { dockWalkActive = !!v; },
  getDockWalkActive() { return dockWalkActive; },
  };

};
