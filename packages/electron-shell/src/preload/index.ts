import { contextBridge, ipcRenderer } from "electron";
import { IPC } from "@theprogramminggiantpanda/shared";
import type { IpcChannel } from "@theprogramminggiantpanda/shared";

const acornAPI = {
  loadROM:   (filePath: string) => ipcRenderer.invoke(IPC.LOAD_ROM,  { path: filePath }),
  loadDisk:  (filePath: string) => ipcRenderer.invoke(IPC.LOAD_DISK, { path: filePath }),
  reset:     ()                 => ipcRenderer.send(IPC.RESET),
  dragFile:  (p: string)        => ipcRenderer.invoke(IPC.DRAG_FILE, p),

  on: (channel: IpcChannel | string, callback: (...args: unknown[]) => void) => {
    const sub = (_: Electron.IpcRendererEvent, ...args: unknown[]) => callback(...args);
    ipcRenderer.on(channel, sub);
    return () => ipcRenderer.off(channel, sub);
  },

  once: (channel: IpcChannel | string, callback: (...args: unknown[]) => void) => {
    ipcRenderer.once(channel, (_, ...args) => callback(...args));
  },
};

contextBridge.exposeInMainWorld("acorn", acornAPI);
export type AcornAPI = typeof acornAPI;
