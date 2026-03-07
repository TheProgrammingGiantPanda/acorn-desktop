import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("iconbar", {
  onUpdate: (cb: (entries: [number, { sprite: string; text: string }][]) => void) => {
    ipcRenderer.on("iconbar-update", (_, entries) => cb(entries));
  },
  click: (taskHandle: number, buttons: number) => {
    ipcRenderer.send("iconbar-click", { taskHandle, buttons });
  },
});
