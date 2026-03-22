/**
 * Preload for individual RISC OS windows
 */
import { contextBridge, ipcRenderer } from "electron";

// Extract the Wimp window handle from the --wimp-handle argument
const handleArg = process.argv.find(a => a.startsWith("--wimp-handle="));
const wimpHandle = handleArg ? Number(handleArg.split("=")[1]) : -1;

contextBridge.exposeInMainWorld("wimpWindow", {
  handle: wimpHandle,

  onClick: (x: number, y: number, buttons: number, iconHandle?: number) => {
    ipcRenderer.send("wimp-click", { winHandle: wimpHandle, x, y, buttons, iconHandle });
  },
  onKey: (charCode: number) => {
    ipcRenderer.send("wimp-key", { winHandle: wimpHandle, charCode });
  },
  onDraw: (callback: (cmds: unknown[]) => void) => {
    ipcRenderer.on("wimp-draw", (_, cmds) => callback(cmds));
  },
  onUpdateIcon: (callback: (data: unknown) => void) => {
    ipcRenderer.on("wimp-update-icon", (_, data) => callback(data));
  },
  onResize: (callback: () => void) => {
    ipcRenderer.on("wimp-resize", () => callback());
  },
  onPixels: (callback: (data: { width: number; height: number; pixels: Uint8Array }) => void) => {
    ipcRenderer.on("wimp-pixels", (_, data) => callback(data));
  },
});
