/**
 * Application menu for the Acorn Desktop launcher window
 */
import { Menu, app, shell } from "electron";
import type { BrowserWindow } from "electron";

interface MenuCallbacks {
  onLoadROM: () => void;
  onReset:   () => void;
  onSetSpeed: (mult: number) => void;
  onSetCPU:  (v: "ARM2" | "ARM3") => void;
}

export function buildAppMenu(win: BrowserWindow, cb: MenuCallbacks): Menu {
  const isMac = process.platform === "darwin";

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{ label: app.name, submenu: [
      { role: "about" as const },
      { type: "separator" as const },
      { role: "quit" as const },
    ]}] : []),

    {
      label: "&File",
      submenu: [
        { label: "Load ROM...", accelerator: "CmdOrCtrl+O", click: cb.onLoadROM },
        { type: "separator" },
        isMac ? { role: "close" as const } : { role: "quit" as const, label: "E&xit" },
      ],
    },

    {
      label: "&Machine",
      submenu: [
        { label: "Reset", accelerator: "F12", click: cb.onReset },
        { type: "separator" },
        {
          label: "Speed",
          submenu: [
            { label: "50%",   type: "radio", click: () => cb.onSetSpeed(0.5) },
            { label: "Normal", type: "radio", checked: true, click: () => cb.onSetSpeed(1.0) },
            { label: "200%",  type: "radio", click: () => cb.onSetSpeed(2.0) },
            { label: "Uncapped", type: "radio", click: () => cb.onSetSpeed(0) },
          ],
        },
        { type: "separator" },
        { label: "ARM2 (8 MHz)",  type: "radio", checked: true, click: () => cb.onSetCPU("ARM2") },
        { label: "ARM3 (25 MHz)", type: "radio",                click: () => cb.onSetCPU("ARM3") },
      ],
    },

    {
      label: "&View",
      submenu: [
        { role: "toggleDevTools" },
        { type: "separator" },
        {
          label: "Full Screen",
          accelerator: process.platform === "darwin" ? "Ctrl+Command+F" : "F11",
          click: () => win.setFullScreen(!win.isFullScreen()),
        },
      ],
    },

    {
      label: "&Help",
      submenu: [
        { label: "RISC OS Open", click: () => shell.openExternal("https://www.riscosopen.org") },
      ],
    },
  ];

  return Menu.buildFromTemplate(template);
}
