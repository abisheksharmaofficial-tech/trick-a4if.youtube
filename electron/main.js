import { app, BrowserWindow, ipcMain, shell } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow = null;

function resolveAppIcon() {
  try {
    return path.join(__dirname, "..", "public", "favicon.ico");
  } catch {
    return undefined;
  }
}

function createMainWindow() {
  try {
    const win = new BrowserWindow({
      width: 1280,
      height: 820,
      minWidth: 900,
      minHeight: 600,
      show: false,
      autoHideMenuBar: true,
      icon: resolveAppIcon(),
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });

    win.once("ready-to-show", () => {
      try {
        if (!win.isDestroyed()) {
          win.show();
        }
      } catch {}
    });

    win.webContents.setWindowOpenHandler(({ url }) => {
      try {
        const parsed = new URL(url);
        if (parsed.protocol === "https:" || parsed.protocol === "http:") {
          shell.openExternal(url).catch(() => {});
        }
      } catch {}
      return { action: "deny" };
    });

    const devServerUrl = process.env.VITE_DEV_SERVER_URL;
    if (devServerUrl) {
      win.loadURL(devServerUrl).catch(() => {});
    } else {
      const distIndex = path.join(__dirname, "..", "dist", "index.html");
      win.loadFile(distIndex).catch(() => {});
    }

    win.on("closed", () => {
      mainWindow = null;
    });

    mainWindow = win;
  } catch {
    mainWindow = null;
  }
}

ipcMain.handle("app:ping", () => "pong");

ipcMain.handle("app:getVersion", () => app.getVersion());

ipcMain.handle("window:minimize", () => {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.minimize();
      return true;
    }
  } catch {}
  return false;
});

ipcMain.handle("window:maximize", () => {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMaximized()) {
        mainWindow.unmaximize();
      } else {
        mainWindow.maximize();
      }
      return true;
    }
  } catch {}
  return false;
});

ipcMain.handle("window:close", () => {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.close();
      return true;
    }
  } catch {}
  return false;
});

app.whenReady().then(() => {
  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
