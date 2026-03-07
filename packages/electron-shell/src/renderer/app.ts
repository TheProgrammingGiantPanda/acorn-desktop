/**
 * Launcher renderer — ROM picker, drag & drop, console output
 */

import { IPC } from "@theprogramminggiantpanda/shared";
import type { IpcChannel } from "@theprogramminggiantpanda/shared";

declare global {
  interface Window {
    acorn: {
      loadROM:  (path: string) => Promise<{ ok: boolean; error?: string }>;
      dragFile: (path: string) => Promise<void>;
      on:       (ch: IpcChannel | string, cb: (...a: unknown[]) => void) => () => void;
    };
  }
}

const btnLoadROM = document.getElementById("btn-load-rom") as HTMLButtonElement;
const btnReset   = document.getElementById("btn-reset")   as HTMLButtonElement;
const dropZone   = document.getElementById("drop-zone")!;
const statusEl   = document.getElementById("status")!;
const consoleEl  = document.getElementById("console")!;

function setStatus(msg: string): void { statusEl.textContent = msg; }

function appendConsole(text: string): void {
  consoleEl.classList.add("visible");
  consoleEl.textContent += text;
  consoleEl.scrollTop = consoleEl.scrollHeight;
}

btnLoadROM.addEventListener("click", () => window.acorn.loadROM(""));

btnReset.addEventListener("click", () => {
  window.acorn.on(IPC.RESET, () => {}); // trigger reset via IPC
});

// Drag & drop
let dragCount = 0;
dropZone.addEventListener("dragenter", (e) => { e.preventDefault(); dragCount++; dropZone.classList.add("active"); });
dropZone.addEventListener("dragleave", () => { dragCount--; if (!dragCount) dropZone.classList.remove("active"); });
dropZone.addEventListener("dragover", (e) => { e.preventDefault(); e.dataTransfer!.dropEffect = "copy"; });
dropZone.addEventListener("drop", async (e) => {
  e.preventDefault(); dragCount = 0; dropZone.classList.remove("active");
  const file = e.dataTransfer?.files[0];
  if (!file) return;
  const filePath = (file as File & { path: string }).path;
  setStatus(`Loading: ${file.name}…`);
  await window.acorn.dragFile(filePath);
});

// IPC events from main
window.acorn.on(IPC.ROM_LOADED, (payload: unknown) => {
  const { path: p, sizeBytes } = payload as { path: string; sizeBytes: number };
  const name = p.replace(/\\/g, "/").split("/").pop() ?? p;
  setStatus(`ROM loaded: ${name} (${(sizeBytes / 1024).toFixed(0)} KB) — RISC OS windows will open automatically`);
  btnReset.disabled = false;
  dropZone.innerHTML = `<p style="color:var(--accent); font-size:14px">Running: ${name}</p>
    <p style="font-size:11px">RISC OS program windows appear as native windows.</p>`;
});

window.acorn.on("console-output", (text: unknown) => appendConsole(String(text)));

window.acorn.on(IPC.ERROR, (payload: unknown) => {
  const { message } = payload as { message: string };
  setStatus(`Error: ${message}`);
});

window.acorn.on("machine-started", () => {
  setStatus("Machine running");
});
