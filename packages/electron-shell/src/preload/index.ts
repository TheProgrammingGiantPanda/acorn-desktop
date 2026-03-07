/**
 * Preload script — exposes a safe subset of Electron APIs to the renderer
 * via contextBridge.
 */
import { contextBridge, ipcRenderer } from "electron";
import { IPC } from "@acorn/shared";
import type { IpcChannel } from "@acorn/shared";

/** Safe API exposed on window.acorn */
const acornAPI = {
  // Renderer → Main
  loadROM:   (filePath: string) => ipcRenderer.invoke(IPC.LOAD_ROM,  { path: filePath }),
  loadDisk:  (filePath: string) => ipcRenderer.invoke(IPC.LOAD_DISK, { path: filePath }),
  reset:     ()                 => ipcRenderer.send(IPC.RESET),
  pause:     ()                 => ipcRenderer.send(IPC.PAUSE),
  resume:    ()                 => ipcRenderer.send(IPC.RESUME),
  setZoom:   (level: number)    => ipcRenderer.send(IPC.SET_ZOOM,  level),
  setSpeed:  (mult: number)     => ipcRenderer.send(IPC.SET_SPEED, mult),
  dragFile:  (path: string)     => ipcRenderer.invoke(IPC.DRAG_FILE, path),

  // Main → Renderer listeners
  on: (channel: IpcChannel, callback: (...args: unknown[]) => void) => {
    const sub = (_: Electron.IpcRendererEvent, ...args: unknown[]) => callback(...args);
    ipcRenderer.on(channel, sub);
    return () => ipcRenderer.off(channel, sub);
  },

  once: (channel: IpcChannel, callback: (...args: unknown[]) => void) => {
    ipcRenderer.once(channel, (_, ...args) => callback(...args));
  },
};

contextBridge.exposeInMainWorld("acorn", acornAPI);

export type AcornAPI = typeof acornAPI;
