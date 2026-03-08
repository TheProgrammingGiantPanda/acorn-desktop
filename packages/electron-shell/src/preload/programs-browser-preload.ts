import { contextBridge, ipcRenderer } from "electron";

const browserAPI = {
  listApps: (): Promise<unknown[]> =>
    ipcRenderer.invoke("browser:list-apps"),

  launchApp: (name: string): Promise<void> =>
    ipcRenderer.invoke("browser:launch-app", name),

  installApp: (hostPath: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke("browser:install-app", hostPath),

  onRefresh: (cb: () => void) => {
    const handler = () => cb();
    ipcRenderer.on("browser:refresh", handler);
    return () => ipcRenderer.off("browser:refresh", handler);
  },
};

contextBridge.exposeInMainWorld("programsBrowser", browserAPI);
export type ProgramsBrowserAPI = typeof browserAPI;
