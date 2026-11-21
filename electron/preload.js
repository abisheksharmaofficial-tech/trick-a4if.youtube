import { contextBridge, ipcRenderer } from "electron";

const allowedChannels = new Set([
  "app:ping",
  "app:getVersion",
  "window:minimize",
  "window:maximize",
  "window:close"
]);

contextBridge.exposeInMainWorld("trickA4ifDesktop", {
  platform: process.platform,
  versions: {
    electron: process.versions.electron || "",
    chrome: process.versions.chrome || "",
    node: process.versions.node || ""
  },
  invoke: async (channel, payload = null) => {
    try {
      if (!allowedChannels.has(channel)) {
        return { ok: false, error: "CHANNEL_NOT_ALLOWED" };
      }
      const data = await ipcRenderer.invoke(channel, payload);
      return { ok: true, data };
    } catch (err) {
      return {
        ok: false,
        error: err && err.message ? String(err.message) : "IPC_INVOKE_FAILED"
      };
    }
  }
});
