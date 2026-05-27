// --- Input window: pointer capture, drag, click detection ---
// This is the "controller" — all input decisions happen here.
// Render window is pure "view" — receives reaction commands via IPC relay.

const area = document.getElementById("hit-area");

// ── Theme config (injected via preload-hit.js additionalArguments) ──
let tc = window.hitThemeConfig || {};
let _reactions = (tc && tc.reactions) || {};

// Theme switch: IPC push overrides additionalArguments
if (window.hitAPI && window.hitAPI.onThemeConfig) {
	window.hitAPI.onThemeConfig((cfg) => {
		tc = cfg || {};
		_reactions = (tc && tc.reactions) || {};
	});
}

// --- State synced from main ---
let currentSvg = null;
let currentState = null;
let miniMode = false;
let dndEnabled = false;

window.hitAPI.onStateSync((data) => {
	if (data.currentSvg !== undefined) currentSvg = data.currentSvg;
	if (data.currentState !== undefined) currentState = data.currentState;
	if (data.miniMode !== undefined) {
		miniMode = data.miniMode;
		area.style.cursor = miniMode ? "default" : "";
	}
	if (data.dndEnabled !== undefined) dndEnabled = data.dndEnabled;
});

// --- Dock-walk detection overlay ---
let dockDetecting = false;
const overlay = document.createElement("div");
overlay.id = "dock-detect-overlay";
overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.3);display:none;pointer-events:none;z-index:9999;";
const hintText = document.createElement("div");
hintText.style.cssText = "position:absolute;top:15%;left:50%;transform:translateX(-50%);color:rgba(255,255,255,0.85);font-size:28px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;text-align:center;text-shadow:0 2px 8px rgba(0,0,0,0.6);pointer-events:none;user-select:none;";
hintText.textContent = "Click a window to dock";
const highlight = document.createElement("div");
highlight.style.cssText = "position:absolute;width:60px;height:60px;border-radius:50%;border:2px solid rgba(100,200,255,0.7);background:rgba(100,200,255,0.08);transform:translate(-50%,-50%);pointer-events:none;display:none;transition:left 0.05s,top 0.05s;";
overlay.appendChild(hintText);
overlay.appendChild(highlight);
document.body.appendChild(overlay);

if (window.hitAPI && window.hitAPI.onDockDetectingSync) {
	window.hitAPI.onDockDetectingSync((active, hint) => {
		dockDetecting = active;
		overlay.style.display = active ? "block" : "none";
		highlight.style.display = active ? "block" : "none";
		if (hint) hintText.textContent = hint;
		area.style.cursor = active ? "crosshair" : (miniMode ? "default" : "");
	});
}
if (window.hitAPI && window.hitAPI.onDockDetectCancelled) {
	// Listen for cancel via a separate channel if available; otherwise rely on onDockDetectingSync(false)
}

// Track cursor position for highlight
document.addEventListener("pointermove", (e) => {
	if (dockDetecting) {
		highlight.style.left = e.clientX + "px";
		highlight.style.top = e.clientY + "px";
	}
	if (isDragging) {
		if (!didDrag) {
			const totalDx = e.clientX - mouseDownX;
			const totalDy = e.clientY - mouseDownY;
			if (Math.abs(totalDx) > DRAG_THRESHOLD || Math.abs(totalDy) > DRAG_THRESHOLD) {
				didDrag = true;
				startDragReaction();
			}
		}
		queueDragMove();
	}
});

// --- Drag state ---
let isDragging = false;
let didDrag = false;
let mouseDownX, mouseDownY;
let dragMoveRAF = null;
const DRAG_THRESHOLD = 3;

// --- Reaction state (tracked here to gate input) ---
let isReacting = false;
let isDragReacting = false;

// Cancel signal from main (e.g. state change)
window.hitAPI.onCancelReaction(() => {
	if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; clickCount = 0; firstClickDir = null; }
	isReacting = false;
	isDragReacting = false;
});

function queueDragMove() {
	if (dragMoveRAF !== null) return;
	dragMoveRAF = requestAnimationFrame(() => {
		dragMoveRAF = null;
		if (!isDragging) return;
		window.hitAPI.dragMove();
	});
}

function clearQueuedDragMove() {
	if (dragMoveRAF === null) return;
	cancelAnimationFrame(dragMoveRAF);
	dragMoveRAF = null;
}

// --- Pointer handlers ---
area.addEventListener("pointerdown", (e) => {
	if (e.button === 0) {
		// In detection mode, don't start drag — just track for click
		if (dockDetecting) {
			mouseDownX = e.clientX;
			mouseDownY = e.clientY;
			didDrag = false;
			return;
		}
		if (miniMode) { didDrag = false; return; }
		area.setPointerCapture(e.pointerId);
		isDragging = true;
		didDrag = false;
		mouseDownX = e.clientX;
		mouseDownY = e.clientY;
		window.hitAPI.dragLock(true);
		area.classList.add("dragging");
	}
});

function stopDrag() {
	if (!isDragging) return;
	clearQueuedDragMove();
	isDragging = false;
	window.hitAPI.dragLock(false);
	area.classList.remove("dragging");
	if (didDrag) {
		window.hitAPI.dragEnd();
	}
	endDragReaction();
}

document.addEventListener("pointerup", (e) => {
	if (e.button === 0) {
		// In detection mode, handle click directly without drag logic
		if (dockDetecting) {
			const totalDx = Math.abs(e.clientX - mouseDownX);
			const totalDy = Math.abs(e.clientY - mouseDownY);
			if (totalDx < DRAG_THRESHOLD && totalDy < DRAG_THRESHOLD) {
				handleClick(e.clientX, e.clientY);
			}
			return;
		}
		const wasDrag = didDrag;
		stopDrag();
		if (!wasDrag) {
			if (e.ctrlKey || e.metaKey) {
				window.hitAPI.showDashboard();
			} else {
				handleClick(e.clientX, e.clientY);
			}
		}
	}
});

area.addEventListener("pointercancel", () => stopDrag());
area.addEventListener("lostpointercapture", () => { if (isDragging) stopDrag(); });
window.addEventListener("blur", stopDrag);

// --- Click reaction logic (2-click = poke, 4-click = flail) ---
const CLICK_WINDOW_MS = 400;

let clickCount = 0;
let clickTimer = null;
let firstClickDir = null;

function _getReaction(name) {
	return _reactions[name] || null;
}

function handleClick(clientX, clientY) {
	if (miniMode) {
		window.hitAPI.exitMiniMode();
		return;
	}

	// Dock-walk detection mode: forward click to main process for window detection
	if (dockDetecting) {
		const screenX = Math.round(window.screenX + clientX);
		const screenY = Math.round(window.screenY + clientY);
		window.hitAPI.sendDockDetectClick(screenX, screenY);
		return;
	}

	if (isReacting || isDragReacting) return;

	// Non-idle: focus terminal, no reaction
	if (currentState !== "idle") {
		window.hitAPI.focusTerminal();
		return;
	}

	clickCount++;
	if (clickCount === 1) {
		firstClickDir = clientX < area.offsetWidth / 2 ? "left" : "right";
		window.hitAPI.focusTerminal();
	}

	if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }

	const doubleReact = _getReaction("double");
	const annoyedReact = _getReaction("annoyed");
	const leftReact = _getReaction("clickLeft");
	const rightReact = _getReaction("clickRight");

	if (clickCount >= 4 && doubleReact) {
		clickCount = 0;
		firstClickDir = null;
		const files = doubleReact.files || [doubleReact.file];
		const file = files[Math.floor(Math.random() * files.length)];
		playReaction(file, doubleReact.duration || 3500);
	} else if (clickCount >= 2) {
		clickTimer = setTimeout(() => {
			clickTimer = null;
			clickCount = 0;
			if (annoyedReact && Math.random() < 0.5) {
				firstClickDir = null;
				playReaction(annoyedReact.file, annoyedReact.duration || 3500);
			} else if (leftReact && rightReact) {
				const react = firstClickDir === "left" ? leftReact : rightReact;
				firstClickDir = null;
				playReaction(react.file, react.duration || 2500);
			} else {
				firstClickDir = null;
			}
		}, CLICK_WINDOW_MS);
	} else {
		clickTimer = setTimeout(() => {
			clickTimer = null;
			clickCount = 0;
			firstClickDir = null;
		}, CLICK_WINDOW_MS);
	}
}

function playReaction(svg, duration) {
	if (!svg) return;
	isReacting = true;
	window.hitAPI.playClickReaction(svg, duration);
	setTimeout(() => { isReacting = false; }, duration);
}

// --- Drag reaction ---
function startDragReaction() {
	if (isDragReacting) return;
	if (dndEnabled) return;

	if (isReacting) {
		isReacting = false;
	}

	isDragReacting = true;
	window.hitAPI.startDragReaction();
}

function endDragReaction() {
	if (!isDragReacting) return;
	isDragReacting = false;
	window.hitAPI.endDragReaction();
}

// --- Right-click context menu ---
document.addEventListener("contextmenu", (e) => {
	e.preventDefault();
	window.hitAPI.showContextMenu();
});
