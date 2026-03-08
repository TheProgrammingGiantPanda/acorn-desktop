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
  /** Notify main that the user has scrolled to a new RISC OS scroll position */
  sendScroll: (scrollX: number, scrollY: number) => {
    ipcRenderer.send("wimp-scroll", { winHandle: wimpHandle, scrollX, scrollY });
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
  /** Receive work-area / scroll-position info from main to drive scroll bars */
  onWorkArea: (callback: (data: {
    scrollX: number; scrollY: number;
    workX0: number; workY0: number; workX1: number; workY1: number;
    hasHScroll: boolean; hasVScroll: boolean;
  }) => void) => {
    ipcRenderer.on("wimp-workarea", (_, data) => callback(data));
  },
});
