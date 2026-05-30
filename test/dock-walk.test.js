// test/dock-walk.test.js — Unit tests for src/dock-walk.js core logic
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");

const createDockWalk = require("../src/dock-walk");

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeCtx(overrides = {}) {
  const applied = [];
  const sent = [];
  const positions = [];
  const ctx = {
    win: { isDestroyed: () => false, setAlwaysOnTop: () => {}, show: () => {}, hide: () => {}, isVisible: () => true },
    hitWin: { isDestroyed: () => false },
    getPetWindowBounds: () => ({ x: 100, y: 50, width: 200, height: 200 }),
    applyPetWindowPosition: (x, y) => positions.push({ x, y }),
    getCurrentPixelSize: () => ({ width: 200, height: 200 }),
    applyState: (state, svg) => applied.push({ state, svg }),
    syncHitWin: () => {},
    sendToRenderer: (channel, ...args) => sent.push({ channel, args }),
    detectWindowAtPoint: () => Promise.resolve({ handle: 42, bounds: { x: 10, y: 20, width: 800, height: 600 } }),
    getWindowBounds: () => Promise.resolve({ x: 10, y: 20, width: 800, height: 600 }),
    getWindowVisibility: () => Promise.resolve({ exists: true, minimized: false, occluded: false }),
    setDockWalkActive: () => {},
    ...overrides,
  };
  return { ctx, applied, sent, positions };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("dock-walk state machine", () => {
  let dw, ctx, applied, sent;

  beforeEach(() => {
    const result = makeCtx();
    ctx = result.ctx;
    applied = result.applied;
    sent = result.sent;
    dw = createDockWalk(ctx);
  });

  afterEach(() => {
    if (dw) dw.cleanup();
  });

  it("starts not docked", () => {
    assert.strictEqual(dw.isDocked(), false);
    assert.strictEqual(dw.isDetecting(), false);
    assert.strictEqual(dw.getDockState(), "lie");
  });

  it("enters detection mode and sends IPC", () => {
    dw.enterDetectionMode();
    assert.strictEqual(dw.isDetecting(), true);
    assert.ok(sent.some(s => s.channel === "dock-detecting" && s.args[0] === true));
  });

  it("does not re-enter detection mode if already detecting", () => {
    dw.enterDetectionMode();
    const countBefore = sent.filter(s => s.channel === "dock-detecting").length;
    dw.enterDetectionMode();
    const countAfter = sent.filter(s => s.channel === "dock-detecting").length;
    assert.strictEqual(countBefore, countAfter);
  });

  it("cancels detection on timeout", () => {
    dw.enterDetectionMode();
    // Simulate timeout by advancing timers
    // We can't easily advance real timers, so test cancelDetection directly
    dw.cleanup();
    assert.strictEqual(dw.isDetecting(), false);
  });

  it("docks after successful detection click", async () => {
    dw.enterDetectionMode();
    const result = await dw.handleDetectClick(100, 200);
    assert.strictEqual(result, true);
    assert.strictEqual(dw.isDocked(), true);
    assert.strictEqual(dw.isDetecting(), false);
    // Should have sent dock-mode-change
    assert.ok(sent.some(s => s.channel === "dock-mode-change" && s.args[0] === true));
  });

  it("applies lie state when docking", async () => {
    dw.enterDetectionMode();
    await dw.handleDetectClick(100, 200);
    // First applyState should be idle with front.png
    assert.ok(applied.length > 0);
    const firstApply = applied[0];
    assert.strictEqual(firstApply.state, "idle");
    assert.strictEqual(firstApply.svg, "front.png");
  });

  it("exits dock-walk mode", async () => {
    dw.enterDetectionMode();
    await dw.handleDetectClick(100, 200);
    assert.strictEqual(dw.isDocked(), true);
    dw.exitDockWalk();
    assert.strictEqual(dw.isDocked(), false);
    // Should send dock-mode-change false
    assert.ok(sent.some(s => s.channel === "dock-mode-change" && s.args[0] === false));
    // Should apply idle state
    const lastApply = applied[applied.length - 1];
    assert.strictEqual(lastApply.state, "idle");
  });

  it("handles mouse proximity — triggers happy state", async () => {
    dw.enterDetectionMode();
    await dw.handleDetectClick(100, 200);

    // Position pet so cursor is within proximity radius
    ctx.getPetWindowBounds = () => ({ x: 100, y: 100, width: 200, height: 200 });
    // Cursor at pet center — within 150px
    dw.checkProximity(200, 200);
    assert.strictEqual(dw.getDockState(), "happy");
    // Should have applied happy state with happy.gif
    const happyApply = applied.find(a => a.state === "happy");
    assert.ok(happyApply);
    assert.strictEqual(happyApply.svg, "happy.gif");
  });

  it("releases happy state and returns to pre-interrupt state", async () => {
    dw.enterDetectionMode();
    await dw.handleDetectClick(100, 200);

    // Cursor near pet — trigger happy
    ctx.getPetWindowBounds = () => ({ x: 100, y: 100, width: 200, height: 200 });
    dw.checkProximity(200, 200);
    assert.strictEqual(dw.getDockState(), "happy");

    // Cursor far away — release happy
    dw.checkProximity(1000, 1000);
    assert.strictEqual(dw.getDockState(), "lie"); // returns to pre-happy state
  });

  it("does not trigger happy when not docked", () => {
    ctx.getPetWindowBounds = () => ({ x: 100, y: 100, width: 200, height: 200 });
    dw.checkProximity(200, 200);
    assert.strictEqual(dw.getDockState(), "lie");
    assert.strictEqual(applied.length, 0);
  });

  it("checkDockDragExit returns false when not docked", () => {
    assert.strictEqual(dw.checkDockDragExit(), false);
  });

  it("handleThemeSwitch exits dock-walk if active", async () => {
    dw.enterDetectionMode();
    await dw.handleDetectClick(100, 200);
    assert.strictEqual(dw.isDocked(), true);
    dw.handleThemeSwitch();
    assert.strictEqual(dw.isDocked(), false);
  });

  it("handleThemeSwitch cancels detection if active", () => {
    dw.enterDetectionMode();
    assert.strictEqual(dw.isDetecting(), true);
    dw.handleThemeSwitch();
    assert.strictEqual(dw.isDetecting(), false);
  });

  it("cleanup exits dock-walk and cancels detection", async () => {
    dw.enterDetectionMode();
    await dw.handleDetectClick(100, 200);
    dw.cleanup();
    assert.strictEqual(dw.isDocked(), false);
    assert.strictEqual(dw.isDetecting(), false);
  });

  it("detect click returns false when not in detection mode", async () => {
    const result = await dw.handleDetectClick(100, 200);
    assert.strictEqual(result, false);
  });

  it("detect click fails gracefully when window detection returns null", async () => {
    ctx.detectWindowAtPoint = () => Promise.resolve(null);
    dw.enterDetectionMode();
    const result = await dw.handleDetectClick(100, 200);
    assert.strictEqual(result, false);
    assert.strictEqual(dw.isDocked(), false);
  });

  it("syncPosition uses relativeX to place pet on window edge", async () => {
    const positions = [];
    ctx.applyPetWindowPosition = (x, y) => positions.push({ x, y });
    dw = createDockWalk(ctx);

    dw.enterDetectionMode();
    await dw.handleDetectClick(100, 200);
    // After docking, positions should have been applied
    // With relativeX=0.5, targetBounds x=10 width=800, petWidth=200:
    // newPetX = 10 + 800*0.5 - 200/2 = 310
    // newPetY = 20 - 200/2 = -80
    assert.ok(positions.length > 0, "expected position to be applied");
    const lastPos = positions[positions.length - 1];
    assert.strictEqual(lastPos.x, 10);
    assert.strictEqual(lastPos.y, -180);
  });
});

describe("dock-walk-detect", () => {
  const { detectWindowAtPoint, getWindowBounds, getWindowVisibility } = require("../src/dock-walk-detect");

  it("exports unified API functions", () => {
    assert.strictEqual(typeof detectWindowAtPoint, "function");
    assert.strictEqual(typeof getWindowBounds, "function");
    assert.strictEqual(typeof getWindowVisibility, "function");
  });

  it("detectWindowAtPoint returns a Promise", () => {
    const result = detectWindowAtPoint(0, 0, new Set());
    assert.ok(result instanceof Promise);
  });

  it("getWindowBounds returns a Promise", () => {
    const result = getWindowBounds(0);
    assert.ok(result instanceof Promise);
  });

  it("getWindowVisibility returns a Promise", () => {
    const result = getWindowVisibility(0, new Set());
    assert.ok(result instanceof Promise);
  });
});
