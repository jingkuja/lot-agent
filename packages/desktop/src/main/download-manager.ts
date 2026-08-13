import path from "node:path";
import { app, BrowserWindow, dialog, session } from "electron";

/**
 * Native download manager: intercepts every renderer download
 * (`<a download>` clicks on generated images / videos / docx / pptx), asks
 * where to save via the OS dialog, and streams progress to the renderer's
 * DownloadToast over the `lot:download` channel.
 */
export function setupDownloadManager(
  getWindow: () => BrowserWindow | null
): void {
  session.defaultSession.on("will-download", (_event, item) => {
    const id = `dl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const filename = item.getFilename();
    const totalBytes = item.getTotalBytes();

    const send = (patch: Record<string, unknown>) => {
      const win = getWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send("lot:download", {
          id,
          filename,
          totalBytes,
          ...patch,
        });
      }
    };

    void (async () => {
      const win = getWindow();
      const options = {
        title: "保存文件",
        defaultPath: path.join(app.getPath("downloads"), filename),
        buttonLabel: "保存",
      };
      const result = win
        ? await dialog.showSaveDialog(win, options)
        : await dialog.showSaveDialog(options);

      if (result.canceled || !result.filePath) {
        item.cancel();
        send({ state: "cancelled", receivedBytes: item.getReceivedBytes() });
        return;
      }

      item.setSavePath(result.filePath);
      item.on("updated", (_e, state) => {
        if (state === "interrupted") {
          send({
            state: "interrupted",
            receivedBytes: item.getReceivedBytes(),
          });
        } else {
          send({ state: "progressing", receivedBytes: item.getReceivedBytes() });
        }
      });
      item.once("done", (_e, state) => {
        if (state === "completed") {
          send({
            state: "completed",
            receivedBytes: item.getTotalBytes(),
            path: item.getSavePath(),
          });
        } else {
          send({
            state: state === "cancelled" ? "cancelled" : "interrupted",
            receivedBytes: item.getReceivedBytes(),
          });
        }
      });
    })().catch((error) => {
      send({ state: "interrupted", receivedBytes: 0, error: String(error) });
    });
  });
}
