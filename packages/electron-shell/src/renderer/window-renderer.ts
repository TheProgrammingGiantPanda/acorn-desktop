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
      onPixels: (cb: (data: { width: number; height: number; pixels: Uint8Array }) => void) => void;
    };
  }
}

interface DrawCommand {
  type: "fillRect" | "strokeRect" | "text" | "line" | "clear" | "sprite";
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
// Draw commands from main process
// ---------------------------------------------------------------------------
window.wimpWindow.onDraw((cmds) => {
  for (const cmd of cmds) {
    switch (cmd.type) {
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

// ---------------------------------------------------------------------------
// VIDC frame buffer pixels from main process
// ---------------------------------------------------------------------------
window.wimpWindow.onPixels(({ width, height, pixels }) => {
  const rgba = new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.byteLength);
  const imageData = new ImageData(rgba, width, height);
  canvas.width  = width;
  canvas.height = height;
  ctx.putImageData(imageData, 0, 0);
});
