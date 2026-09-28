import { app, BrowserWindow, session } from "electron";
import { YOUTUBE_TV_URL, startHost } from "./app.ts";
import { IDENTITY_PARTITION } from "./session.ts";

async function bootstrap(): Promise<void> {
  await app.whenReady();
  await startHost(
    {
      session: session.fromPartition(IDENTITY_PARTITION),
      appPath: app.getAppPath(),
      createWindow: (options) => new BrowserWindow(options),
    },
    YOUTUBE_TV_URL,
  );
}

void bootstrap();

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
