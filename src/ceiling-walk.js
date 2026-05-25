// src/ceiling-walk.js — Ceiling walk mode (stick to top edge, walk along it)
//
// When the pet is near the top edge of the screen work area, it can
// snap to the ceiling and walk along it. The pet is displayed flipped
// vertically (upside-down) to look like it's hanging from the ceiling.

const { screen } = require("electron");

const CEILING_SNAP_TOLERANCE = 40; // px from top edge to trigger snap
const CEILING_EXIT_TOLERANCE = 80; // px from top edge — must drag further to exit
const CEILING_WALK_SPEED = 0.06; // px/ms
const CEILING_WALK_DIR_CHANGE_MS = 4000; // auto-change direction interval
const CEILING_FLIP_Y = true; // flip pet vertically when on ceiling

module.exports = function initCeilingWalk(ctx) {
  let ceilingMode = false;
  let ceilingTransitioning = false;
  let ceilingDirection = 1; // 1 = right, -1 = left
  let ceilingWalkTimer = null;
  let ceilingDirChangeTimer = null;
  let preCeilingX = 0;
  let preCeilingY = 0;

  function getCeilingMode() { return ceilingMode; }
  function getCeilingTransitioning() { return ceilingTransitioning; }
  function getPreCeilingPos() { return { x: preCeilingX, y: preCeilingY }; }

  function getWorkArea() {
    const bounds = ctx.getPetWindowBounds();
    const wa = ctx.getNearestWorkArea(
      bounds.x + bounds.width / 2,
      bounds.y + bounds.height / 2
    );
    return wa || { x: 0, y: 0, width: 800, height: 600 };
  }

  // Check if the pet is near enough to the top edge to snap
  function isNearCeilingEdge(bounds) {
    const wa = getWorkArea();
    const petTop = bounds.y;
    const ceilingY = wa.y;
    return petTop <= ceilingY + CEILING_SNAP_TOLERANCE;
  }

  // Check if a dragged position should exit ceiling mode
  function shouldExitCeiling(bounds) {
    const wa = getWorkArea();
    const petTop = bounds.y;
    const ceilingY = wa.y;
    return petTop > ceilingY + CEILING_EXIT_TOLERANCE;
  }

  // Enter ceiling mode: snap pet to top edge
  function enterCeilingMode() {
    if (ceilingMode || ceilingTransitioning) return;
    const bounds = ctx.getPetWindowBounds();
    if (!isNearCeilingEdge(bounds)) return;

    ceilingTransitioning = true;
    preCeilingX = bounds.x;
    preCeilingY = bounds.y;

    const wa = getWorkArea();
    const size = ctx.getCurrentPixelSize();
    // Place pet at top edge, centered on current x
    const snapY = wa.y - 2; // slightly overlap the top edge
    const clampedX = Math.max(wa.x, Math.min(bounds.x, wa.x + wa.width - size.width));

    ctx.applyPetWindowPosition(clampedX, snapY);
    ctx.sendToRenderer("ceiling-mode-change", true, CEILING_FLIP_Y);
    ctx.applyState("happy"); // initial ceiling state
    ceilingMode = true;
    ceilingTransitioning = false;

    // Start auto-walk
    startCeilingWalk();
    startDirectionChangeTimer();
  }

  // Exit ceiling mode: return to normal
  function exitCeilingMode() {
    if (!ceilingMode) return;
    ceilingMode = false;
    stopCeilingWalk();
    stopDirectionChangeTimer();

    ctx.sendToRenderer("ceiling-mode-change", false, false);
    ctx.applyState("idle");
  }

  // Check drag-end: snap to ceiling or exit
  function checkCeilingSnap() {
    if (ceilingMode) return;
    const bounds = ctx.getPetWindowBounds();
    if (isNearCeilingEdge(bounds)) {
      enterCeilingMode();
    }
  }

  // Check if drag should exit ceiling mode
  function checkCeilingDragExit() {
    if (!ceilingMode) return false;
    const bounds = ctx.getPetWindowBounds();
    if (shouldExitCeiling(bounds)) {
      exitCeilingMode();
      return true;
    }
    return false;
  }

  // Walking animation along the ceiling
  function startCeilingWalk() {
    stopCeilingWalk();
    const step = () => {
      if (!ceilingMode || ceilingTransitioning) return;
      const bounds = ctx.getPetWindowBounds();
      const wa = getWorkArea();
      const size = ctx.getCurrentPixelSize();
      const stepPx = ceilingDirection * CEILING_WALK_SPEED * 16; // ~16ms per frame
      let newX = bounds.x + stepPx;

      // Bounce at edges
      if (newX <= wa.x) {
        newX = wa.x;
        ceilingDirection = 1;
      } else if (newX + size.width >= wa.x + wa.width) {
        newX = wa.x + wa.width - size.width;
        ceilingDirection = -1;
      }

      ctx.applyPetWindowPosition(newX, bounds.y);
      ctx.syncHitWin();
      ceilingWalkTimer = setTimeout(step, 16);
    };
    ceilingWalkTimer = setTimeout(step, 100); // small delay after entering
  }

  function stopCeilingWalk() {
    if (ceilingWalkTimer) {
      clearTimeout(ceilingWalkTimer);
      ceilingWalkTimer = null;
    }
  }

  // Auto-change walking direction periodically
  function startDirectionChangeTimer() {
    stopDirectionChangeTimer();
    const change = () => {
      if (!ceilingMode) return;
      ceilingDirection = ceilingDirection === 1 ? -1 : 1;
      ceilingDirChangeTimer = setTimeout(change, CEILING_WALK_DIR_CHANGE_MS + Math.random() * 3000);
    };
    ceilingDirChangeTimer = setTimeout(change, CEILING_WALK_DIR_CHANGE_MS);
  }

  function stopDirectionChangeTimer() {
    if (ceilingDirChangeTimer) {
      clearTimeout(ceilingDirChangeTimer);
      ceilingDirChangeTimer = null;
    }
  }

  function cleanup() {
    stopCeilingWalk();
    stopDirectionChangeTimer();
    ceilingMode = false;
    ceilingTransitioning = false;
  }

  return {
    getCeilingMode,
    getCeilingTransitioning,
    getPreCeilingPos,
    enterCeilingMode,
    exitCeilingMode,
    checkCeilingSnap,
    checkCeilingDragExit,
    cleanup,
  };
};
