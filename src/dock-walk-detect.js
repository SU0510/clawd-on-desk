// src/dock-walk-detect.js — Per-platform external window detection for dock-walk
//
// Detects the system window at a given screen coordinate and retrieves its bounds.
// Used by dock-walk.js when the user clicks during the 5s detection window.
//
// Platform implementations:
// - macOS: CGWindowListCopyWindowInfo via koffi → CoreGraphics
// - Windows: WindowFromPoint + GetWindowRect via koffi → user32.dll
// - Linux: xdotool + xwininfo via child_process

const { execFile } = require("child_process");

const isMac = process.platform === "darwin";
const isWin = process.platform === "win32";
const isLinux = process.platform === "linux";

const ownPid = process.pid;

// ── macOS: CGWindowListCopyWindowInfo ──────────────────────────────────────
let macCoreGraphics = null;

function initMacCoreGraphics() {
	if (macCoreGraphics) return macCoreGraphics;
	try {
		const koffi = require("koffi");
		const cg = koffi.load("/System/Library/Frameworks/CoreGraphics.framework/Versions/A/CoreGraphics");

		// kCGWindowListOptionOnScreenOnly = 1 << 0 = 1
		// kCGNullWindowID = 0
		const kCGWindowListOptionOnScreenOnly = 1;

		const CGWindowListCopyWindowInfo = cg.func(
			"CGWindowListCopyWindowInfo",
			"void *", // CFArrayRef — we'll use CFArrayGetCount + CFArrayGetValueAtIndex
			["uint32", "uint32"] // CGWindowListOption, CGWindowID
		);

		// CFArray helpers
		const cf = koffi.load("/System/Library/Frameworks/CoreFoundation.framework/Versions/A/CoreFoundation");
		const CFArrayGetCount = cf.func("CFArrayGetCount", "long", ["void *"]);
		const CFArrayGetValueAtIndex = cf.func("CFArrayGetValueAtIndex", "void *", ["void *", "long"]);

		// CFDictionary helpers
		const CFDictionaryGetValue = cf.func("CFDictionaryGetValue", "void *", ["void *", "void *"]);

		// CFNumber → int64
		const CFNumberGetValue = cf.func("CFNumberGetValue", "bool", ["void *", "int", "void *"]);
		const kCFNumberSInt64Type = 4;

		// CFString → CString
		const CFStringGetCString = cf.func("CFStringGetCString", "bool", ["void *", "void *", "long", "uint32"]);
		const kCFStringEncodingUTF8 = 0x08000100;

		macCoreGraphics = {
			CGWindowListCopyWindowInfo, CFArrayGetCount, CFArrayGetValueAtIndex,
			CFDictionaryGetValue, CFNumberGetValue, CFStringGetCString,
			kCGWindowListOptionOnScreenOnly, kCFNumberSInt64Type, kCFStringEncodingUTF8,
		};
		return macCoreGraphics;
	} catch (err) {
		console.warn("[dock-walk-detect] macOS CoreGraphics init failed:", err.message);
		return null;
	}
}

function macGetWindowAtPoint(screenX, screenY, ownWindowIds) {
	const cg = initMacCoreGraphics();
	if (!cg) return null;

	try {
		const koffi = require("koffi");

		// Create CFString keys for the dictionary lookups
		const cf = koffi.load("/System/Library/Frameworks/CoreFoundation.framework/Versions/A/CoreFoundation");
		const CFStringCreateWithCString = cf.func("CFStringCreateWithCString", "void *", ["void *", "const char *", "uint32"]);

		const kCGWindowOwnerPID = CFStringCreateWithCString(null, "kCGWindowOwnerPID", cg.kCFStringEncodingUTF8);
		const kCGWindowNumber = CFStringCreateWithCString(null, "kCGWindowNumber", cg.kCFStringEncodingUTF8);
		const kCGWindowBounds = CFStringCreateWithCString(null, "kCGWindowBounds", cg.kCFStringEncodingUTF8);
		const kCGWindowLayer = CFStringCreateWithCString(null, "kCGWindowLayer", cg.kCFStringEncodingUTF8);

		const windowList = cg.CGWindowListCopyWindowInfo(cg.kCGWindowListOptionOnScreenOnly, 0);
		const count = cg.CFArrayGetCount(windowList);

		// Buffer for reading number values
		const numBuf = koffi.alloc("int64", 1);

		for (let i = 0; i < count; i++) {
			const entry = cg.CFArrayGetValueAtIndex(windowList, i);

			// Skip own process windows by PID
			const pidRef = cg.CFDictionaryGetValue(entry, kCGWindowOwnerPID);
			if (pidRef) {
				koffi.encode(numBuf, 0, "int64", 0n);
				cg.CFNumberGetValue(pidRef, cg.kCFNumberSInt64Type, numBuf);
				const pid = Number(koffi.decode(numBuf, 0, "int64"));
				if (pid === ownPid) continue;
			}

			// Read window number
			const numberRef = cg.CFDictionaryGetValue(entry, kCGWindowNumber);
			if (!numberRef) continue;
			koffi.encode(numBuf, 0, "int64", 0n);
			cg.CFNumberGetValue(numberRef, cg.kCFNumberSInt64Type, numBuf);
			const windowId = Number(koffi.decode(numBuf, 0, "int64"));

			// Skip own windows by ID (fallback for edge cases)
			if (ownWindowIds && ownWindowIds.has(windowId)) continue;

			// Read layer — skip windows above floating-panel level
			const layerRef = cg.CFDictionaryGetValue(entry, kCGWindowLayer);
			if (layerRef) {
				koffi.encode(numBuf, 0, "int64", 0n);
				cg.CFNumberGetValue(layerRef, cg.kCFNumberSInt64Type, numBuf);
				const layer = Number(koffi.decode(numBuf, 0, "int64"));
				if (layer > 3) continue; // skip menu bar (24), screen-saver (1500+), etc.
			}

			// Read bounds — it's a CFDictionary with x, y, width, height as CFNumber
			const boundsRef = cg.CFDictionaryGetValue(entry, kCGWindowBounds);
			if (!boundsRef) continue;
			const bounds = macReadBoundsDict(cg, koffi, boundsRef, numBuf);
			if (!bounds) continue;

			// Check if point is inside this window's bounds
			if (screenX >= bounds.x && screenX <= bounds.x + bounds.width &&
				screenY >= bounds.y && screenY <= bounds.y + bounds.height) {
				return { handle: windowId, bounds };
			}
		}

		return null;
	} catch (err) {
		console.warn("[dock-walk-detect] macOS window detection failed:", err.message);
		return null;
	}
}

function macReadBoundsDict(cg, koffi, dictRef, numBuf) {
	const cf = koffi.load("/System/Library/Frameworks/CoreFoundation.framework/Versions/A/CoreFoundation");
	const CFStringCreateWithCString = cf.func("CFStringCreateWithCString", "void *", ["void *", "const char *", "uint32"]);

	const keys = ["X", "Y", "Width", "Height"];
	const cfKeys = keys.map(k => CFStringCreateWithCString(null, k, cg.kCFStringEncodingUTF8));

	const result = {};
	const fieldNames = ["x", "y", "width", "height"];
	for (let i = 0; i < 4; i++) {
		const ref = cg.CFDictionaryGetValue(dictRef, cfKeys[i]);
		if (!ref) return null;
		koffi.encode(numBuf, 0, "int64", 0n);
		if (!cg.CFNumberGetValue(ref, cg.kCFNumberSInt64Type, numBuf)) return null;
		result[fieldNames[i]] = Number(koffi.decode(numBuf, 0, "int64"));
	}

	if (result.width <= 0 || result.height <= 0) return null;
	return result;
}

function macGetWindowBounds(windowId) {
	const cg = initMacCoreGraphics();
	if (!cg) return null;

	try {
		const koffi = require("koffi");
		const cf = koffi.load("/System/Library/Frameworks/CoreFoundation.framework/Versions/A/CoreFoundation");
		const CFStringCreateWithCString = cf.func("CFStringCreateWithCString", "void *", ["void *", "const char *", "uint32"]);
		const kCGWindowNumber = CFStringCreateWithCString(null, "kCGWindowNumber", cg.kCFStringEncodingUTF8);
		const kCGWindowBounds = CFStringCreateWithCString(null, "kCGWindowBounds", cg.kCFStringEncodingUTF8);

		const windowList = cg.CGWindowListCopyWindowInfo(cg.kCGWindowListOptionOnScreenOnly, 0);
		const count = cg.CFArrayGetCount(windowList);
		const numBuf = koffi.alloc("int64", 1);

		for (let i = 0; i < count; i++) {
			const entry = cg.CFArrayGetValueAtIndex(windowList, i);
			const numberRef = cg.CFDictionaryGetValue(entry, kCGWindowNumber);
			if (!numberRef) continue;
			koffi.encode(numBuf, 0, "int64", 0n);
			cg.CFNumberGetValue(numberRef, cg.kCFNumberSInt64Type, numBuf);
			const id = Number(koffi.decode(numBuf, 0, "int64"));
			if (id === windowId) {
				const boundsRef = cg.CFDictionaryGetValue(entry, kCGWindowBounds);
				if (!boundsRef) return null;
				return macReadBoundsDict(cg, koffi, boundsRef, numBuf);
			}
		}
		return null;
	} catch (err) {
		console.warn("[dock-walk-detect] macOS getBounds failed:", err.message);
		return null;
	}
}

function macGetWindowVisibility(windowId, ownWindowIds) {
	const cg = initMacCoreGraphics();
	if (!cg) return { exists: true, minimized: false, occluded: false };

	try {
		const koffi = require("koffi");
		const cf = koffi.load("/System/Library/Frameworks/CoreFoundation.framework/Versions/A/CoreFoundation");
		const CFStringCreateWithCString = cf.func("CFStringCreateWithCString", "void *", ["void *", "const char *", "uint32"]);
		const kCGWindowOwnerPID = CFStringCreateWithCString(null, "kCGWindowOwnerPID", cg.kCFStringEncodingUTF8);
		const kCGWindowNumber = CFStringCreateWithCString(null, "kCGWindowNumber", cg.kCFStringEncodingUTF8);
		const kCGWindowBounds = CFStringCreateWithCString(null, "kCGWindowBounds", cg.kCFStringEncodingUTF8);
		const kCGWindowLayer = CFStringCreateWithCString(null, "kCGWindowLayer", cg.kCFStringEncodingUTF8);

		const windowList = cg.CGWindowListCopyWindowInfo(cg.kCGWindowListOptionOnScreenOnly, 0);
		const count = cg.CFArrayGetCount(windowList);
		const numBuf = koffi.alloc("int64", 1);

		let targetFound = false;
		let targetBounds = null;
		let targetLayer = 0;

		// Build z-order list of windows that could occlude our target
		const aboveWindows = [];

		for (let i = 0; i < count; i++) {
			const entry = cg.CFArrayGetValueAtIndex(windowList, i);

			const numberRef = cg.CFDictionaryGetValue(entry, kCGWindowNumber);
			if (!numberRef) continue;
			koffi.encode(numBuf, 0, "int64", 0n);
			cg.CFNumberGetValue(numberRef, cg.kCFNumberSInt64Type, numBuf);
			const id = Number(koffi.decode(numBuf, 0, "int64"));

			// Read PID for own-window filtering in occlusion check
			const pidRef = cg.CFDictionaryGetValue(entry, kCGWindowOwnerPID);
			let entryPid = 0;
			if (pidRef) {
				koffi.encode(numBuf, 0, "int64", 0n);
				cg.CFNumberGetValue(pidRef, cg.kCFNumberSInt64Type, numBuf);
				entryPid = Number(koffi.decode(numBuf, 0, "int64"));
			}

			if (id === windowId) {
				targetFound = true;
				const boundsRef = cg.CFDictionaryGetValue(entry, kCGWindowBounds);
				if (boundsRef) targetBounds = macReadBoundsDict(cg, koffi, boundsRef, numBuf);
				const layerRef = cg.CFDictionaryGetValue(entry, kCGWindowLayer);
				if (layerRef) {
					koffi.encode(numBuf, 0, "int64", 0n);
					cg.CFNumberGetValue(layerRef, cg.kCFNumberSInt64Type, numBuf);
					targetLayer = Number(koffi.decode(numBuf, 0, "int64"));
				}
			} else if (!targetFound && entryPid !== ownPid && !(ownWindowIds && ownWindowIds.has(id))) {
				// Window above target in z-order — check if it could occlude
				const layerRef = cg.CFDictionaryGetValue(entry, kCGWindowLayer);
				let layer = 0;
				if (layerRef) {
					koffi.encode(numBuf, 0, "int64", 0n);
					cg.CFNumberGetValue(layerRef, cg.kCFNumberSInt64Type, numBuf);
					layer = Number(koffi.decode(numBuf, 0, "int64"));
				}
				const boundsRef = cg.CFDictionaryGetValue(entry, kCGWindowBounds);
				if (boundsRef && layer >= targetLayer) {
					const bounds = macReadBoundsDict(cg, koffi, boundsRef, numBuf);
					if (bounds) aboveWindows.push(bounds);
				}
			}
		}

		if (!targetFound) return { exists: false, minimized: false, occluded: false };

		// Check occlusion: any window above overlaps our target bounds
		let occluded = false;
		if (targetBounds) {
			for (const above of aboveWindows) {
				if (rectsOverlap(above, targetBounds)) {
					occluded = true;
					break;
				}
			}
		}

		return { exists: true, minimized: false, occluded };
	} catch (err) {
		console.warn("[dock-walk-detect] macOS visibility check failed:", err.message);
		return { exists: true, minimized: false, occluded: false };
	}
}

function rectsOverlap(a, b) {
	return a.x < b.x + b.width && a.x + a.width > b.x &&
		a.y < b.y + b.height && a.y + a.height > b.y;
}

// ── Windows: WindowFromPoint + GetWindowRect ───────────────────────────────
let winUser32 = null;

function initWinUser32() {
	if (winUser32) return winUser32;
	try {
		const koffi = require("koffi");
		const user32 = koffi.load("user32.dll");

		const POINT = koffi.struct("POINT", { x: "long", y: "long" });
		const RECT = koffi.struct("RECT", { left: "long", top: "long", right: "long", bottom: "long" });

		const WindowFromPoint = user32.func("WindowFromPoint", "void *", [POINT]);
		const GetWindowRect = user32.func("GetWindowRect", "bool", ["void *", RECT]);
		const GetForegroundWindow = user32.func("GetForegroundWindow", "void *", []);
		const IsWindow = user32.func("IsWindow", "bool", ["void *"]);
		const IsIconic = user32.func("IsIconic", "bool", ["void *"]);
		const GetAncestor = user32.func("GetAncestor", "void *", ["void *", "uint"]);
		const GetCurrentProcessId = user32.func("GetCurrentProcessId", "uint", []);

		winUser32 = { WindowFromPoint, GetWindowRect, GetForegroundWindow, IsWindow, IsIconic, GetAncestor, GetCurrentProcessId, POINT, RECT };
		return winUser32;
	} catch (err) {
		console.warn("[dock-walk-detect] Windows user32 init failed:", err.message);
		return null;
	}
}

function winGetWindowAtPoint(screenX, screenY, ownHwnds) {
	const u32 = initWinUser32();
	if (!u32) return null;

	try {
		const pt = { x: screenX, y: screenY };
		let hwnd = u32.WindowFromPoint(pt);

		// Walk up to top-level window
		const GA_ROOT = 2;
		hwnd = u32.GetAncestor(hwnd, GA_ROOT);

		if (!hwnd) return null;

		// Skip own windows by PID (GetWindowThreadProcessId)
		const winPid = u32.GetWindowThreadProcessId ? 0 : 0; // fallback to ownHwnds
		if (ownHwnds && ownHwnds.has(Number(hwnd))) return null;

		const rect = new u32.RECT();
		if (!u32.GetWindowRect(hwnd, rect)) return null;

		return {
			handle: Number(hwnd),
			bounds: {
				x: rect.left,
				y: rect.top,
				width: rect.right - rect.left,
				height: rect.bottom - rect.top,
			},
		};
	} catch (err) {
		console.warn("[dock-walk-detect] Windows window detection failed:", err.message);
		return null;
	}
}

function winGetWindowBounds(hwnd) {
	const u32 = initWinUser32();
	if (!u32) return null;

	try {
		if (!u32.IsWindow(hwnd)) return null;
		const rect = new u32.RECT();
		if (!u32.GetWindowRect(hwnd, rect)) return null;
		return {
			x: rect.left, y: rect.top,
			width: rect.right - rect.left,
			height: rect.bottom - rect.top,
		};
	} catch (err) {
		return null;
	}
}

function winGetWindowVisibility(hwnd, ownHwnds) {
	const u32 = initWinUser32();
	if (!u32) return { exists: true, minimized: false, occluded: false };

	try {
		if (!u32.IsWindow(hwnd)) return { exists: false, minimized: false, occluded: false };
		const minimized = u32.IsIconic(hwnd);
		if (minimized) return { exists: true, minimized: true, occluded: false };

		const fgHwnd = u32.GetForegroundWindow();
		if (fgHwnd === hwnd) return { exists: true, minimized: false, occluded: false };

		// Skip own process windows in occlusion check
		if (ownHwnds && ownHwnds.has(Number(fgHwnd))) {
			return { exists: true, minimized: false, occluded: false };
		}

		// Check if foreground window overlaps our target
		const fgRect = new u32.RECT();
		const targetRect = new u32.RECT();
		u32.GetWindowRect(fgHwnd, fgRect);
		u32.GetWindowRect(hwnd, targetRect);

		const fgBounds = { x: fgRect.left, y: fgRect.top, width: fgRect.right - fgRect.left, height: fgRect.bottom - fgRect.top };
		const tgtBounds = { x: targetRect.left, y: targetRect.top, width: targetRect.right - targetRect.left, height: targetRect.bottom - targetRect.top };

		const occluded = rectsOverlap(fgBounds, tgtBounds);
		return { exists: true, minimized: false, occluded };
	} catch (err) {
		return { exists: true, minimized: false, occluded: false };
	}
}

// ── Linux: xdotool + xwininfo ──────────────────────────────────────────────
function linuxGetWindowAtPoint(screenX, screenY, ownWindowIds) {
	return new Promise((resolve) => {
		execFile("xdotool", ["getwindowfocus"], { timeout: 2000 }, (err, stdout) => {
			if (err) { resolve(null); return; }
			const windowId = parseInt(stdout.trim(), 10);
			if (isNaN(windowId)) { resolve(null); return; }
			if (ownWindowIds && ownWindowIds.has(windowId)) { resolve(null); return; }

			linuxParseXwininfo(windowId, (bounds) => {
				if (bounds) {
					resolve({ handle: windowId, bounds });
				} else {
					resolve(null);
				}
			});
		});
	});
}

function linuxParseXwininfo(windowId, callback) {
	execFile("xwininfo", ["-id", String(windowId)], { timeout: 2000 }, (err, stdout) => {
		if (err) { callback(null); return; }
		const lines = stdout.split("\n");
		let x = 0, y = 0, width = 0, height = 0;
		for (const line of lines) {
			const absMatch = line.match(/Absolute upper-left X:\s*(-?\d+)/);
			if (absMatch) x = parseInt(absMatch[1], 10);
			const absMatchY = line.match(/Absolute upper-left Y:\s*(-?\d+)/);
			if (absMatchY) y = parseInt(absMatchY[1], 10);
			const wMatch = line.match(/Width:\s*(\d+)/);
			if (wMatch) width = parseInt(wMatch[1], 10);
			const hMatch = line.match(/Height:\s*(\d+)/);
			if (hMatch) height = parseInt(hMatch[1], 10);
		}
		if (width > 0 && height > 0) {
			callback({ x, y, width, height });
		} else {
			callback(null);
		}
	});
}

function linuxGetWindowBounds(windowId) {
	return new Promise((resolve) => {
		linuxParseXwininfo(windowId, (bounds) => resolve(bounds));
	});
}

function linuxGetWindowVisibility(windowId, ownWindowIds) {
	return new Promise((resolve) => {
		execFile("xdotool", ["getwindowfocus"], { timeout: 2000 }, (err, stdout) => {
			if (err) { resolve({ exists: true, minimized: false, occluded: false }); return; }
			const focusedId = parseInt(stdout.trim(), 10);
			if (isNaN(focusedId)) { resolve({ exists: true, minimized: false, occluded: false }); return; }

			// Check if window still exists
			execFile("xwininfo", ["-id", String(windowId)], { timeout: 2000 }, (err2) => {
				if (err2) { resolve({ exists: false, minimized: false, occluded: false }); return; }
				const occluded = focusedId !== windowId && !(ownWindowIds && ownWindowIds.has(focusedId));
				resolve({ exists: true, minimized: false, occluded });
			});
		});
	});
}

// ── Unified API ───────────────────────────────────────────────────────────
// All async for consistency (macOS/Windows are sync but wrapped in Promise)

function detectWindowAtPoint(screenX, screenY, ownWindowIds) {
	if (isMac) {
		return Promise.resolve(macGetWindowAtPoint(screenX, screenY, ownWindowIds || new Set()));
	}
	if (isWin) {
		return Promise.resolve(winGetWindowAtPoint(screenX, screenY, ownWindowIds || new Set()));
	}
	if (isLinux) {
		return linuxGetWindowAtPoint(screenX, screenY, ownWindowIds || new Set());
	}
	return Promise.resolve(null);
}

function getWindowBounds(handle) {
	if (isMac) return Promise.resolve(macGetWindowBounds(handle));
	if (isWin) return Promise.resolve(winGetWindowBounds(handle));
	if (isLinux) return linuxGetWindowBounds(handle);
	return Promise.resolve(null);
}

function getWindowVisibility(handle, ownWindowIds) {
	if (isMac) return Promise.resolve(macGetWindowVisibility(handle, ownWindowIds || new Set()));
	if (isWin) return Promise.resolve(winGetWindowVisibility(handle, ownWindowIds || new Set()));
	if (isLinux) return linuxGetWindowVisibility(handle, ownWindowIds || new Set());
	return Promise.resolve({ exists: true, minimized: false, occluded: false });
}

module.exports = {
	detectWindowAtPoint,
	getWindowBounds,
	getWindowVisibility,
};
