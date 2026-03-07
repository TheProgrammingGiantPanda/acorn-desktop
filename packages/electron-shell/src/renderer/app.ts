/**
 * Renderer process — wires the UI to the ARM emulator and Electron IPC bridge
 */

import { ArchimedesMachine } from "@acorn/arm-emulator";
import { IPC } from "@acorn/shared";
import type { MachineConfig, EmulatorState } from "@acorn/shared";

declare global {
  interface Window {
    acorn: {
      loadROM:  (path: string) => Promise<unknown>;
      loadDisk: (path: string) => Promise<unknown>;
      reset:    () => void;
      pause:    () => void;
      resume:   () => void;
      setZoom:  (n: number) => void;
      setSpeed: (n: number) => void;
      dragFile: (path: string) => Promise<unknown>;
      on:       (ch: string, cb: (...a: unknown[]) => void) => () => void;
      once:     (ch: string, cb: (...a: unknown[]) => void) => void;
    };
  }
}

// ---------------------------------------------------------------------------
// Elements
// ---------------------------------------------------------------------------
const canvas        = document.getElementById("screen")        as HTMLCanvasElement;
const ctx           = canvas.getContext("2d")!;
const displayArea   = document.getElementById("display-area")!;
const noRomMsg      = document.getElementById("no-rom-message")!;
const dropOverlay   = document.getElementById("drop-overlay")!;
const btnLoadROM    = document.getElementById("btn-load-rom")!;
const btnLoadDisk   = document.getElementById("btn-load-disk")!;
const btnReset      = document.getElementById("btn-reset")!;
const btnPause      = document.getElementById("btn-pause")!;
const iconPause     = document.getElementById("icon-pause")!;
const iconPlay      = document.getElementById("icon-play")!;
const pauseLabel    = document.getElementById("pause-label")!;
const zoomSelect    = document.getElementById("zoom-select")  as HTMLSelectElement;
const statusFPS     = document.getElementById("status-fps")!;
const statusMHz     = document.getElementById("status-mhz")!;
const statusROM     = document.getElementById("status-rom")!;
const sbState       = document.getElementById("sb-state")!;
const sbMessage     = document.getElementById("sb-message")!;

// ---------------------------------------------------------------------------
// Emulator state
// ---------------------------------------------------------------------------
let machine: ArchimedesMachine | null = null;
let paused = false;
let zoom: 1 | 2 | 3 | 4 = 2;

const defaultConfig: MachineConfig = {
  model: "A310",
  ramSize: 1 * 1024 * 1024, // 1 MB
  cpuVariant: "ARM2",
  speedMultiplier: 1.0,
};

let config: MachineConfig = { ...defaultConfig };

// ---------------------------------------------------------------------------
// Machine lifecycle
// ---------------------------------------------------------------------------
function createMachine(romData: Uint8Array): void {
  machine?.stop();

  machine = new ArchimedesMachine(config);
  machine.loadROM(romData);
  machine.onFrame((pixels: Uint8ClampedArray, w: number, h: number) => renderFrame(pixels, w, h));
  machine.start();

  canvas.style.display = "block";
  noRomMsg.style.display = "none";
  applyZoom(zoom);
  setStatus("Running");
}

function renderFrame(pixels: Uint8ClampedArray, w: number, h: number): void {
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width  = w;
    canvas.height = h;
    applyZoom(zoom);
  }
  const imageData = new ImageData(new Uint8ClampedArray(pixels.buffer as ArrayBuffer), w, h);
  ctx.putImageData(imageData, 0, 0);

  // Update performance counters
  if (machine) {
    statusFPS.textContent = `${machine.fps} fps`;
    statusMHz.textContent = `${machine.mhz} MHz`;
  }
}

function applyZoom(z: 1 | 2 | 3 | 4): void {
  zoom = z;
  canvas.style.width  = `${canvas.width  * z}px`;
  canvas.style.height = `${canvas.height * z}px`;
}

function setStatus(msg: string): void {
  sbState.textContent = msg;
}

function showMessage(msg: string, duration = 3000): void {
  sbMessage.textContent = msg;
  if (duration > 0) setTimeout(() => { sbMessage.textContent = ""; }, duration);
}

// ---------------------------------------------------------------------------
// Toolbar button handlers
// ---------------------------------------------------------------------------
btnLoadROM.addEventListener("click", () => {
  window.acorn.loadROM(""); // triggers dialog via IPC — path handled in main
});

btnLoadDisk.addEventListener("click", () => {
  window.acorn.loadDisk("");
});

btnReset.addEventListener("click", () => {
  machine?.reset();
  setStatus("Reset");
  showMessage("Machine reset");
});

btnPause.addEventListener("click", togglePause);

function togglePause(): void {
  paused = !paused;
  if (paused) {
    machine?.pause();
    iconPause.style.display = "none";
    iconPlay.style.display  = "block";
    pauseLabel.textContent  = "Resume";
    btnPause.classList.add("active");
    setStatus("Paused");
  } else {
    machine?.resume();
    iconPause.style.display = "block";
    iconPlay.style.display  = "none";
    pauseLabel.textContent  = "Pause";
    btnPause.classList.remove("active");
    setStatus("Running");
  }
}

zoomSelect.addEventListener("change", () => {
  applyZoom(Number(zoomSelect.value) as 1 | 2 | 3 | 4);
});

// ---------------------------------------------------------------------------
// Drag and drop
// ---------------------------------------------------------------------------
let dragCounter = 0;

displayArea.addEventListener("dragenter", (e) => {
  e.preventDefault();
  dragCounter++;
  displayArea.classList.add("drag-active");
});

displayArea.addEventListener("dragleave", () => {
  dragCounter--;
  if (dragCounter === 0) displayArea.classList.remove("drag-active");
});

displayArea.addEventListener("dragover", (e) => {
  e.preventDefault();
  e.dataTransfer!.dropEffect = "copy";
});

displayArea.addEventListener("drop", async (e) => {
  e.preventDefault();
  dragCounter = 0;
  displayArea.classList.remove("drag-active");

  const files = Array.from(e.dataTransfer?.files ?? []);
  if (files.length === 0) return;

  for (const file of files) {
    const path = (file as File & { path: string }).path;
    if (!path) continue;

    const ext = path.split(".").pop()?.toLowerCase();
    if (ext && ["rom", "bin", "img", "arc"].includes(ext)) {
      showMessage(`Loading ROM: ${file.name}…`, 0);
      await window.acorn.loadROM(path);
    } else if (ext && ["adf", "adl", "hdf", "vhd"].includes(ext)) {
      showMessage(`Loading disk: ${file.name}…`, 0);
      await window.acorn.loadDisk(path);
    } else {
      showMessage(`Unknown file type: .${ext}`);
    }
  }
});

// ---------------------------------------------------------------------------
// IPC events from main process
// ---------------------------------------------------------------------------
window.acorn.on(IPC.ROM_LOADED, (payload: unknown, buffer: unknown) => {
  const { path: romPath, sizeBytes } = payload as { path: string; sizeBytes: number };
  const data = new Uint8Array(buffer as ArrayBuffer);

  statusROM.textContent = romPath.split(/[\\/]/).pop() ?? "ROM";
  showMessage(`ROM loaded: ${(sizeBytes / 1024).toFixed(0)} KB`, 4000);
  createMachine(data);
});

window.acorn.on(IPC.DISK_LOADED, (payload: unknown) => {
  const { name, sizeBytes } = payload as { name: string; sizeBytes: number };
  showMessage(`Disk loaded: ${name} (${(sizeBytes / 1024).toFixed(0)} KB)`, 4000);
});

window.acorn.on(IPC.RESET, () => {
  machine?.reset();
  setStatus("Reset");
});

window.acorn.on("toggle-pause", togglePause);

window.acorn.on(IPC.SET_ZOOM, (level: unknown) => {
  const z = Number(level) as 1 | 2 | 3 | 4;
  zoomSelect.value = String(z);
  applyZoom(z);
});

window.acorn.on(IPC.SET_SPEED, (mult: unknown) => {
  config = { ...config, speedMultiplier: Number(mult) };
  if (machine) {
    // Restart with new speed
    const rom = (machine as unknown as { bus: { rom: Uint8Array } }).bus.rom;
    if (rom) createMachine(rom);
  }
});

window.acorn.on("set-cpu", (variant: unknown) => {
  config = { ...config, cpuVariant: variant as "ARM2" | "ARM3" };
  showMessage(`CPU set to ${variant as string}`);
});

window.acorn.on(IPC.ERROR, (payload: unknown) => {
  const { message } = payload as { message: string };
  showMessage(`Error: ${message}`, 6000);
  console.error("[Acorn]", message);
});

window.acorn.on("screenshot", () => {
  const link = document.createElement("a");
  link.download = `acorn-screenshot-${Date.now()}.png`;
  link.href = canvas.toDataURL("image/png");
  link.click();
  showMessage("Screenshot saved");
});
