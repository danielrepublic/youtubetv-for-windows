import { app, BrowserWindow, dialog, session, shell } from "electron";
import { YOUTUBE_TV_URL, startHost } from "./app.ts";
import { createProfileDiagnostics } from "./diagnostics.ts";
import type { DiagnosticsSink } from "./diagnostics.ts";
import { profileFallbackDialog } from "./dialogs.ts";
import type { DialogPresenter } from "./dialogs.ts";
import { activateProductionProfile } from "./profile-path.ts";
import { IDENTITY_PARTITION } from "./session.ts";

// The data-path redirect runs SYNCHRONOUSLY at module scope, before
// app.whenReady() is ever awaited. Two different races are at stake, and
// only the earlier one is safe:
//
//   * The first session access (session.fromPartition, any BrowserWindow) must
//     not happen before the redirect, or the window is pinned to the default
//     path.
//   * Chromium's own service children snapshot the CURRENT userData value
//     when each one is spawned, and Electron's documented requirement is that
//     app.setPath runs before the `ready` event. Running the redirect inside
//     bootstrap() lost that race: the GPU and network-service children were
//     already up with the compiled-in default roaming path, and their
//     graphics caches landed in %APPDATA%\%APPNAME% — a tree the uninstaller
//     does not own and never removed.
//
// This must therefore stay at module top level and stay synchronous. Moving
// it back inside bootstrap() reintroduces the residue; adding an await before
// it does the same.
const profile = activateProductionProfile(app);

async function bootstrap(): Promise<void> {
  await app.whenReady();
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

  const presenter: DialogPresenter = {
    showMessageBox: (options) => dialog.showMessageBox(options),
  };
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
      presenter,
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
