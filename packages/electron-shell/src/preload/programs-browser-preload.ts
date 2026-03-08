import { contextBridge, ipcRenderer } from "electron";
import { IPC } from "@theprogramminggiantpanda/shared";
import type { AppEntry } from "@theprogramminggiantpanda/shared";

const browserAPI = {
  listApps: (): Promise<AppEntry[]> =>
    ipcRenderer.invoke(IPC.BROWSER_LIST_APPS),

  launchApp: (name: string): Promise<void> =>
    ipcRenderer.invoke(IPC.BROWSER_LAUNCH_APP, name),

  installApp: (hostPath: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.BROWSER_INSTALL_APP, hostPath),

  onRefresh: (cb: () => void) => {
    const handler = () => cb();
    ipcRenderer.on(IPC.BROWSER_REFRESH, handler);
    return () => ipcRenderer.off(IPC.BROWSER_REFRESH, handler);
  },
};

contextBridge.exposeInMainWorld("programsBrowser", browserAPI);
export type ProgramsBrowserAPI = typeof browserAPI;
