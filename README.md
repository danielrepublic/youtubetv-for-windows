# youtubetv-for-windows

Watch YouTube TV (`https://www.youtube.com/tv`) in a fullscreen Windows app.

- [繁體中文](#繁體中文)：給使用者的中文說明。
- [English](#english)：owner guide in English.

---

## 繁體中文

### 這個程式是什麼

`youtubetv-for-windows` 是一個非官方的 Windows 程式。它用一個獨立視窗開啟真正的 YouTube TV 網頁，包含你的帳號、品牌、廣告與操作介面。程式本身不改動影片、不擋廣告，也不提供自己的電視介面。

請先讀下一節的聲明，再決定要不要安裝。

### 非官方聲明與風險

- 這個程式不是官方產品。它和 YouTube 或 Google 沒有任何關係，也沒有得到它們的認可或支援。
- 這個程式沒有服務保證（no SLA）。YouTube 隨時可能改變或封鎖這類存取，到時程式可能部分或完全不能用。
- 這個程式用一組固定的電視裝置識別（PS4 Leanback 使用者代理字串）來請求電視版頁面。這是一種裝置偽裝（device spoofing），存在風險：YouTube 可能隨時不再接受它。這裡是把它當成風險告訴你，而不是功能保證。
- 說白了：This app is not official. There is no guarantee that sign-in, phone pairing, or 4K will keep working. 資料一旦刪掉就回不來（There is no rollback for your data），重新安裝也不會找回來。

### 系統需求

- 64 位元 Windows 10 或 Windows 11（僅 x64，不支援 x86 與 ARM64）。
- 一般使用者帳號即可，不需要系統管理員權限，安裝時不會跳出 UAC。
- 看 4K 需要另外的條件，見「4K 播放條件」。

### 下載：只要認一個安裝檔

官方下載位置只有一個：

```text
https://github.com/danielrepublic/youtubetv-for-windows/releases/latest
```

在該頁面的資產清單中，只認這個名稱格式的檔案：

```text
youtubetv-for-windows-<版本>-x64.exe
```

例如 `youtubetv-for-windows-0.1.0-x64.exe`。這是唯一要執行的檔案，其他東西都不用理會。不要從其他網站、網盤或別人傳給你的檔案安裝。

### 安裝

1. 從上面的發佈頁下載 `youtubetv-for-windows-<版本>-x64.exe`。
2. 雙擊執行。此時可能先跳出 SmartScreen 警告，處理方式見下一節。
3. 依照安裝精靈完成安裝。安裝是「只給目前使用者」的，不需要管理員權限。
4. 完成後從開始功能表的 `youtubetv-for-windows` 捷徑啟動（安裝程式也可能提供桌面捷徑與完成後直接啟動的選項）。

### SmartScreen 警告

安裝檔沒有經過微軟的程式碼簽署，所以 Windows SmartScreen 一定會跳出警告，說發行者不明。這是正常的，不代表檔案有毒，但你應該謹慎：

1. 在警告視窗上點「其他資訊」，確認你是要執行剛才從發佈頁下載的那個檔案。
2. 只有在檔案確實來自上面的發佈頁、且你接受「非官方、無保證」的風險時，才點「仍要執行」。
3. 永遠不要為了安裝而去關閉 SmartScreen 或 Defender。叫你關掉安全功能才能裝的來源不可信。

### 第一次啟動與全螢幕

- 程式一開啟就是全螢幕，直接進入 YouTube TV 頁面。
- 按 `F11` 可以切換全螢幕與視窗模式。
- `Esc` 鍵程式不會攔截，它屬於 YouTube 自己的操作（例如關閉選單）。
- 用一般的視窗按鈕或 `Alt+F4` 關閉程式。

### 登入

- 用 YouTube TV 裡的「登入」入口登入。登入頁會在程式自己的子視窗中開啟（`accounts.google.com` / `accounts.youtube.com`），和主視窗共用同一個登入狀態。
- 你可能需要準備好帳號密碼，以及手機上的兩步驟驗證。
- 登入狀態保存在你電腦上的設定檔裡（見「你的資料存在哪裡」），完全關掉程式再重開，應該仍保持登入。
- 程式不會碰你的密碼，也不會把帳號資料傳到任何別的地方。登入只發生在 Google/YouTube 自己的頁面上。
- 老實說：登入能不能成功要看 Google/YouTube 臉色，不保證一定能用。

### 手機配對

- 電腦和手機必須連上同一個 Wi-Fi。
- 在手機的 YouTube App 裡用「在電視上播放」或遙控器功能，找到這台電腦並連線，就能用手機控制播放。
- 配對結果同樣不保證，網路環境或 YouTube 改版都可能影響它。

### 4K 播放條件

同時符合以下條件時，才可能看到 2160p：

1. 螢幕本身支援 `3840x2160` 解析度。
2. 網路速度達到 25 Mbps 或更快。
3. 播放的影片本身提供 4K 畫質。
4. 在播放器「Stats for nerds」中，目前解析度顯示 `3840x2160` / `2160p`。

即使全部符合，YouTube 仍可能因為帳號、網路或裝置識別而降畫質。4K 從來不是保證，有一就有，沒有也正常。

### 發生問題時的處理

| 狀況                                     | 怎麼做                                                                                                     |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 「YouTube TV 無法載入 / failed to load」 | 先按「重試 (Retry)」。網路沒問題但一直失敗，可選「在瀏覽器中開啟 (Open in browser)」或「支援 (Support)」。 |
| 設定檔損壞的提示                         | 程式會改用暫時設定檔啟動，這次的登入不會保留。檢查磁碟權限後重新啟動即可恢復。                             |

### 換新版本

換新版本只有一條路，就是手動下載：

1. 到 `https://github.com/danielrepublic/youtubetv-for-windows/releases/latest` 下載最新的 `youtubetv-for-windows-<版本>-x64.exe`。
2. 直接執行安裝。重新安裝不會刪掉你的設定檔，登入狀態會保留。

### 解除安裝會刪掉什麼

- 用 Windows 的「設定 → 應用程式」或控制台移除程式。
- 解除安裝會刪掉程式本身，以及你電腦上的所有相關資料：登入狀態與瀏覽設定檔（`%LOCALAPPDATA%\youtubetv-for-windows\profile`）、快取，以及漫遊設定（`%APPDATA%\youtubetv-for-windows`）。刪掉就是真的刪掉，登入要重來。
- 重新安裝不會動到設定檔，只有解除安裝會清除。

### 你的資料存在哪裡

- 設定檔：`%LOCALAPPDATA%\youtubetv-for-windows\profile`（Cookie、快取、登入狀態）。
- 完整說明見 [`docs/privacy.md`](docs/privacy.md)。

### 支援

這個專案沒有客服，也沒有官方支援管道。回報問題或找最新消息，請到發佈頁：

```text
https://github.com/danielrepublic/youtubetv-for-windows/releases/latest
```

---

## English

### What this is

`youtubetv-for-windows` is an unofficial Windows app. It opens the real YouTube TV page in its own fullscreen window, with your account, branding, ads, and controls. The app doesn't modify playback, block ads, or ship its own TV interface.

Please read the disclosure below before you install.

### Unofficial status and risks

- This app is not official. It is not affiliated with, endorsed by, or supported by YouTube or Google.
- There is no SLA. YouTube can change or block this kind of access at any time, and the app may then partly or fully stop working.
- The app requests the TV page with a fixed TV device identity (a PS4 Leanback user-agent string). That's device spoofing, and it's a risk, not a feature: YouTube may stop accepting it whenever it wants.
- In plain words: This app is not official. There is no guarantee that sign-in, phone pairing, or 4K will keep working. There is also no rollback for your data: once it is deleted, reinstalling does not bring it back.

### Requirements

- 64-bit Windows 10 or Windows 11 (x64 only; x86 and ARM64 are not supported).
- A standard user account is enough. You don't need admin rights, and you won't see a UAC prompt.
- 4K needs extra conditions; see "4K playback" below.

### Download: trust exactly one installer

There is exactly one download location:

```text
https://github.com/danielrepublic/youtubetv-for-windows/releases/latest
```

On that page, only trust the asset named like this:

```text
youtubetv-for-windows-<version>-x64.exe
```

For example `youtubetv-for-windows-0.1.0-x64.exe`. That is the only file to run; nothing else there needs your attention. Don't install files from other sites, drives, or copies someone sent you.

### Install

1. Download `youtubetv-for-windows-<version>-x64.exe` from the release page above.
2. Double-click it. SmartScreen will likely warn you first; the next section covers that.
3. Follow the installer. It's per-user for the current account, and it never needs admin rights.
4. Launch it from the `youtubetv-for-windows` Start-menu shortcut (the installer may also offer a desktop shortcut and a launch-after-finish option).

### About the SmartScreen warning

The installer is unsigned, so Windows SmartScreen will warn about an unknown publisher. That's expected, and it doesn't mean the file is harmful, but stay careful:

1. Click "More info" and confirm it's the file you just downloaded from the release page.
2. Click "Run anyway" only if the file truly came from that page and you accept the unofficial, no-guarantee posture.
3. Never turn off SmartScreen or Defender to install. Any source that asks you to disable security can't be trusted.

### First launch and fullscreen

- The app starts fullscreen, straight into the YouTube TV page.
- Press `F11` to toggle between fullscreen and windowed mode.
- The app never intercepts `Esc`; that key belongs to YouTube itself (for closing menus, for example).
- Quit with the normal window buttons or `Alt+F4`.

### Sign-in

- Sign in through YouTube TV's own Sign in entry point. The sign-in page opens in an app-owned child window (`accounts.google.com` / `accounts.youtube.com`) that shares the session with the main window.
- Keep your password and your phone for two-factor challenges handy.
- Sign-in state lives in the profile on your PC (see "Where your data lives"). Fully quitting and relaunching should keep you signed in.
- The app never touches your password and never sends account data anywhere else. Sign-in happens only on Google/YouTube pages.
- Honestly: whether sign-in works is up to Google/YouTube, and it's not guaranteed.

### Phone pairing

- The PC and the phone must sit on the same Wi-Fi network.
- In the phone's YouTube app, use "Play on TV" (or the remote flow) to find this PC, connect, and control playback from the phone.
- Pairing isn't guaranteed either; your network or a YouTube change can break it.

### 4K playback

You may see 2160p only when all of these hold at once:

1. The display itself supports `3840x2160`.
2. The network measures 25 Mbps or faster.
3. The video itself offers a 4K quality.
4. The player's Stats for nerds shows a current resolution of `3840x2160` / `2160p`.

Even then, YouTube may drop quality because of the account, the network, or the device identity. 4K is never guaranteed; enjoy it when it's there.

### When something goes wrong

| Symptom                                | What to do                                                                                                                     |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| "YouTube TV 無法載入 / failed to load" | Try "重試 (Retry)" first. If it keeps failing with a fine network, use "在瀏覽器中開啟 (Open in browser)" or "支援 (Support)". |
| A profile-corruption notice            | The app starts with a temporary profile instead, and sign-in won't persist this time. Check disk permissions and restart.      |

### Getting a new version

There is only one way to get a new version, and it's a manual download:

1. Go to `https://github.com/danielrepublic/youtubetv-for-windows/releases/latest` and grab the newest `youtubetv-for-windows-<version>-x64.exe`.
2. Run it. Reinstalling keeps your profile, so sign-in state survives.

### What uninstall removes

- Remove the app through Windows Settings (Apps) or Control Panel.
- Uninstall deletes the app plus all of its per-user data on your PC: sign-in state and browser profile (`%LOCALAPPDATA%\youtubetv-for-windows\profile`), caches, and roaming settings (`%APPDATA%\youtubetv-for-windows`). Once it's gone, you'll sign in from scratch.
- Reinstalls keep the profile. Only uninstall wipes it.

### Where your data lives

- Profile: `%LOCALAPPDATA%\youtubetv-for-windows\profile` (cookies, cache, sign-in state).
- The full statement is [`docs/privacy.md`](docs/privacy.md).

### Support

There's no help desk and no official support channel. For issues or news, go to the release page:

```text
https://github.com/danielrepublic/youtubetv-for-windows/releases/latest
```
