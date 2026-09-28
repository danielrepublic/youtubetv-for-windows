import { app, BrowserWindow, dialog, session, shell } from "electron";
import { YOUTUBE_TV_URL, startHost } from "./app.ts";
import { createProfileDiagnostics } from "./diagnostics.ts";
import type { DiagnosticsSink } from "./diagnostics.ts";
import {
  SUPPORT_RELEASE_URL,
  profileFallbackDialog,
  showUpdateGuidance,
  updateRepairDialog,
} from "./dialogs.ts";
import type { DialogPresenter } from "./dialogs.ts";
import {
  activateProductionProfile,
  resolveUpdateDirectoryConvention,
} from "./profile-path.ts";
import { IDENTITY_PARTITION } from "./session.ts";
import { createMemoryEtagCache } from "./update/discovery.ts";
import { PRODUCTION_KEYRING } from "./update/keyring.ts";
import { readLaunchUpdateNonce } from "./update/launch-arguments.ts";
import { verifyAndConsumeSuccessMarker } from "./update/relaunch.ts";
import { runPreWindowStage, spawnDetachedInstaller } from "./update/startup.ts";

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

  const presenter: DialogPresenter = {
    showMessageBox: (options) => dialog.showMessageBox(options),
  };
  const openDownloadPage = (): void => {
    void shell.openExternal(SUPPORT_RELEASE_URL);
  };

  // Post-install relaunch verification: the installer relaunches this
  // executable with --update-nonce and is expected to have written the
  // atomic success marker for that nonce first. A valid marker is consumed
  // and the app continues. A missing/invalid marker cannot be proven, so
  // the bilingual repair/manual-download guidance is shown — there is no
  // rollback and the message never claims one.
  const updateDirectories = resolveUpdateDirectoryConvention(profile.directory);
  const launchNonce = readLaunchUpdateNonce();
  if (launchNonce !== null) {
    const verification = verifyAndConsumeSuccessMarker({
      statusDirectory: updateDirectories.statusDirectory,
      nonce: launchNonce,
    });
    if (verification.ok) {
      diagnostics?.record({ event: "update-relaunch-verified" });
    } else {
      diagnostics?.record({ event: "update-relaunch-repair" });
      await showUpdateGuidance(
        presenter,
        updateRepairDialog(verification.reason),
        openDownloadPage,
      );
    }
  }

  // The launcher stage. `startHost` awaits this BEFORE creating a window, so
  // a verified installer is handed off before any UI exists, and a quit
  // decision returns without ever creating a window.
  const version = app.getVersion();
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
      preWindowStage: () =>
        runPreWindowStage({
          // REAL transport in production; tests inject a fake feed.
          transport: globalThis.fetch,
          keyring: PRODUCTION_KEYRING,
          version,
          etagCache: createMemoryEtagCache(),
          now: () => Date.now(),
          processId: process.pid,
          spawnInstaller: spawnDetachedInstaller,
          requestQuit: () => {
            app.quit();
          },
          presenter,
          openDownloadPage,
          report: (record) => {
            diagnostics?.record(record);
          },
          profileDirectory: profile.directory,
        }),
    },
  );
}

void bootstrap();

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
