import { contextBridge, ipcRenderer } from "electron";

/** IPC-safe form of a RISC OS sprite (rgba as plain number[]). */
export interface SerialisedSprite {
  name:   string;
  rgba:   number[];
  width:  number;
  height: number;
}

interface IconbarEntry {
  sprite: string;
  text: string;
  spriteData?: SerialisedSprite;
}

contextBridge.exposeInMainWorld("iconbar", {
  onUpdate: (cb: (entries: [number, IconbarEntry][]) => void) => {
    ipcRenderer.on("iconbar-update", (_, entries) => cb(entries));
  },
  click: (taskHandle: number, buttons: number) => {
    ipcRenderer.send("iconbar-click", { taskHandle, buttons });
  },
});
