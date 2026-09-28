import { app, BrowserWindow, dialog, session, shell } from "electron";
import { YOUTUBE_TV_URL, startHost } from "./app.ts";
import { createProfileDiagnostics } from "./diagnostics.ts";
import type { DiagnosticsSink } from "./diagnostics.ts";
import { profileFallbackDialog } from "./dialogs.ts";
import { activateProductionProfile } from "./profile-path.ts";
import { IDENTITY_PARTITION } from "./session.ts";

async function bootstrap(): Promise<void> {
  await app.whenReady();
  // The profile directory must be fixed BEFORE the first session access
  // below: app.setPath("sessionData", …) after the session exists leaves
  // the window on the default path.
  const profile = activateProductionProfile(app);
  // Opt-in lifecycle telemetry (docs/live-sign-in-certification.md). The
  // factory returns null — and nothing at all is wired — unless the
  // documented sentinel file exists next to the profile directory.
  const diagnostics: DiagnosticsSink | null = createProfileDiagnostics(
    profile.directory,
  );
  diagnostics?.record({ event: "app-ready" });
  app.on("quit", () => {
    diagnostics?.record({ event: "app-quit" });
  });
  if (profile.usedFallback && profile.guidance !== null) {
    const fallbackNotice = profileFallbackDialog(
      "the configured profile directory",
      profile.directory,
    );
    await dialog.showMessageBox({
      title: fallbackNotice.title,
      message: `${profile.guidance.zhTW}\n${profile.guidance.en}`,
      detail: fallbackNotice.message,
      buttons: [...fallbackNotice.buttons],
    });
  }
  await startHost(
    {
      session: session.fromPartition(IDENTITY_PARTITION),
      appPath: app.getAppPath(),
      createWindow: (options) => new BrowserWindow(options),
    },
    YOUTUBE_TV_URL,
    {
      opener: {
        openExternal: (url: string) => {
          void shell.openExternal(url);
        },
      },
      presenter: {
        showMessageBox: (options) => dialog.showMessageBox(options),
      },
      diagnostics: diagnostics ?? undefined,
    },
  );
}

void bootstrap();

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
