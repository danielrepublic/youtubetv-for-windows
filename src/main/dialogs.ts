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
