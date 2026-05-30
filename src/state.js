// src/state.js — State machine + session management + DND + wake poll
// Extracted from main.js L158-240, L299-505, L544-960

let screen;
try { ({ screen } = require("electron")); } catch { screen = null; }
const {
  createStatePriorityConstants,
  getStatePriority,
  resolveDisplayStateFromSessions,
} = require("./state-priority");
const {
  buildStateBindings,
  hasOwnVisualFiles: hasOwnVisualFilesWithBindings,
  resolveVisualBinding: resolveVisualBindingWithBindings,
  getSvgOverride: getSvgOverrideWithDeps,
} = require("./state-visual-resolver");
const {
  getStaleSessionDecision,
} = require("./state-stale-cleanup");
const {
  createHitboxRuntime,
  resolveHitBoxForSvg: resolveHitBoxForSvgWithRuntime,
} = require("./state-hitbox-resolver");
const {
  pickDisplayHint: pickDisplayHintWithMap,
  pushRecentEvent,
} = require("./state-session-events");
const {
  deriveSessionBadge,
  normalizeTitle,
  shouldAutoClearDetachedSession: shouldAutoClearDetachedSessionWithDeps,
  buildSessionSnapshot: buildSessionSnapshotFromSessions,
  getActiveSessionAliasKeys: getActiveSessionAliasKeysFromSessions,
  sessionSnapshotSignature,
} = require("./state-session-snapshot");

module.exports = function initState(ctx) {

  const _getCursor = ctx.getCursorScreenPoint || (screen ? () => screen.getCursorScreenPoint() : null);
  const _kill = ctx.processKill || process.kill.bind(process);

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

  // Session display hints — validated against theme.displayHintMap keys
  let DISPLAY_HINT_MAP = {};

  // ── Session tracking ──
  const sessions = new Map();
  const MAX_SESSIONS = 20;
  let lastSessionSnapshotSignature = null;
  let lastSessionSnapshot = null;
  let startupRecoveryActive = false;
  let startupRecoveryTimer = null;
  const STARTUP_RECOVERY_MAX_MS = 300000;

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

  // ── Stale cleanup ──
  let staleCleanupTimer = null;
  let _detectInFlight = false;

  // ── Session Dashboard constants ──
  const STATE_LABEL_KEY = {
    working: "sessionWorking", thinking: "sessionThinking", juggling: "sessionJuggling",
    idle: "sessionIdle", sleeping: "sessionSleeping",
  };

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
    DISPLAY_HINT_MAP = theme.displayHintMap || {};
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
    if (sameState && sameSvg) {
      return;
    }

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
    // Phase 3b: user-disabled oneshot state — skip visual + sound, fall back to
    // whatever resolveDisplayState picks (usually working/idle). Gate lives at
    // applyState() top so it catches all paths that reach here, and also runs
    // before the mini-mode remap below, so "disable notification" silences both
    // normal and mini visuals consistently.
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

  function pickDisplayHint(state, existing, incoming) {
    return pickDisplayHintWithMap(state, existing, incoming, DISPLAY_HINT_MAP);
  }

  function debugSession(msg) {
    if (typeof ctx.debugLog !== "function") return;
    try { ctx.debugLog(msg); } catch {}
  }

  function formatPidChain(pidChain) {
    return Array.isArray(pidChain) && pidChain.length
      ? `[${pidChain.join(">")}]`
      : "[]";
  }

  function shouldAutoClearDetachedSession(session, badge) {
    return shouldAutoClearDetachedSessionWithDeps(session, badge, {
      sessionHudCleanupDetached: ctx.sessionHudCleanupDetached === true,
      isProcessAlive,
    });
  }

  function getSessionAliases() {
    if (typeof ctx.getSessionAliases !== "function") return {};
    const aliases = ctx.getSessionAliases();
    return aliases && typeof aliases === "object" && !Array.isArray(aliases)
      ? aliases
      : {};
  }

  function buildSessionSnapshot() {
    return buildSessionSnapshotFromSessions(sessions, {
      sessionAliases: getSessionAliases(),
      statePriority: STATE_PRIORITY,
      sessionHudCleanupDetached: ctx.sessionHudCleanupDetached === true,
      isProcessAlive,
    });
  }

  function getActiveSessionAliasKeys() {
    return getActiveSessionAliasKeysFromSessions(sessions);
  }

  function broadcastSessionSnapshot(snapshot) {
    if (typeof ctx.broadcastSessionSnapshot !== "function") return;
    try { ctx.broadcastSessionSnapshot(snapshot); } catch {}
  }

  function emitSessionSnapshot(options = {}) {
    const force = !!options.force;
    const snapshot = buildSessionSnapshot();
    const signature = sessionSnapshotSignature(snapshot);
    const changed = force || signature !== lastSessionSnapshotSignature;
    lastSessionSnapshot = snapshot;
    if (changed) {
      lastSessionSnapshotSignature = signature;
      broadcastSessionSnapshot(snapshot);
    }
    return { changed, snapshot };
  }

  function getLastSessionSnapshot() {
    if (!lastSessionSnapshot) lastSessionSnapshot = buildSessionSnapshot();
    return lastSessionSnapshot;
  }

  function describeSession(sessionId, session) {
    if (!session) return `sid=${sessionId} <deleted>`;
    return [
      `sid=${sessionId}`,
      `state=${session.state || "-"}`,
      `resume=${session.resumeState || "-"}`,
      `sourcePid=${session.sourcePid || "-"}`,
      `pidReachable=${session.pidReachable ? 1 : 0}`,
      `headless=${session.headless ? 1 : 0}`,
    ].join(" ");
  }

  function resolvePidReachable(existing, sourcePid) {
    if (sourcePid && isProcessAlive(sourcePid)) return true;
    return existing ? !!existing.pidReachable : false;
  }

  function evictOldestSessionIfNeeded(sessionId) {
    if (sessions.has(sessionId) || sessions.size < MAX_SESSIONS) return;
    let oldestId = null;
    let oldestTime = Infinity;
    for (const [id, s] of sessions) {
      if (s.updatedAt < oldestTime) {
        oldestTime = s.updatedAt;
        oldestId = id;
      }
    }
    if (oldestId) sessions.delete(oldestId);
  }

  // ── Session management ──
  // Session-related fields go through `opts`. Earlier versions took 13
  // positional params — refactored in B2 to an options bag so new fields
  // (sessionTitle, etc.) don't keep extending the argument list.
  function updateSession(sessionId, state, event, opts = {}) {
    try {
      const {
        sourcePid = null,
        wtHwnd = null,
        cwd = null,
        editor = null,
        pidChain = null,
        host = null,
        headless = false,
        platform = null,
        model = null,
        provider = null,
        displayHint = undefined,
        sessionTitle = null,
        preserveState = false,
        hookSource = null,
      } = opts;
      if (startupRecoveryActive) {
        startupRecoveryActive = false;
        if (startupRecoveryTimer) { clearTimeout(startupRecoveryTimer); startupRecoveryTimer = null; }
      }

      if (event === "PermissionRequest") {
        setState("notification");
        return;
      }

      const existing = sessions.get(sessionId);
      const srcPid = sourcePid || (existing && existing.sourcePid) || null;
      const srcWtHwnd = wtHwnd || (existing && existing.wtHwnd) || null;
      const srcCwd = cwd || (existing && existing.cwd) || "";
      const srcEditor = editor || (existing && existing.editor) || null;
      const srcPidChain = (pidChain && pidChain.length) ? pidChain : (existing && existing.pidChain) || null;
      const srcHost = host || (existing && existing.host) || null;
      const srcHeadless = headless || (existing && existing.headless) || false;
      const srcPlatform = platform || (existing && existing.platform) || null;
      const srcModel = model || (existing && existing.model) || null;
      const srcProvider = provider || (existing && existing.provider) || null;
      // Sticky: empty input does not clear an existing title. A session that has
      // ever been named keeps that name until the user explicitly renames it.
      const srcSessionTitle = normalizeTitle(sessionTitle) || (existing && existing.sessionTitle) || null;
      const srcResumeState = (existing && existing.resumeState) || null;
      const preservedState = preserveState && existing ? existing.state : null;

      debugSession(`event ${describeSession(sessionId, existing)} -> incoming=${state}/${event || "-"} hint=${displayHint || "-"} source=${hookSource || "-"}`);

      const pidReachable = resolvePidReachable(existing, srcPid);

      const recentEvents = pushRecentEvent(existing, preservedState || state, event);
      const base = { sourcePid: srcPid, wtHwnd: srcWtHwnd, cwd: srcCwd, editor: srcEditor, pidChain: srcPidChain, host: srcHost, headless: srcHeadless, platform: srcPlatform, model: srcModel, provider: srcProvider, sessionTitle: srcSessionTitle, recentEvents, pidReachable };

      // Evict oldest session if at capacity and this is a new session.
      evictOldestSessionIfNeeded(sessionId);

      if (event === "SessionEnd") {
        const endingSession = sessions.get(sessionId);
        sessions.delete(sessionId);
        debugSession(`session-end delete ${describeSession(sessionId, endingSession)}`);
        cleanStaleSessions();
        if (!endingSession || !endingSession.headless) {
          // /clear sends sweeping — play it even if other sessions are active
          // (sweeping is ONESHOT and auto-returns, so it won't interfere)
          if (state === "sweeping") {
            setState("sweeping");
            return;
          }
        }
        const displayState = resolveDisplayState();
        setState(displayState, getSvgOverride(displayState));
        return;
      } else if (preservedState) {
        const dh = pickDisplayHint(preservedState, existing, displayHint);
        sessions.set(sessionId, {
          state: preservedState,
          updatedAt: Date.now(),
          displayHint: dh,
          ...base,
          resumeState: srcResumeState,
        });
      } else if (state === "attention" || state === "notification" || SLEEP_SEQUENCE.has(state)) {
        sessions.set(sessionId, { state: "idle", updatedAt: Date.now(), displayHint: null, ...base, resumeState: null });
      } else if (ONESHOT_STATES.has(state)) {
        if (existing) {
          Object.assign(existing, base);
          existing.state = "idle";
          existing.updatedAt = Date.now();
          existing.displayHint = null;
          existing.resumeState = null;
        } else {
          sessions.set(sessionId, { state: "idle", updatedAt: Date.now(), displayHint: null, ...base, resumeState: null });
        }
      } else {
        if (existing && existing.state === "juggling" && state === "working") {
          existing.updatedAt = Date.now();
          existing.displayHint = pickDisplayHint("juggling", existing, displayHint);
          debugSession(`juggling-hold ${describeSession(sessionId, existing)} event=${event || "-"}`);
        } else {
          const dh = pickDisplayHint(state, existing, displayHint);
          sessions.set(sessionId, { state, updatedAt: Date.now(), displayHint: dh, ...base, resumeState: null });
        }
      }
      cleanStaleSessions();

      if (ONESHOT_STATES.has(state)) {
        setState(state);
        return;
      }

      const displayState = resolveDisplayState();
      setState(displayState, getSvgOverride(displayState));
    } finally {
      emitSessionSnapshot();
    }
  }

  function isProcessAlive(pid) {
    try { _kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
  }

  function cleanStaleSessions() {
    const now = Date.now();
    let changed = false;
    let snapshotRefreshNeeded = false;
    for (const [id, s] of sessions) {
      const decision = getStaleSessionDecision(s, {
        now,
        isProcessAlive,
        deriveSessionBadge,
        shouldAutoClearDetachedSession,
      });

      if (decision.snapshotRefreshNeeded) snapshotRefreshNeeded = true;

      if (decision.action === "delete") {
        const badgeSuffix = decision.reason === "detached-ended" ? ` badge=${decision.badge}` : "";
        debugSession(`stale-delete ${decision.reason} ${describeSession(id, s)}${badgeSuffix}`);
        sessions.delete(id);
        changed = true;
        continue;
      }

      if (decision.action === "idle") {
        debugSession(`stale-idle ${decision.reason} ${describeSession(id, s)}`);
        s.state = "idle"; s.displayHint = null;
        if (decision.updateTimestamp) s.updatedAt = now;
        changed = true;
      }
    }
    if (changed && sessions.size === 0) {
      setState("idle", SVG_IDLE_FOLLOW);
    } else if (changed) {
      const resolved = resolveDisplayState();
      setState(resolved, getSvgOverride(resolved));
    }
    if (changed || snapshotRefreshNeeded) emitSessionSnapshot();

    if (startupRecoveryActive && sessions.size === 0) {
      detectRunningAgentProcesses((found) => {
        if (!found) {
          startupRecoveryActive = false;
          if (startupRecoveryTimer) { clearTimeout(startupRecoveryTimer); startupRecoveryTimer = null; }
        }
      });
    }
  }

  function dismissSession(sessionId) {
    const id = typeof sessionId === "string" ? sessionId : "";
    if (!id) return false;
    const session = sessions.get(id);
    if (!session) return false;
    sessions.delete(id);
    const resolved = resolveDisplayState();
    setState(resolved, getSvgOverride(resolved));
    emitSessionSnapshot({ force: true });
    return true;
  }

  function detectRunningAgentProcesses(callback) {
    if (_detectInFlight) return;
    _detectInFlight = true;
    const done = (result) => { _detectInFlight = false; callback(result); };
    if (typeof ctx.hasAnyEnabledAgent === "function" && !ctx.hasAnyEnabledAgent()) {
      done(false);
      return;
    }
    const { execFile, exec } = require("child_process");
    if (process.platform === "win32") {
      const psScript =
        "$names = 'claude.exe','codex.exe','copilot.exe','gemini.exe','codebuddy.exe','kiro-cli.exe','kimi.exe','opencode.exe','pi.exe','hermes.exe'; " +
        "$match = Get-CimInstance Win32_Process | Where-Object { " +
        "$names -contains $_.Name -or ($_.Name -eq 'node.exe' -and $_.CommandLine -like '*claude-code*') " +
        "} | Select-Object -First 1; " +
        "if ($match) { $match.ProcessId }";
      execFile(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", psScript],
        { encoding: "utf8", timeout: 5000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
        (err, stdout) => done(!err && /\d+/.test(stdout))
      );
    } else {
      exec("pgrep -f 'claude-code|codex|copilot|codebuddy|kimi|@earendil-works/pi-coding-agent|pi-coding-agent/dist/cli\\.js' || pgrep -x 'gemini' || pgrep -x 'kiro-cli' || pgrep -x 'opencode' || pgrep -x 'hermes'", { timeout: 3000 },
        (err) => done(!err)
      );
    }
  }

  function startStaleCleanup() {
    if (staleCleanupTimer) return;
    staleCleanupTimer = setInterval(cleanStaleSessions, 10000);
  }

  function stopStaleCleanup() {
    if (staleCleanupTimer) { clearInterval(staleCleanupTimer); staleCleanupTimer = null; }
  }

  function resolveDisplayState() {
    return resolveDisplayStateFromSessions(sessions, {
      statePriority: STATE_PRIORITY,
      updateVisualState,
      updateVisualPriority,
    });
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
    return getSvgOverrideWithDeps(state, {
      updateVisualState,
      updateVisualSvgOverride,
      idleFollowSvg: SVG_IDLE_FOLLOW,
      sessions,
      displayHintMap: DISPLAY_HINT_MAP,
      theme,
      stateSvgs: STATE_SVGS,
    });
  }

  // ── Session Dashboard ──
  function formatElapsed(ms) {
    const sec = Math.floor(ms / 1000);
    if (sec < 60) return ctx.t("sessionJustNow");
    const min = Math.floor(sec / 60);
    if (min < 60) return ctx.t("sessionMinAgo").replace("{n}", min);
    const hr = Math.floor(min / 60);
    return ctx.t("sessionHrAgo").replace("{n}", hr);
  }

  // ── Do Not Disturb ──
  function enableDoNotDisturb() {
    if (ctx.doNotDisturb) return;
    ctx.doNotDisturb = true;
    ctx.sendToRenderer("dnd-change", true);
    ctx.sendToHitWin("hit-state-sync", { dndEnabled: true });
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

  function startStartupRecovery() {
    startupRecoveryActive = true;
    startupRecoveryTimer = setTimeout(() => {
      startupRecoveryActive = false;
      startupRecoveryTimer = null;
    }, STARTUP_RECOVERY_MAX_MS);
  }

  function getCurrentState() { return currentState; }
  function getCurrentSvg() { return currentSvg; }
  function getCurrentHitBox() { return currentHitBox; }
  function getStartupRecoveryActive() { return startupRecoveryActive; }

  function cleanup() {
    if (pendingTimer) clearTimeout(pendingTimer);
    if (autoReturnTimer) clearTimeout(autoReturnTimer);
    if (eyeResendTimer) clearTimeout(eyeResendTimer);
    if (startupRecoveryTimer) clearTimeout(startupRecoveryTimer);
    if (wakePollTimer) clearInterval(wakePollTimer);
    stopStaleCleanup();
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
    deriveSessionBadge,
    getCurrentState, getCurrentSvg, getCurrentHitBox, getStartupRecoveryActive,
    sessions, STATE_PRIORITY, ONESHOT_STATES, SLEEP_SEQUENCE,
    get STATE_SVGS() { return STATE_SVGS; },
    get HIT_BOXES() { return HIT_BOXES; },
    get FILE_HIT_BOXES() { return FILE_HIT_BOXES; },
    get WIDE_SVGS() { return WIDE_SVGS; },
    cleanup,
    setDockWalkActive(v) { dockWalkActive = !!v; },
    getDockWalkActive() { return dockWalkActive; },
  };

};
