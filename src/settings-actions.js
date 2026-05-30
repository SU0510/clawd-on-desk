"use strict";

// ── Settings actions (transport-agnostic) ──
//
// Two registries:
//
// updateRegistry — single-field updates. Each entry is EITHER:
//
// (a) a plain function `(value, deps) => { status, message? }` —
// a PURE VALIDATOR with no side effect. Used for fields whose
// truth lives entirely inside prefs (lang, soundMuted, ...).
// Reactive UI projection lives in main.js subscribers.
//
// (b) an object `{ validate, effect }` — a PRE-COMMIT GATE for
// fields whose truth depends on the OUTSIDE WORLD (the OS login
// items database, etc.). The effect
// actually performs the system call; if it fails, the controller
// does NOT commit, so prefs cannot drift away from system reality.
// Effects can be sync or async; effects throw → controller wraps
// as { status: 'error' }.
//
// Why both forms coexist: the gate-vs-projection split is real (see
// plan-settings-panel.md §4.2). Forcing every entry to be a gate
// would create empty effect functions for pure-data fields and blur
// the contract. Forcing every effect into a subscriber would make
// "save the system call's failure" impossible because subscribers
// run AFTER commit and can't unwind it.
//
// commandRegistry — non-field actions like `removeTheme`,
// `registerShortcut`. These return
// `{ status, message?, commit? }`. If `commit` is present,
// the controller calls `_commit(commit)` after success so
// commands can update store fields atomically with their
// side effects.
//
// This module imports nothing from electron, the store, or the controller.
// All deps that an action needs are passed via the second argument:
//
// actionFn(value, { snapshot, ...injectedDeps })
//
// `injectedDeps` is whatever main.js passed to `createSettingsController`. For
// effect-bearing entries this MUST include the system helpers the effect
// needs (e.g. `setLoginItem`) — actions never `require()`
// electron or fs directly so the test suite can inject mocks.
//
// HYDRATE PATH: `controller.hydrate(partial)` runs only the validator and
// SKIPS the effect. This is how startup imports system-backed values into
// prefs without writing them right back. Object-form entries must therefore
// keep validate side-effect-free.

const { CURRENT_VERSION } = require("./prefs");
const { isValidDisplaySnapshot } = require("./work-area");
const { validateShortcutMapShape } = require("./shortcut-actions");
const {
  requireBoolean,
  requireFiniteNumber,
  requireNonNegativeFiniteNumber,
  requireNumberInRange,
  requireEnum,
  requireString,
  requirePlainObject,
} = require("./settings-validators");
const {
  registerShortcut,
  resetShortcut,
  resetAllShortcuts,
} = require("./settings-actions-shortcuts");
const {
  ANIMATION_OVERRIDES_EXPORT_VERSION,
  ONESHOT_OVERRIDE_STATES,
  importAnimationOverrides,
  resetThemeOverrides,
  setAnimationOverride,
  setSoundOverride,
  setThemeOverrideDisabled,
  setWideHitboxOverride,
} = require("./settings-actions-theme-overrides");
const {
  createRepairDoctorIssue,
  openAtLogin,
  repairLocalServer,
} = require("./settings-actions-system");

// ── updateRegistry ──
// Maps prefs field name → validator. Controller looks up by key and runs.

const updateRegistry = {
  // ── Window state ──
  x: requireFiniteNumber("x"),
  y: requireFiniteNumber("y"),
  size(value) {
    if (typeof value !== "string") {
      return { status: "error", message: "size must be a string" };
    }
    if (value === "S" || value === "M" || value === "L") return { status: "ok" };
    if (/^P:\d+(?:\.\d+)?$/.test(value)) return { status: "ok" };
    return {
      status: "error",
      message: `size must be S/M/L or P:<num>, got: ${value}`,
    };
  },

  // ── Mini mode persisted state ──
  miniMode: requireBoolean("miniMode"),
  miniEdge: requireEnum("miniEdge", ["left", "right"]),
  preMiniX: requireFiniteNumber("preMiniX"),
  preMiniY: requireFiniteNumber("preMiniY"),
  positionSaved: requireBoolean("positionSaved"),
  positionThemeId: requireString("positionThemeId", { allowEmpty: true }),
  positionVariantId: requireString("positionVariantId", { allowEmpty: true }),
  positionDisplay: (value) => {
    if (value === null || isValidDisplaySnapshot(value)) return { status: "ok" };
    return { status: "error", message: "positionDisplay must be null or a valid display snapshot" };
  },
  savedPixelWidth: requireNonNegativeFiniteNumber("savedPixelWidth"),
  savedPixelHeight: requireNonNegativeFiniteNumber("savedPixelHeight"),

  // ── Pure data prefs (function-form: validator only) ──
  lang: requireEnum("lang", ["en", "zh", "zh-TW", "ko", "ja"]),
  soundMuted: requireBoolean("soundMuted"),
  soundVolume: requireNumberInRange("soundVolume", 0, 1),
  lowPowerIdleMode: requireBoolean("lowPowerIdleMode"),
  sessionHudEnabled: requireBoolean("sessionHudEnabled"),
  sessionHudShowElapsed: requireBoolean("sessionHudShowElapsed"),
  sessionHudCleanupDetached: requireBoolean("sessionHudCleanupDetached"),
  sessionHudAutoHide: requireBoolean("sessionHudAutoHide"),
  sessionHudPinned: requireBoolean("sessionHudPinned"),
  hideBubbles: requireBoolean("hideBubbles"),
  allowEdgePinning: requireBoolean("allowEdgePinning"),
  keepSizeAcrossDisplays: requireBoolean("keepSizeAcrossDisplays"),

  // ── System-backed prefs (object-form: validate + effect pre-commit gate) ──
  openAtLogin,

  openAtLoginHydrated: requireBoolean("openAtLoginHydrated"),

  // ── macOS visibility (cross-field validation) ──
  showTray(value, { snapshot }) {
    if (typeof value !== "boolean") {
      return { status: "error", message: "showTray must be a boolean" };
    }
    if (!value && snapshot && snapshot.showDock === false) {
      return {
        status: "error",
        message: "Cannot hide Menu Bar while Dock is also hidden — Clawd would become unquittable.",
      };
    }
    return { status: "ok" };
  },
  showDock(value, { snapshot }) {
    if (typeof value !== "boolean") {
      return { status: "error", message: "showDock must be a boolean" };
    }
    if (!value && snapshot && snapshot.showTray === false) {
      return {
        status: "error",
        message: "Cannot hide Dock while Menu Bar is also hidden — Clawd would become unquittable.",
      };
    }
    return { status: "ok" };
  },

  // Strict activation gate. Startup uses the lenient path + hydrate() so
  // a deleted theme can't brick boot without polluting this effect.
  theme: {
    validate: requireString("theme"),
    effect(value, deps) {
      if (!deps || typeof deps.activateTheme !== "function") {
        return {
          status: "error",
          message: "theme effect requires activateTheme dep",
        };
      }
      try {
        const snapshot = (deps && deps.snapshot) || {};
        const currentOverrides = snapshot.themeOverrides || {};
        deps.activateTheme(value, null, currentOverrides[value] || null);
        return { status: "ok" };
      } catch (err) {
        return {
          status: "error",
          message: `theme: ${err && err.message}`,
        };
      }
    },
  },

  themeOverrides: requirePlainObject("themeOverrides"),

  // Phase 3b-swap: per-theme variant selection. NO effect — the runtime switch
  // runs through the `setThemeSelection` command which atomically commits
  // `theme` + `themeVariant` after calling activateTheme(themeId, variantId).
  themeVariant: requirePlainObject("themeVariant"),

  shortcuts: {
    validate(value) {
      return validateShortcutMapShape(value);
    },
  },

  // ── Internal — version is owned by prefs.js / migrate(), shouldn't normally
  // be set via applyUpdate, but we accept it so programmatic upgrades work. ──
  version(value) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
      return { status: "error", message: "version must be a positive number" };
    }
    if (value > CURRENT_VERSION) {
      return {
        status: "error",
        message: `version ${value} is newer than supported (${CURRENT_VERSION})`,
      };
    }
    return { status: "ok" };
  },
};

// ── commandRegistry ──
// Non-field actions.

const _validateRemoveThemeId = requireString("removeTheme.themeId");
async function removeTheme(payload, deps) {
  const themeId = typeof payload === "string" ? payload : (payload && payload.themeId);
  const idCheck = _validateRemoveThemeId(themeId);
  if (idCheck.status !== "ok") return idCheck;

  if (!deps || typeof deps.getThemeInfo !== "function" || typeof deps.removeThemeDir !== "function") {
    return {
      status: "error",
      message: "removeTheme effect requires getThemeInfo and removeThemeDir deps",
    };
  }

  let info;
  try {
    info = deps.getThemeInfo(themeId);
  } catch (err) {
    return { status: "error", message: `removeTheme: ${err && err.message}` };
  }
  if (!info) {
    return { status: "error", message: `removeTheme: theme "${themeId}" not found` };
  }
  if (info.builtin) {
    return { status: "error", message: `removeTheme: cannot delete built-in theme "${themeId}"` };
  }
  if (info.active) {
    return {
      status: "error",
      message: `removeTheme: cannot delete active theme "${themeId}" — switch to another theme first`,
    };
  }
  if (info.managedCodexPet) {
    return {
      status: "error",
      message: `removeTheme: cannot delete managed Codex Pet theme "${themeId}" — remove it from Petdex instead`,
    };
  }

  try {
    await deps.removeThemeDir(themeId);
  } catch (err) {
    return { status: "error", message: `removeTheme: ${err && err.message}` };
  }

  const snapshot = deps.snapshot || {};
  const currentOverrides = snapshot.themeOverrides || {};
  const currentVariantMap = snapshot.themeVariant || {};
  const nextCommit = {};
  if (currentOverrides[themeId]) {
    const nextOverrides = { ...currentOverrides };
    delete nextOverrides[themeId];
    nextCommit.themeOverrides = nextOverrides;
  }
  if (currentVariantMap[themeId] !== undefined) {
    const nextVariantMap = { ...currentVariantMap };
    delete nextVariantMap[themeId];
    nextCommit.themeVariant = nextVariantMap;
  }
  if (Object.keys(nextCommit).length > 0) {
    return { status: "ok", commit: nextCommit };
  }
  return { status: "ok" };
}

// Phase 3b-swap: atomic theme + variant switch.
const _validateSetThemeSelectionThemeId = requireString("setThemeSelection.themeId");
function setThemeSelection(payload, deps) {
  const themeId = typeof payload === "string" ? payload : (payload && payload.themeId);
  const variantIdInput = (payload && typeof payload === "object") ? payload.variantId : null;
  const idCheck = _validateSetThemeSelectionThemeId(themeId);
  if (idCheck.status !== "ok") return idCheck;
  if (variantIdInput != null && (typeof variantIdInput !== "string" || !variantIdInput)) {
    return { status: "error", message: "setThemeSelection.variantId must be a non-empty string when provided" };
  }

  if (!deps || typeof deps.activateTheme !== "function") {
    return { status: "error", message: "setThemeSelection effect requires activateTheme dep" };
  }

  const snapshot = deps.snapshot || {};
  const currentVariantMap = snapshot.themeVariant || {};
  const currentOverrides = snapshot.themeOverrides || {};
  const targetVariant = variantIdInput || currentVariantMap[themeId] || "default";
  const targetOverrideMap = currentOverrides[themeId] || null;

  let resolved;
  try {
    resolved = deps.activateTheme(themeId, targetVariant, targetOverrideMap);
  } catch (err) {
    return { status: "error", message: `setThemeSelection: ${err && err.message}` };
  }
  const resolvedVariant = (resolved && typeof resolved === "object" && typeof resolved.variantId === "string")
    ? resolved.variantId
    : targetVariant;

  const nextVariantMap = { ...currentVariantMap, [themeId]: resolvedVariant };
  return {
    status: "ok",
    commit: { theme: themeId, themeVariant: nextVariantMap },
  };
}

function resizePet(payload, deps) {
  if (typeof payload !== "string" || !/^P:\d+(?:\.\d+)?$/.test(payload)) {
    return { status: "error", message: `resizePet: invalid size "${payload}"` };
  }
  if (!deps || typeof deps.resizePet !== "function") {
    return { status: "error", message: "resizePet requires deps.resizePet" };
  }
  try {
    deps.resizePet(payload);
    return { status: "ok" };
  } catch (err) {
    return { status: "error", message: `resizePet: ${err && err.message}` };
  }
}

const repairDoctorIssue = createRepairDoctorIssue({});

const commandRegistry = {
  removeTheme,
  repairLocalServer,
  repairDoctorIssue,
  resizePet,
  registerShortcut,
  resetShortcut,
  resetAllShortcuts,
  setAnimationOverride,
  setSoundOverride,
  setThemeOverrideDisabled,
  resetThemeOverrides,
  importAnimationOverrides,
  setWideHitboxOverride,
  setThemeSelection,
};

module.exports = {
  updateRegistry,
  commandRegistry,
  ONESHOT_OVERRIDE_STATES,
  ANIMATION_OVERRIDES_EXPORT_VERSION,
  // Exposed for tests
  requireBoolean,
  requireFiniteNumber,
  requireEnum,
  requireString,
  requirePlainObject,
};
