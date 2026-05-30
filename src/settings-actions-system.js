"use strict";

const { requireBoolean } = require("./settings-validators");

// openAtLogin writes the OS login item entry. Truth lives in the OS and the
// inverse system-to-prefs hydration stays in main.js.
const openAtLogin = {
  validate: requireBoolean("openAtLogin"),
  effect(value, deps) {
    if (!deps || typeof deps.setOpenAtLogin !== "function") {
      return {
        status: "error",
        message: "openAtLogin effect requires setOpenAtLogin dep",
      };
    }
    try {
      deps.setOpenAtLogin(value);
      return { status: "ok" };
    } catch (err) {
      return {
        status: "error",
        message: `openAtLogin: ${err && err.message}`,
      };
    }
  },
};

async function repairLocalServer(_payload, deps) {
  if (!deps || typeof deps.repairLocalServer !== "function") {
    return {
      status: "error",
      message: "repairLocalServer requires repairLocalServer dep",
    };
  }
  try {
    const result = await deps.repairLocalServer();
    if (result === false) {
      return { status: "error", message: "Local server repair failed" };
    }
    if (result && typeof result === "object" && result.status && result.status !== "ok") {
      return {
        status: "error",
        message: result.message || "Local server repair failed",
      };
    }
    return { status: "ok" };
  } catch (err) {
    return {
      status: "error",
      message: `repairLocalServer: ${err && err.message}`,
    };
  }
}

function restartClawd(payload, deps) {
  if (!payload || payload.confirmed !== true) {
    return { status: "error", message: "restartClawd requires confirmation" };
  }
  if (!deps || typeof deps.restartClawd !== "function") {
    return { status: "error", message: "restartClawd requires deps.restartClawd" };
  }
  try {
    deps.restartClawd();
    return { status: "ok", message: "Clawd is restarting" };
  } catch (err) {
    return { status: "error", message: `restartClawd: ${err && err.message}` };
  }
}

function createRepairDoctorIssue() {
  return async function repairDoctorIssue(payload, deps) {
    if (!payload || typeof payload !== "object") {
      return { status: "error", message: "repairDoctorIssue payload must be an object" };
    }
    const { type } = payload;
    if (type === "theme-health") {
      return {
        status: "error",
        message: "Theme health issues must be fixed manually in Settings -> Theme",
      };
    }
    if (type === "local-server") {
      return repairLocalServer(payload, deps);
    }
    if (type === "restart-clawd") {
      return restartClawd(payload, deps);
    }
    return {
      status: "error",
      message: `Unknown Doctor repair target: ${type || "missing"}`,
    };
  };
}

module.exports = {
  createRepairDoctorIssue,
  openAtLogin,
  repairLocalServer,
  restartClawd,
};
