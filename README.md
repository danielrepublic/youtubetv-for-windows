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
- 說白了：This app is not official. There is no guarantee that sign-in, phone pairing, or 4K will keep working. There is no rollback once an update hands off to the installer.

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

例如 `youtubetv-for-windows-0.1.0-x64.exe`。除了這個安裝檔之外，頁面上可能還有 `.blockmap`、`latest.yml` 這類附加檔案，它們是給更新機制用的，你不需要碰。不要從其他網站、網盤或別人傳給你的檔案安裝。

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

### 更新

- 每次啟動時，程式會先到發佈頁檢查有沒有新版本。檢查失敗（沒網路、逾時）不影響使用，會直接啟動目前已安裝的版本。
- 如果新版本下載或驗證失敗，會跳出「更新失敗 / Update failed」視窗，並照常用目前版本啟動。你可以之後從發佈頁手動下載。
- 如果更新已經交給安裝程式、但安裝結果無法確認，會在下次啟動時顯示「更新回復指引 / Update recovery guidance」，請照上面的指示手動重新下載安裝。
- 這個程式沒有自動回復功能（There is no automatic rollback）。安裝一旦開始，就沒有「一鍵回到舊版」。
- 實際看到的文字和程式內建對話框一字相同：

```text
更新下載或驗證失敗，將以目前已安裝的版本啟動。你仍可從下方網址手動下載最新的安裝檔。
The update could not be downloaded or verified, so the installed version will start. You can still download the latest installer manually from the link below.
已驗證的更新程式無法啟動，將以目前已安裝的版本啟動。你仍可從下方網址手動下載最新的安裝檔。
The verified update installer could not be started, so the installed version will start. You can still download the latest installer manually from the link below.
更新後的首次啟動找不到完成標記，無法確認此次安裝成功。此程式沒有自動回復功能，請以手動方式重新下載並安裝最新版本。
The completed-install marker was not found after the update, so this installation cannot be confirmed. There is no automatic rollback; download and install the latest version manually.
更新完成標記無效，無法確認此次安裝成功。此程式沒有自動回復功能，請以手動方式重新下載並安裝最新版本。
The completed-install marker is invalid, so this installation cannot be confirmed. There is no automatic rollback; download and install the latest version manually.
上次的更新在安裝階段未能完成，無法確認是否已套用。此程式沒有自動回復功能，請以手動方式重新下載並安裝最新版本。
The previous update did not finish installing, so it cannot be confirmed whether it was applied. There is no automatic rollback; download and install the latest version manually.
```

- 誠實補充：簽章驗證用的正式金鑰還沒佈署，所以自動更新目前還不會真正生效。在那之前，請把發佈頁的手動下載當成唯一的更新方式。

### 發生問題時的處理

| 狀況                                        | 怎麼做                                                                                                     |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 「YouTube TV 無法載入 / failed to load」    | 先按「重試 (Retry)」。網路沒問題但一直失敗，可選「在瀏覽器中開啟 (Open in browser)」或「支援 (Support)」。 |
| 「更新失敗 / Update failed」                | 按「開啟下載頁面 (Open download page)」手動下載，或按「確定 (OK)」先用目前版本。                           |
| 「更新回復指引 / Update recovery guidance」 | 安裝結果無法確認，也沒有自動回復。請手動重新下載並安裝最新版本。                                           |
| 設定檔損壞的提示                            | 程式會改用暫時設定檔啟動，這次的登入不會保留。檢查磁碟權限後重新啟動即可恢復。                             |

### 手動下載修復

任何時候覺得更新壞了，最可靠的修復就是：

1. 到 `https://github.com/danielrepublic/youtubetv-for-windows/releases/latest` 下載最新的 `youtubetv-for-windows-<版本>-x64.exe`。
2. 直接執行安裝。重新安裝不會刪掉你的設定檔，登入狀態會保留。

### 解除安裝會刪掉什麼

- 用 Windows 的「設定 → 應用程式」或控制台移除程式。
- 解除安裝會刪掉程式本身，以及你電腦上的所有相關資料：登入狀態與瀏覽設定檔（`%LOCALAPPDATA%\youtubetv-for-windows\profile`）、快取，以及漫遊設定（`%APPDATA%\youtubetv-for-windows`）。刪掉就是真的刪掉，登入要重來。
- 更新或重新安裝不會動到設定檔，只有解除安裝會清除。

### 你的資料存在哪裡

- 設定檔：`%LOCALAPPDATA%\youtubetv-for-windows\profile`（Cookie、快取、登入狀態）。
- 更新暫存：`%LOCALAPPDATA%\youtubetv-for-windows\updates` 與 `update-status`（安裝檔暫存與完成標記，程式自己管理）。
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
- In plain words: This app is not official. There is no guarantee that sign-in, phone pairing, or 4K will keep working. There is no rollback once an update hands off to the installer.

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

For example `youtubetv-for-windows-0.1.0-x64.exe`. The page may list extra files such as `.blockmap` or `latest.yml`; those belong to the update machinery, so leave them alone. Don't install files from other sites, drives, or copies someone sent you.

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

### Updates

- On every launch, the app checks the release page for a newer version first. If the check fails (offline, timeout), it just starts the installed version.
- If a new version can't be downloaded or verified, you'll see an "更新失敗 / Update failed" dialog, and the installed version starts as usual. You can download the release by hand later.
- If an update was handed to the installer but the result can't be confirmed, the next launch shows "更新回復指引 / Update recovery guidance". Follow it and reinstall the latest version manually.
- There is no rollback (There is no automatic rollback). Once the installer starts, there's no one-click way back to the old version.
- The exact wording matches the built-in dialogs word for word:

```text
更新下載或驗證失敗，將以目前已安裝的版本啟動。你仍可從下方網址手動下載最新的安裝檔。
The update could not be downloaded or verified, so the installed version will start. You can still download the latest installer manually from the link below.
已驗證的更新程式無法啟動，將以目前已安裝的版本啟動。你仍可從下方網址手動下載最新的安裝檔。
The verified update installer could not be started, so the installed version will start. You can still download the latest installer manually from the link below.
更新後的首次啟動找不到完成標記，無法確認此次安裝成功。此程式沒有自動回復功能，請以手動方式重新下載並安裝最新版本。
The completed-install marker was not found after the update, so this installation cannot be confirmed. There is no automatic rollback; download and install the latest version manually.
更新完成標記無效，無法確認此次安裝成功。此程式沒有自動回復功能，請以手動方式重新下載並安裝最新版本。
The completed-install marker is invalid, so this installation cannot be confirmed. There is no automatic rollback; download and install the latest version manually.
上次的更新在安裝階段未能完成，無法確認是否已套用。此程式沒有自動回復功能，請以手動方式重新下載並安裝最新版本。
The previous update did not finish installing, so it cannot be confirmed whether it was applied. There is no automatic rollback; download and install the latest version manually.
```

- One honest caveat: the production release-signing key isn't provisioned yet, so signed automatic updates can't actually verify in production. Until then, treat a manual download from the release page as the only update path.

### When something goes wrong

| Symptom                                   | What to do                                                                                                                     |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| "YouTube TV 無法載入 / failed to load"    | Try "重試 (Retry)" first. If it keeps failing with a fine network, use "在瀏覽器中開啟 (Open in browser)" or "支援 (Support)". |
| "更新失敗 / Update failed"                | Click "開啟下載頁面 (Open download page)" to fetch it manually, or "確定 (OK)" to keep the current version.                    |
| "更新回復指引 / Update recovery guidance" | The install can't be confirmed, and there is no automatic rollback. Download and install the latest version manually.          |
| A profile-corruption notice               | The app starts with a temporary profile instead, and sign-in won't persist this time. Check disk permissions and restart.      |

### Manual-download recovery

Whenever an update looks broken, the most reliable fix is:

1. Go to `https://github.com/danielrepublic/youtubetv-for-windows/releases/latest` and grab the newest `youtubetv-for-windows-<version>-x64.exe`.
2. Run it. Reinstalling keeps your profile, so sign-in state survives.

### What uninstall removes

- Remove the app through Windows Settings (Apps) or Control Panel.
- Uninstall deletes the app plus all of its per-user data on your PC: sign-in state and browser profile (`%LOCALAPPDATA%\youtubetv-for-windows\profile`), caches, and roaming settings (`%APPDATA%\youtubetv-for-windows`). Once it's gone, you'll sign in from scratch.
- Updates and reinstalls keep the profile. Only uninstall wipes it.

### Where your data lives

- Profile: `%LOCALAPPDATA%\youtubetv-for-windows\profile` (cookies, cache, sign-in state).
- Update scratch: `%LOCALAPPDATA%\youtubetv-for-windows\updates` and `update-status` (pending installers and completion markers, managed by the app).
- The full statement is [`docs/privacy.md`](docs/privacy.md).

### Support

There's no help desk and no official support channel. For issues or news, go to the release page:

```text
https://github.com/danielrepublic/youtubetv-for-windows/releases/latest
```
