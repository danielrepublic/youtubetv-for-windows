// Bilingual (Traditional Chinese + English) native-dialog catalog.
//
// Every user-visible message carries both zhTW and en text, and the rendered
// dialog body and buttons always contain BOTH languages (for example
// "重試 (Retry)"), because the app-owned language contract is Traditional
// Chinese and English while YouTube TV's own UI language stays outside app
// control. dialog.showMessageBox is never called directly: callers receive a
// DialogPresenter (production: Electron dialog.showMessageBox) so tests can
// assert the exact options without a human clicking anything.

export type RouteFailureKind = "redirected-away" | "load-failed";

export type RouteFailureAction = "retry" | "open-browser" | "support";

export interface BilingualText {
  zhTW: string;
  en: string;
}

// The single external support destination for host failures: the project's
// latest release page. Opened only via the injected openExternal with a
// validated https: URL.
export const SUPPORT_RELEASE_URL =
  "https://github.com/danielrepublic/youtubetv-for-windows/releases/latest";

export interface RouteFailureDialogContent {
  title: string;
  message: string;
  detail: string;
  buttons: [string, string, string];
}

const RETRY_BUTTON = "重試 (Retry)";
const OPEN_BROWSER_BUTTON = "在瀏覽器中開啟 (Open in browser)";
const SUPPORT_BUTTON = "支援 (Support)";

const ROUTE_FAILURE_TITLE = "YouTube TV 無法載入 / YouTube TV failed to load";

const ROUTE_FAILURE_MESSAGES: Record<RouteFailureKind, BilingualText> = {
  "redirected-away": {
    zhTW: "YouTube TV 頁面被重新導向，離開了電視版介面。請重試，或在瀏覽器中開啟。",
    en: "The YouTube TV page redirected away from the TV interface. Retry, or open it in your browser.",
  },
  "load-failed": {
    zhTW: "YouTube TV 頁面載入失敗。請檢查網路連線後重試，或在瀏覽器中開啟。",
    en: "The YouTube TV page failed to load. Check your network connection and retry, or open it in your browser.",
  },
};

export function routeFailureDialog(
  kind: RouteFailureKind,
): RouteFailureDialogContent {
  const body = ROUTE_FAILURE_MESSAGES[kind];
  return {
    title: ROUTE_FAILURE_TITLE,
    message: `${body.zhTW}\n${body.en}`,
    detail: `${SUPPORT_RELEASE_URL}`,
    buttons: [RETRY_BUTTON, OPEN_BROWSER_BUTTON, SUPPORT_BUTTON],
  };
}

export function profileFallbackDialog(
  failedDirectory: string,
  fallbackDirectory: string,
): { title: string; message: string; buttons: [string] } {
  return {
    title: "設定檔問題 / Profile issue",
    message:
      `無法使用設定檔目錄（${failedDirectory}），已改用暫時設定檔繼續啟動（${fallbackDirectory}）。\n` +
      `The profile directory (${failedDirectory}) is unavailable, so the app ` +
      `started with a temporary profile (${fallbackDirectory}). ` +
      `此次工作階段的登入狀態不會保留；Sign-in state will not persist for this session.`,
    buttons: ["確定 (OK)"],
  };
}

// ---------------------------------------------------------------------------
// Update guidance (todo 6)
//
// Two bilingual surfaces cover every non-happy update outcome:
//
//   - updateFailureDialog — a PRE-install failure (download, verification, or
//     the verified installer could not be started). The installed version
//     still launches; the user may download the release manually.
//   - updateRepairDialog  — a POST-handoff problem: the update was handed to
//     the installer but the installation cannot be confirmed. Either the
//     atomic success marker is missing or invalid, or no installer ever
//     relaunched the app and the recorded attempt is unconfirmed — a failed
//     installer or a nonzero installer exit can only ever be detected from the
//     app side, because the launcher has already quit and observes nothing.
//
// Neither message ever promises a rollback. The previous application files
// were replaced by the installer, and the documented recovery is a manual
// download from the release page — the text says exactly that, in both
// languages. Both dialogs offer the release page as the first button.
// ---------------------------------------------------------------------------

export type UpdateFailureKind =
  "download-or-verify-failed" | "installer-launch-failed";

/**
 * Why a post-install attempt cannot be confirmed.
 *
 *   - `missing` / `invalid` — the installer relaunched this executable with
 *     the nonce, so the atomic receipt is expected to exist and does not.
 *   - `unconfirmed` — no installer relaunched the app at all, yet an attempt
 *     was durably recorded before the handoff. The installer aborted before it
 *     could write anything (a bad handoff, the parent-wait timeout) or died
 *     part-way through replacing files, so neither the receipt nor the target
 *     version can be confirmed.
 *
 * All three share one honest message shape: the installation cannot be
 * confirmed, there is no automatic rollback, and the documented recovery is a
 * manual download from the release page.
 */
export type UpdateRepairReason = "missing" | "invalid" | "unconfirmed";

const OPEN_DOWNLOAD_BUTTON = "開啟下載頁面 (Open download page)";
const CONFIRM_BUTTON = "確定 (OK)";

export interface UpdateGuidanceDialogContent {
  title: string;
  message: string;
  detail: string;
  buttons: [string, string];
}

const UPDATE_FAILURE_MESSAGES: Record<UpdateFailureKind, BilingualText> = {
  "download-or-verify-failed": {
    zhTW: "更新下載或驗證失敗，將以目前已安裝的版本啟動。你仍可從下方網址手動下載最新的安裝檔。",
    en: "The update could not be downloaded or verified, so the installed version will start. You can still download the latest installer manually from the link below.",
  },
  "installer-launch-failed": {
    zhTW: "已驗證的更新程式無法啟動，將以目前已安裝的版本啟動。你仍可從下方網址手動下載最新的安裝檔。",
    en: "The verified update installer could not be started, so the installed version will start. You can still download the latest installer manually from the link below.",
  },
};

export function updateFailureDialog(
  kind: UpdateFailureKind,
): UpdateGuidanceDialogContent {
  const body = UPDATE_FAILURE_MESSAGES[kind];
  return {
    title: "更新失敗 / Update failed",
    message: `${body.zhTW}\n${body.en}`,
    detail: SUPPORT_RELEASE_URL,
    buttons: [OPEN_DOWNLOAD_BUTTON, CONFIRM_BUTTON],
  };
}

const UPDATE_REPAIR_MESSAGES: Record<UpdateRepairReason, BilingualText> = {
  missing: {
    zhTW: "更新後的首次啟動找不到完成標記，無法確認此次安裝成功。此程式沒有自動回復功能，請以手動方式重新下載並安裝最新版本。",
    en: "The completed-install marker was not found after the update, so this installation cannot be confirmed. There is no automatic rollback; download and install the latest version manually.",
  },
  invalid: {
    zhTW: "更新完成標記無效，無法確認此次安裝成功。此程式沒有自動回復功能，請以手動方式重新下載並安裝最新版本。",
    en: "The completed-install marker is invalid, so this installation cannot be confirmed. There is no automatic rollback; download and install the latest version manually.",
  },
  unconfirmed: {
    zhTW: "上次的更新在安裝階段未能完成，無法確認是否已套用。此程式沒有自動回復功能，請以手動方式重新下載並安裝最新版本。",
    en: "The previous update did not finish installing, so it cannot be confirmed whether it was applied. There is no automatic rollback; download and install the latest version manually.",
  },
};

export function updateRepairDialog(
  reason: UpdateRepairReason,
): UpdateGuidanceDialogContent {
  const body = UPDATE_REPAIR_MESSAGES[reason];
  return {
    title: "更新回復指引 / Update recovery guidance",
    message: `${body.zhTW}\n${body.en}`,
    detail: SUPPORT_RELEASE_URL,
    buttons: [OPEN_DOWNLOAD_BUTTON, CONFIRM_BUTTON],
  };
}

/** Shows update guidance; the first button opens the release page. */
export async function showUpdateGuidance(
  presenter: DialogPresenter,
  content: UpdateGuidanceDialogContent,
  openDownloadPage: () => void,
): Promise<void> {
  const result = await presenter.showMessageBox({
    title: content.title,
    message: content.message,
    detail: content.detail,
    buttons: [...content.buttons],
    defaultId: 0,
    cancelId: 1,
  });
  if (result.response === 0) {
    openDownloadPage();
  }
}

export interface MessageBoxOptions {
  title?: string;
  message: string;
  detail?: string;
  buttons: string[];
  defaultId?: number;
  cancelId?: number;
}

// Injectable Electron dialog surface (production: the `dialog` module's
// showMessageBox). The promise resolves to the clicked button index.
export interface DialogPresenter {
  showMessageBox(options: MessageBoxOptions): Promise<{ response: number }>;
}

export interface RouteFailurePrompt {
  kind: RouteFailureKind;
  failedUrl: string;
  attempt: number;
}

// Shows the route-failure dialog with exactly three bilingual actions and
// maps the clicked button to the recovery action. Any out-of-range response
// (dismissed dialog, unexpected index) maps to "support" so the user always
// lands on a documented next step instead of a dead end.
export async function showRouteFailureDialog(
  presenter: DialogPresenter,
  prompt: RouteFailurePrompt,
): Promise<RouteFailureAction> {
  const content = routeFailureDialog(prompt.kind);
  const result = await presenter.showMessageBox({
    title: content.title,
    message: `${content.message}\n\n${prompt.failedUrl}`,
    detail: content.detail,
    buttons: [...content.buttons],
    defaultId: 0,
    cancelId: 2,
  });
  if (result.response === 0) {
    return "retry";
  }
  if (result.response === 1) {
    return "open-browser";
  }
  return "support";
}
