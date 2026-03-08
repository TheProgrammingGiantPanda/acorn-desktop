import { contextBridge, ipcRenderer } from "electron";

// IPC channel names inlined to avoid a workspace-package require() in the
// sandboxed preload context (shared package is not resolvable at runtime).
const CH_LIST    = "browser:list-apps";
const CH_LAUNCH  = "browser:launch-app";
const CH_INSTALL = "browser:install-app";
const CH_REFRESH = "browser:refresh";

const browserAPI = {
  listApps: (): Promise<unknown[]> =>
    ipcRenderer.invoke(CH_LIST),

  launchApp: (name: string): Promise<void> =>
    ipcRenderer.invoke(CH_LAUNCH, name),

  installApp: (hostPath: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(CH_INSTALL, hostPath),

  onRefresh: (cb: () => void) => {
    const handler = () => cb();
    ipcRenderer.on(CH_REFRESH, handler);
    return () => ipcRenderer.off(CH_REFRESH, handler);
  },
};

contextBridge.exposeInMainWorld("programsBrowser", browserAPI);
export type ProgramsBrowserAPI = typeof browserAPI;
