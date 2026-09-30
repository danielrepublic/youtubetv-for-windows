// Test-only in-process stand-in for the `electron` module.
//
// A resolution hook (see secure-host.test.mjs) points the bare specifier
// "electron" at this file so the REAL production entry, src/main/index.ts,
// can be imported and driven on plain Node, with no Chromium runtime and no
// spawned process.
//
// It exists to observe exactly one thing no other suite can: the ORDER in
// which the entry redirects sessionData/userData, awaits the ready gate,
// opens the first session, and creates the first window. Every observable step
// is appended to a shared recorder, and whenReady() stays PENDING until the
// test releases it, so "the redirect preceded ready" is decided by observation
// rather than by reading the source.
//
// Not a suite file (no .test.mjs suffix), so the chain runner ignores it.

const recorder = globalThis.__ytvwStartupOrder;

// Electron's compiled-in Windows defaults: userData is appData + the product
// name. The recording is what proves the entry replaces BOTH of these with the
// ProgramData tree before anything downstream can read them.
const DEFAULT_APP_DATA = "C:\\Users\\probe-user\\AppData\\Roaming";
const DEFAULT_PRODUCT_DATA = `${DEFAULT_APP_DATA}\\youtubetv-for-windows`;

const paths = {
  appData: DEFAULT_APP_DATA,
  userData: DEFAULT_PRODUCT_DATA,
  sessionData: DEFAULT_PRODUCT_DATA,
};

function record(event) {
  recorder.events.push(event);
}

export const app = {
  getAppPath() {
    return "C:\\probe-app-root";
  },
  getPath(name) {
    record(`getPath:${name}`);
    return paths[name];
  },
  setPath(name, value) {
    record(`setPath:${name}`);
    paths[name] = value;
  },
  whenReady() {
    record("whenReady-called");
    return recorder.readyPromise.then(() => {
      record("ready-resolved");
    });
  },
  on() {
    return app;
  },
  quit() {},
};

export class BrowserWindow {
  constructor(options) {
    record("window-created");
    this.options = options;
    this.fullscreen = options.fullscreen === true;
    this.currentUrl = "";
    this.windowOpenHandler = null;
    this.webContents = {
      on: () => undefined,
      getURL: () => this.currentUrl,
      loadURL: async (url) => {
        this.currentUrl = url;
      },
      setWindowOpenHandler: (handler) => {
        this.windowOpenHandler = handler;
      },
    };
  }

  async loadURL(url) {
    this.currentUrl = url;
  }

  setFullScreen(value) {
    this.fullscreen = value;
  }

  isFullScreen() {
    return this.fullscreen;
  }
}

export const session = {
  fromPartition(partition) {
    record(`session.fromPartition:${partition}`);
    return {
      setUserAgent() {},
      webRequest: {
        onBeforeSendHeaders() {},
      },
    };
  },
};

export const dialog = {
  showMessageBox: async () => {
    record("dialog.showMessageBox");
    return { response: 0 };
  },
};

export const shell = {
  openExternal: async () => {
    record("shell.openExternal");
  },
};

export const __paths = paths;
export const __defaults = {
  appData: DEFAULT_APP_DATA,
  userData: DEFAULT_PRODUCT_DATA,
  sessionData: DEFAULT_PRODUCT_DATA,
};
