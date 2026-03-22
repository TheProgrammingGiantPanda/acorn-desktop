import { contextBridge, ipcRenderer } from "electron";

// IPC channel names inlined to avoid a workspace-package require() in the
// sandboxed preload context.
const CH_LIST_DIR = "hostfs:list-dir";
const CH_LAUNCH   = "hostfs:launch";
const CH_OPEN_DIR = "hostfs:open-dir";

const hostfsBrowserAPI = {
  listDir: (riscosPath: string): Promise<unknown[]> =>
    ipcRenderer.invoke(CH_LIST_DIR, riscosPath),

  launch: (riscosPath: string): Promise<void> =>
    ipcRenderer.invoke(CH_LAUNCH, riscosPath),

  openDir: (riscosPath: string): Promise<void> =>
    ipcRenderer.invoke(CH_OPEN_DIR, riscosPath),
};

contextBridge.exposeInMainWorld("hostfsBrowser", hostfsBrowserAPI);
export type HostFsBrowserAPI = typeof hostfsBrowserAPI;
