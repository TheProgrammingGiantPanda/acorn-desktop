/**
 * Native application menu for the Acorn Desktop emulator
 */
import { Menu, MenuItem, BrowserWindow, dialog, app, shell } from "electron";
import { IPC } from "@acorn/shared";

export function buildMenu(win: BrowserWindow): Menu {
  const isMac = process.platform === "darwin";

  const template: Electron.MenuItemConstructorOptions[] = [
    // macOS app menu
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" as const },
              { type: "separator" as const },
              { role: "services" as const },
              { type: "separator" as const },
              { role: "hide" as const },
              { role: "hideOthers" as const },
              { role: "unhide" as const },
              { type: "separator" as const },
              { role: "quit" as const },
            ],
          },
        ]
      : []),

    // File
    {
      label: "&File",
      submenu: [
        {
          label: "Load ROM...",
          accelerator: "CmdOrCtrl+O",
          click: async () => {
            const result = await dialog.showOpenDialog(win, {
              title: "Load RISC OS ROM",
              filters: [
                { name: "ROM Images", extensions: ["rom", "bin", "img", "arc"] },
                { name: "All Files", extensions: ["*"] },
              ],
              properties: ["openFile"],
            });
            if (!result.canceled && result.filePaths[0]) {
              win.webContents.send(IPC.LOAD_ROM, { path: result.filePaths[0] });
            }
          },
        },
        {
          label: "Load Disk Image...",
          accelerator: "CmdOrCtrl+D",
          click: async () => {
            const result = await dialog.showOpenDialog(win, {
              title: "Load Disk Image",
              filters: [
                { name: "Disk Images", extensions: ["adf", "adl", "hdf", "vhd", "img"] },
                { name: "All Files", extensions: ["*"] },
              ],
              properties: ["openFile"],
            });
            if (!result.canceled && result.filePaths[0]) {
              win.webContents.send(IPC.LOAD_DISK, { path: result.filePaths[0] });
            }
          },
        },
        { type: "separator" },
        {
          label: "Screenshot",
          accelerator: "CmdOrCtrl+Shift+S",
          click: () => win.webContents.send("screenshot"),
        },
        { type: "separator" },
        isMac
          ? { role: "close" as const }
          : { role: "quit" as const, label: "E&xit" },
      ],
    },

    // Machine
    {
      label: "&Machine",
      submenu: [
        {
          label: "Reset",
          accelerator: "F12",
          click: () => win.webContents.send(IPC.RESET),
        },
        {
          label: "Pause / Resume",
          accelerator: "F11",
          click: () => win.webContents.send("toggle-pause"),
        },
        { type: "separator" },
        {
          label: "Speed",
          submenu: [
            speedItem(win, "25%",   0.25),
            speedItem(win, "50%",   0.50),
            speedItem(win, "Normal (100%)", 1.0, true),
            speedItem(win, "200%",  2.0),
            speedItem(win, "Fastest (uncapped)", 0),
          ],
        },
        { type: "separator" },
        {
          label: "CPU: ARM2 (8 MHz)",
          type: "radio",
          checked: true,
          click: () => win.webContents.send("set-cpu", "ARM2"),
        },
        {
          label: "CPU: ARM3 (25 MHz)",
          type: "radio",
          click: () => win.webContents.send("set-cpu", "ARM3"),
        },
      ],
    },

    // View
    {
      label: "&View",
      submenu: [
        {
          label: "Zoom 1x",
          accelerator: "CmdOrCtrl+1",
          click: () => win.webContents.send(IPC.SET_ZOOM, 1),
        },
        {
          label: "Zoom 2x",
          accelerator: "CmdOrCtrl+2",
          click: () => win.webContents.send(IPC.SET_ZOOM, 2),
        },
        {
          label: "Zoom 3x",
          accelerator: "CmdOrCtrl+3",
          click: () => win.webContents.send(IPC.SET_ZOOM, 3),
        },
        {
          label: "Zoom 4x",
          accelerator: "CmdOrCtrl+4",
          click: () => win.webContents.send(IPC.SET_ZOOM, 4),
        },
        { type: "separator" },
        {
          label: "Full Screen",
          accelerator: isMac ? "Ctrl+Command+F" : "F11",
          click: () => win.setFullScreen(!win.isFullScreen()),
        },
        { type: "separator" },
        { role: "toggleDevTools" },
      ],
    },

    // Help
    {
      label: "&Help",
      submenu: [
        {
          label: "About Acorn Desktop",
          click: () => {
            dialog.showMessageBox(win, {
              type: "info",
              title: "About Acorn Desktop",
              message: "Acorn Desktop",
              detail: [
                "Acorn Archimedes Emulator",
                "",
                "Emulates the ARM2/ARM3 processor and Archimedes chipset",
                "(VIDC, MEMC, IOC) to run RISC OS software.",
                "",
                "Version 0.1.0",
              ].join("\n"),
            });
          },
        },
        { type: "separator" },
        {
          label: "RISC OS Open",
          click: () => shell.openExternal("https://www.riscosopen.org"),
        },
        {
          label: "Archimedes Hardware Reference",
          click: () => shell.openExternal("https://www.chiark.greenend.org.uk/~theom/riscos/docs/ArchitectureRef/"),
        },
      ],
    },
  ];

  return Menu.buildFromTemplate(template);
}

function speedItem(
  win: BrowserWindow,
  label: string,
  mult: number,
  checked = false
): Electron.MenuItemConstructorOptions {
  return {
    label,
    type: "radio",
    checked,
    click: () => win.webContents.send(IPC.SET_SPEED, mult),
  };
}
