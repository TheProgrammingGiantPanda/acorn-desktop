/**
 * Per-RISC-OS-window renderer
 *
 * Draws VDU/OS_Plot output on a canvas using 2D canvas API.
 * Relays mouse and keyboard events back to main via IPC.
 */

export {};

declare global {
  interface Window {
    wimpWindow: {
      handle: number;
      onClick: (x: number, y: number, buttons: number, iconHandle?: number) => void;
      onKey:   (charCode: number) => void;
      onDraw:  (cb: (cmds: DrawCommand[]) => void) => void;
      onUpdateIcon: (cb: (data: { iconHandle: number; icon: IconData }) => void) => void;
      onResize: (cb: () => void) => void;
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

const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const ctx    = canvas.getContext("2d")!;

function resize(): void {
  canvas.width  = canvas.clientWidth;
  canvas.height = canvas.clientHeight;
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
// OS-unit coordinate translation state
// Populated by the "os_setup" draw command before each redraw batch.
// ---------------------------------------------------------------------------

/** Work-area X visible at the window's left edge (= scrollX from Wimp) */
let osScrollX = 0;
/** Work-area Y visible at the window's top edge  (= scrollY from Wimp, upward Y) */
let osScrollY = 0;

/**
 * Translate a work-area X coordinate (OS units) to canvas pixels.
 * 2 OS units = 1 pixel — no scaling to canvas size.
 */
function osX(ux: number): number { return (ux - osScrollX) / 2; }

/**
 * Translate a work-area Y coordinate (OS units, upward) to canvas pixels (downward).
 * 2 OS units = 1 pixel — no scaling to canvas size.
 */
function osY(uy: number): number { return (osScrollY - uy) / 2; }

// ---------------------------------------------------------------------------
// Draw commands from main process
// ---------------------------------------------------------------------------
window.wimpWindow.onDraw((cmds) => {
  for (const cmd of cmds) {
    switch (cmd.type) {
      // ── Canvas-pixel drawing (icon renderer etc.) ─────────────────────────
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
        ctx.fillStyle = cmd.colour ?? "#000000";
        ctx.font = cmd.font ?? "14px 'Courier New', monospace";
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
        // (x,y) = start, (w,h) = end — all in work-area OS units
        ctx.strokeStyle = cmd.colour ?? "#000000";
        ctx.beginPath();
        ctx.moveTo(osX(cmd.x), osY(cmd.y));
        ctx.lineTo(osX(cmd.w ?? 0), osY(cmd.h ?? 0));
        ctx.stroke();
        break;
      }

      case "os_rect": {
        // x,y = lower-left corner (OS units, Y upward), w,h = size in OS units.
        // osY maps the TOP of the rect (lower-left Y + height in upward Y → top in canvas).
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
// Icon rendering (for window icons like close/toggle buttons)
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
  // Send character code; handle special keys
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

