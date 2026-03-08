/**
 * Per-RISC-OS-window renderer
 *
 * Draws VDU/OS_Plot output on a canvas using 2D canvas API.
 * Relays mouse, keyboard and scroll events back to main via IPC.
 *
 * Layout (window.html):
 *   #scroll-outer  overflow:auto  — native OS scroll bars appear here
 *     #scroll-inner              — sized to the RISC OS work area (by JS)
 *       #canvas  position:sticky — stays at (0,0) of the viewport while
 *                                  the outer div scrolls; sized to viewport
 */

export {};

declare global {
  interface Window {
    wimpWindow: {
      handle: number;
      onClick:      (x: number, y: number, buttons: number, iconHandle?: number) => void;
      onKey:        (charCode: number) => void;
      sendScroll:   (scrollX: number, scrollY: number) => void;
      onDraw:       (cb: (cmds: DrawCommand[]) => void) => void;
      onUpdateIcon: (cb: (data: { iconHandle: number; icon: IconData }) => void) => void;
      onResize:     (cb: () => void) => void;
      onWorkArea:   (cb: (data: WorkAreaData) => void) => void;
    };
  }
}

interface DrawCommand {
  type: "fillRect" | "strokeRect" | "text" | "line" | "clear" | "sprite"
      | "os_setup" | "os_line" | "os_rect";
  x: number; y: number;
  w?: number; h?: number;
  text?: string;
  colour?: string;
  font?: string;
}

interface IconData {
  x0: number; y0: number; x1: number; y1: number;
  flags: number;
  text: string;
}

interface WorkAreaData {
  scrollX: number; scrollY: number;
  workX0: number;  workY0: number;
  workX1: number;  workY1: number;
  hasHScroll: boolean;
  hasVScroll: boolean;
}

// ---------------------------------------------------------------------------
// DOM elements
// ---------------------------------------------------------------------------
const scrollOuter = document.getElementById("scroll-outer")!;
const scrollInner = document.getElementById("scroll-inner")!;
const canvas      = document.getElementById("canvas") as HTMLCanvasElement;
const ctx         = canvas.getContext("2d")!;

// ---------------------------------------------------------------------------
// Canvas sizing — canvas fills the visible viewport of #scroll-outer
// ---------------------------------------------------------------------------
function resize(): void {
  const w = scrollOuter.clientWidth;
  const h = scrollOuter.clientHeight;
  canvas.width        = w;
  canvas.height       = h;
  canvas.style.width  = `${w}px`;
  canvas.style.height = `${h}px`;
  drawBackground();
}

function drawBackground(): void {
  ctx.fillStyle = "#d4d0c8"; // RISC OS light grey
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

resize();
window.addEventListener("resize", resize);
window.wimpWindow.onResize(resize);

// ---------------------------------------------------------------------------
// Scroll bar state — driven by "wimp-workarea" IPC from main
// ---------------------------------------------------------------------------

/** Work area bounds in RISC OS OS units (Y increases upward) */
let workX0 = 0, workY0 = -1024, workX1 = 1280, workY1 = 0;
/** Current scroll position in RISC OS OS units */
let currentScrollX = 0, currentScrollY = 0;
/** Whether the window has scroll bars enabled */
let hasHScroll = false, hasVScroll = false;

/**
 * Size #scroll-inner to the work area so the browser shows scroll bars.
 * If scrolling is disabled for an axis, keep that axis at viewport size.
 */
function updateScrollInner(): void {
  const workPxW = hasHScroll
    ? Math.max(scrollOuter.clientWidth,  (workX1 - workX0) / 2)
    : scrollOuter.clientWidth;
  const workPxH = hasVScroll
    ? Math.max(scrollOuter.clientHeight, (workY1 - workY0) / 2)
    : scrollOuter.clientHeight;
  scrollInner.style.width  = `${workPxW}px`;
  scrollInner.style.height = `${workPxH}px`;
}

/**
 * Sync #scroll-outer's scroll position to the current RISC OS scroll state.
 * Called after workarea data arrives so the scroll bar thumb is in the
 * right place without firing a sendScroll back to the app.
 */
let suppressScrollEvent = false;
function syncScrollPosition(): void {
  const left = Math.max(0, (currentScrollX - workX0) / 2);
  // scrollY = work-area Y at top of window; top = scrollTop=0 → scrollY = workY1
  const top  = Math.max(0, (workY1 - currentScrollY) / 2);
  suppressScrollEvent = true;
  scrollOuter.scrollLeft = left;
  scrollOuter.scrollTop  = top;
  suppressScrollEvent = false;
}

window.wimpWindow.onWorkArea((data) => {
  workX0 = data.workX0;  workY0 = data.workY0;
  workX1 = data.workX1;  workY1 = data.workY1;
  hasHScroll = data.hasHScroll;
  hasVScroll = data.hasVScroll;
  currentScrollX = data.scrollX;
  currentScrollY = data.scrollY;

  updateScrollInner();
  syncScrollPosition();
});

// When the viewport resizes the scroll-inner min-size may need updating
window.addEventListener("resize", updateScrollInner);
window.wimpWindow.onResize(updateScrollInner);

// ---------------------------------------------------------------------------
// Native scroll → RISC OS scroll event
// ---------------------------------------------------------------------------
scrollOuter.addEventListener("scroll", () => {
  if (suppressScrollEvent) return;

  const newScrollX = workX0 + scrollOuter.scrollLeft * 2;
  // scrollTop=0 = top of work area = workY1 in RISC OS upward Y
  const newScrollY = workY1 - scrollOuter.scrollTop * 2;

  if (newScrollX === currentScrollX && newScrollY === currentScrollY) return;
  currentScrollX = newScrollX;
  currentScrollY = newScrollY;
  window.wimpWindow.sendScroll(newScrollX, newScrollY);
});

// ---------------------------------------------------------------------------
// OS-unit coordinate translation state (set by os_setup draw command)
// ---------------------------------------------------------------------------

/** Work-area X visible at the window's left edge (= scrollX) */
let osScrollX = 0;
/** Work-area Y visible at the window's top edge  (= scrollY, upward Y) */
let osScrollY = 0;

/** Work-area X → canvas px (2 OS units = 1 pixel, no scaling) */
function osX(ux: number): number { return (ux - osScrollX) / 2; }
/** Work-area Y → canvas px (Y flipped: upward → downward) */
function osY(uy: number): number { return (osScrollY - uy) / 2; }

// ---------------------------------------------------------------------------
// Draw commands from main process
// ---------------------------------------------------------------------------
window.wimpWindow.onDraw((cmds) => {
  for (const cmd of cmds) {
    switch (cmd.type) {
      // ── Canvas-pixel drawing ──────────────────────────────────────────────
      case "clear":
        drawBackground();
        break;
      case "fillRect":
        ctx.fillStyle = cmd.colour ?? "#ffffff";
        ctx.fillRect(cmd.x, cmd.y, cmd.w ?? 0, cmd.h ?? 0);
        break;
      case "strokeRect":
        ctx.strokeStyle = cmd.colour ?? "#000000";
        ctx.strokeRect(cmd.x, cmd.y, cmd.w ?? 0, cmd.h ?? 0);
        break;
      case "text":
        ctx.fillStyle  = cmd.colour ?? "#000000";
        ctx.font       = cmd.font ?? "14px 'Courier New', monospace";
        ctx.fillText(cmd.text ?? "", cmd.x, cmd.y);
        break;
      case "line":
        ctx.strokeStyle = cmd.colour ?? "#000000";
        ctx.beginPath();
        ctx.moveTo(cmd.x, cmd.y);
        ctx.lineTo(cmd.w ?? 0, cmd.h ?? 0);
        ctx.stroke();
        break;

      // ── OS-unit drawing (OS_Plot interception) ────────────────────────────
      case "os_setup":
        // x=scrollX, y=scrollY (w/h reserved for future zoom support)
        osScrollX = cmd.x;
        osScrollY = cmd.y;
        break;

      case "os_line": {
        ctx.strokeStyle = cmd.colour ?? "#000000";
        ctx.beginPath();
        ctx.moveTo(osX(cmd.x), osY(cmd.y));
        ctx.lineTo(osX(cmd.w ?? 0), osY(cmd.h ?? 0));
        ctx.stroke();
        break;
      }

      case "os_rect": {
        // x,y = lower-left corner (OS units, Y upward), w,h = size in OS units.
        const rw = (cmd.w ?? 0) / 2;
        const rh = (cmd.h ?? 0) / 2;
        ctx.fillStyle = cmd.colour ?? "#000000";
        ctx.fillRect(osX(cmd.x), osY(cmd.y + (cmd.h ?? 0)), rw, rh);
        break;
      }
    }
  }
});

// ---------------------------------------------------------------------------
// Icon rendering
// ---------------------------------------------------------------------------
window.wimpWindow.onUpdateIcon(({ iconHandle, icon }) => {
  const IF_TEXT   = 1 << 0;
  const IF_BORDER = 1 << 2;
  const x0 = icon.x0 / 2, y0 = canvas.height - icon.y1 / 2;
  const w  = (icon.x1 - icon.x0) / 2;
  const h  = (icon.y1 - icon.y0) / 2;

  if (icon.flags & IF_BORDER) {
    ctx.strokeStyle = "#444";
    ctx.strokeRect(x0, y0, w, h);
  }
  if (icon.flags & IF_TEXT && icon.text) {
    ctx.fillStyle = "#000";
    ctx.font = "13px system-ui";
    ctx.fillText(icon.text, x0 + 4, y0 + h - 4);
  }
  void iconHandle;
});

// ---------------------------------------------------------------------------
// Input events → IPC
// ---------------------------------------------------------------------------
canvas.addEventListener("mousedown", (e) => {
  const rect = canvas.getBoundingClientRect();
  const x = Math.round(e.clientX - rect.left);
  const y = Math.round(e.clientY - rect.top);
  // Map button: 0=select(4), 1=menu(2), 2=adjust(1) in RISC OS
  const buttons = e.button === 0 ? 4 : e.button === 1 ? 2 : 1;
  window.wimpWindow.onClick(x, y, buttons);
});

canvas.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  window.wimpWindow.onClick(
    Math.round(e.clientX - rect.left),
    Math.round(e.clientY - rect.top),
    2 // menu button
  );
});

window.addEventListener("keydown", (e) => {
  const code = e.key.length === 1 ? e.key.charCodeAt(0) : specialKey(e.key);
  if (code !== -1) window.wimpWindow.onKey(code);
});

function specialKey(key: string): number {
  const map: Record<string, number> = {
    "Enter": 13, "Escape": 27, "Tab": 9, "Backspace": 127,
    "Delete": 0x7F, "Home": 0x1E, "End": 0x8B,
    "ArrowUp": 0x8F, "ArrowDown": 0x8E, "ArrowLeft": 0x8C, "ArrowRight": 0x8D,
    "F1": 0x81,  "F2": 0x82,  "F3": 0x83,  "F4": 0x84,
    "F5": 0x85,  "F6": 0x86,  "F7": 0x87,  "F8": 0x88,
    "F9": 0x89,  "F10": 0x8A, "F11": 0x8B, "F12": 0x8C,
  };
  return map[key] ?? -1;
}
