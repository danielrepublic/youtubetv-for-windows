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
- 這個程式用一組固定的電視裝置識別（PS4 Leanback with Cobalt 使用者代理字串）來請求電視版頁面。這是一種裝置偽裝（device spoofing），存在風險：YouTube 可能隨時不再接受它。這裡是把它當成風險告訴你，而不是功能保證。
- 說白了：This app is not official. There is no guarantee that sign-in, phone pairing, or 4K will keep working. 資料一旦刪掉就回不來（There is no rollback for your data），重新安裝也不會找回來。

### 系統需求

- 64 位元 Windows 10 或 Windows 11（僅 x64，不支援 x86 與 ARM64）。
- 安裝與解除安裝需要系統管理員權限。Windows 會跳出「使用者帳戶控制」（UAC）提示，請按「是」。安裝完成後，程式本身以一般使用者的身分啟動，不會再要求提權。
- 這是整台電腦共用的安裝，程式本體放在 `C:\Program Files\youtubetv-for-windows`。同一台電腦上的每個 Windows 使用者共用這個資料夾，但各有自己的設定與登入資料（見「你的資料存在哪裡」）。
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

例如 `youtubetv-for-windows-0.2.0-x64.exe`。這是唯一要執行的檔案，其他東西都不用理會。不要從其他網站、網盤或別人傳給你的檔案安裝。

### 安裝

1. 從上面的發佈頁下載 `youtubetv-for-windows-<版本>-x64.exe`。
2. 雙擊執行。此時可能先跳出 SmartScreen 警告，處理方式見「SmartScreen 警告」。
3. UAC 提示按「是」。這個提示不能略過：安裝程式要寫入 `C:\Program Files\youtubetv-for-windows` 與 `C:\ProgramData\youtubetv-for-windows`，兩者都是整台電腦共用的系統位置，只有系統管理員寫得進去。
4. 依照安裝精靈完成安裝。程式會裝到 `C:\Program Files\youtubetv-for-windows`，這台電腦上的每個 Windows 使用者都裝同一份。
5. 完成後從開始功能表的 `youtubetv-for-windows` 捷徑啟動（安裝程式會問你要不要在桌面也建立捷徑，並提供完成後直接啟動的選項）。

這台電腦已經裝過這個程式的話，安裝程式會先問你要怎麼辦，見「已經安裝過：重新安裝、解除安裝或取消」。

### 已經安裝過：重新安裝、解除安裝或取消

安裝程式偵測到這台電腦上已經有這個程式時，會跳出一個選單畫面。標題和下面三個選項都是安裝程式裡寫死的字串，中英文並排顯示：

```text
youtubetv-for-windows 已安裝 / Already installed
```

- **重新安裝（保留你的設定與登入狀態）**
  Reinstall (keep your settings and sign-in)
  資料結果：你的設定與登入狀態原封不動地留下，只有程式檔案換成新版本。這是預設選項。
- **解除安裝並刪除所有資料**
  Uninstall and delete all data
  資料結果：程式本身與 `C:\ProgramData\youtubetv-for-windows` 整棵資料樹都會被刪掉，包含你的設定與登入狀態。下次裝回來要重新登入。
- **取消**
  Cancel
  資料結果：什麼都不動。設定、登入狀態和已安裝的程式保持原樣，安裝程式直接結束。

安裝程式也把更早期「只給單一帳號」版本留下的檔案算成已安裝，同樣跳這個畫面。那個舊版本請用 Windows 的「設定 → 應用程式」移除；解除安裝程式不會搬走、也不會刪掉舊版本留在你個人資料夾裡的資料，見「你的資料存在哪裡」。

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
| UAC 提示按了「否」或安裝失敗             | 沒有系統管理員權限就寫不進 `C:\Program Files`。請改用有權限的帳號，或請管理員代為安裝。                    |

### 換新版本

換新版本只有一條路，就是手動下載：

1. 到 `https://github.com/danielrepublic/youtubetv-for-windows/releases/latest` 下載最新的 `youtubetv-for-windows-<版本>-x64.exe`。
2. 執行它。已經裝過的話，安裝程式會先問你要「重新安裝」還是「解除安裝」，見「已經安裝過：重新安裝、解除安裝或取消」。

只要選「重新安裝」，安裝程式本身不會刪除或改動 `C:\ProgramData\youtubetv-for-windows` 整棵資料樹裡的任何資料，你的設定檔與登入狀態都會原樣留著。安裝結束後如果程式被啟動，那是程式自己在跑，它會改寫自己的 Chromium 快取檔；那是程式的正常行為，不是安裝程式刪了資料。

### 解除安裝會刪掉什麼

- 用 Windows 的「設定 → 應用程式」或控制台移除程式；也可以重跑安裝檔，在選單裡選「解除安裝並刪除所有資料」。兩種做法都會跳出 UAC，解除安裝同樣需要系統管理員權限。
- 解除安裝會刪掉兩整塊：安裝資料夾 `C:\Program Files\youtubetv-for-windows`（程式本身），以及資料根目錄 `C:\ProgramData\youtubetv-for-windows` 底下的整棵樹，也就是這台電腦上所有 Windows 使用者的設定檔與使用者資料。
- 你的設定檔在 `%PROGRAMDATA%\youtubetv-for-windows\users\<key>\profile`（Cookie、快取、登入狀態），使用者資料在 `%PROGRAMDATA%\youtubetv-for-windows\users\<key>\userdata`。刪掉就是真的刪掉，沒有任何復原（no rollback），下次裝回來要重新登入。
- 唯一的例外是換版本：安裝程式在覆蓋舊版本時，會叫解除安裝程式保留資料再裝新的，那一輪資料會留下來。只有你自己發起的解除安裝會刪資料。
- 還有一個舊版本留下來的目錄不會被刪掉：`%APPDATA%\youtubetv-for-windows`（在你的個人資料夾裡）。早期版本留在裡面的只有顯示用的快取（GPU 與 shader 快取）和一份本機狀態檔，沒有 Cookie、密碼、觀看紀錄或登入狀態。現在的版本啟動時就把資料路徑轉到 `%PROGRAMDATA%`，所以平常這個目錄只會留著早期版本留下的那些檔案。只有「你的資料存在哪裡」那一節說的例外一發生時，它才會變成這個程式的資料根目錄，那時裡面才會有一整棵 `users\<key>` 的設定檔與登入狀態。解除安裝不會刪掉它，想清掉的話直接刪掉整個資料夾就好。
- 重新安裝不會動到設定檔，只有解除安裝會清除。

### 你的資料存在哪裡

資料放在整台電腦共用的資料根目錄 `C:\ProgramData\youtubetv-for-windows`（環境變數寫法是 `%PROGRAMDATA%\youtubetv-for-windows`），底下每個 Windows 使用者一個自己的資料夾：

- 你的資料夾：`%PROGRAMDATA%\youtubetv-for-windows\users\<key>`。`<key>` 是你 Windows 帳號名稱去掉不合法字元後的名字。
- 設定檔：`%PROGRAMDATA%\youtubetv-for-windows\users\<key>\profile`（Cookie、快取、登入狀態）。
- 使用者資料：`%PROGRAMDATA%\youtubetv-for-windows\users\<key>\userdata`（Electron 的快取與設定）。
- 診斷紀錄（預設關閉）：`%PROGRAMDATA%\youtubetv-for-windows\users\<key>\diagnostics`。

放在這裡有兩個好處：每個 Windows 使用者各有自己的子資料夾，兩個人不會共用同一份登入狀態；資料根目錄不在你的個人資料夾裡，所以換帳號或重灌系統時比較容易整棵一起處理。`C:\ProgramData` 預設只有系統管理員寫得進去，所以安裝程式會把這個資料根目錄的權限開放給本機的 Users 群組。

平常啟動時，上面列的整棵資料樹就是全部的落點：設定檔、使用者資料與診斷紀錄都寫在 `%PROGRAMDATA%\youtubetv-for-windows` 底下，`%APPDATA%` 與 `%LOCALAPPDATA%` 都不會被寫入（見「解除安裝會刪掉什麼」）。程式有兩個例外，什麼時候會用到由程式自己判斷：

- 例外一：`%PROGRAMDATA%` 沒有值或是空字串的時候，資料根目錄退到 `%APPDATA%\youtubetv-for-windows\users\<key>`。一樣每個使用者一個子資料夾，這一次的設定檔與使用者資料就寫在你的個人資料夾裡。
- 例外二：資料根目錄不能建立或不能使用（權限不足、磁碟滿、路徑被別的檔案佔掉）的時候，程式會改用 Windows 暫存資料夾 `%LOCALAPPDATA%\Temp` 底下的一個全新目錄（名稱是 `youtubetv-for-windows-profile-` 開頭，後面接一段隨機字元），啟動時會跳一個視窗告訴你資料改放在哪裡。這一次開啟的登入狀態不會保留，下次啟動會是一個全新的設定檔。

這兩個例外用的目錄，解除安裝都不會刪掉。手動刪掉是安全的，程式下次啟動會自己重新建立需要的部分。

資料根目錄是搬過來的，這點要說清楚：早期版本是「只給單一帳號」的安裝，資料放在你的個人資料夾，當年的說明寫的是 `%LOCALAPPDATA%\youtubetv-for-windows\profile`。舊資料不會被自動搬到新位置，程式也不會去讀它，所以你在舊位置的設定與登入狀態等於要重來一次。舊檔案要你自己刪，解除安裝也不會刪到那裡。

完整說明見 [`docs/privacy.md`](docs/privacy.md)。

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
- The app requests the TV page with a fixed TV device identity (a PS4 Leanback with Cobalt user-agent string). That's device spoofing, and it's a risk, not a feature: YouTube may stop accepting it whenever it wants.
- In plain words: This app is not official. There is no guarantee that sign-in, phone pairing, or 4K will keep working. There is also no rollback for your data: once it is deleted, reinstalling does not bring it back.

### Requirements

- 64-bit Windows 10 or Windows 11 (x64 only; x86 and ARM64 are not supported).
- Installing and uninstalling needs administrator rights. Windows shows a User Account Control (UAC) prompt; answer yes. Once installed, the app itself launches as a standard user and never asks to elevate again.
- This is a machine-wide install. The program files go to `C:\Program Files\youtubetv-for-windows`, shared by every Windows user on the PC, while each user keeps a separate settings and sign-in store (see "Where your data lives").
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

For example `youtubetv-for-windows-0.2.0-x64.exe`. That is the only file to run; nothing else there needs your attention. Don't install files from other sites, drives, or copies someone sent you.

### Install

1. Download `youtubetv-for-windows-<version>-x64.exe` from the release page above.
2. Double-click it. SmartScreen will likely warn you first; the next section covers that.
3. Answer yes at the UAC prompt. It can't be skipped: the installer writes to `C:\Program Files\youtubetv-for-windows` and `C:\ProgramData\youtubetv-for-windows`, two machine-wide system locations that a standard account cannot write to.
4. Follow the installer. It installs to `C:\Program Files\youtubetv-for-windows`, one copy for every Windows user on this PC.
5. Launch it from the `youtubetv-for-windows` Start-menu shortcut (the installer asks whether to also create a desktop shortcut, and offers a launch-after-finish option).

If the app is already on this PC, the installer asks what to do first; see "Already installed: reinstall, uninstall, or cancel".

### Already installed: reinstall, uninstall, or cancel

When the installer finds the app already on this PC, it shows a chooser. The title and the three options below are fixed strings inside the installer, and the page shows both languages side by side:

```text
youtubetv-for-windows 已安裝 / Already installed
```

- **重新安裝（保留你的設定與登入狀態）**
  Reinstall (keep your settings and sign-in)
  Data result: your settings and sign-in state stay exactly as they are, and only the program files change to the new version. This is the default option.
- **解除安裝並刪除所有資料**
  Uninstall and delete all data
  Data result: the app itself and the whole `C:\ProgramData\youtubetv-for-windows` tree are deleted, including your settings and sign-in state. Installing it again later means signing in again.
- **取消**
  Cancel
  Data result: nothing changes. Your settings, your sign-in state, and the installed app stay as they are, and the installer exits.

The installer also counts the files left by an older single-account release as installed and shows the same page. Remove that old copy through Windows Settings (Apps); the uninstaller neither moves nor deletes the data it left in your user profile folder. See "Where your data lives".

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

| Symptom                                | What to do                                                                                                                                                                         |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "YouTube TV 無法載入 / failed to load" | Try "重試 (Retry)" first. If it keeps failing with a fine network, use "在瀏覽器中開啟 (Open in browser)" or "支援 (Support)".                                                     |
| A profile-corruption notice            | The app starts with a temporary profile instead, and sign-in won't persist this time. Check disk permissions and restart.                                                          |
| UAC says no, or the install fails      | A standard account cannot write to `C:\Program Files`, so the install stops right there. Use an account that has administrator rights, or ask an administrator to install for you. |

### Getting a new version

There is only one way to get a new version, and it's a manual download:

1. Go to `https://github.com/danielrepublic/youtubetv-for-windows/releases/latest` and grab the newest `youtubetv-for-windows-<version>-x64.exe`.
2. Run it. If the app is already installed, the installer asks whether to reinstall or uninstall first; see "Already installed: reinstall, uninstall, or cancel".

As long as you pick "Reinstall", the installer itself deletes nothing in and changes no data anywhere under the `C:\ProgramData\youtubetv-for-windows` tree, and your settings and sign-in state survive it unchanged. If the app is launched afterwards, it rewrites its own Chromium cache files; that is the app's normal behaviour, not the installer deleting anything.

### What uninstall removes

- Remove the app through Windows Settings (Apps) or Control Panel, or run the installer again and choose "Uninstall and delete all data". Both ways raise a UAC prompt: uninstalling needs administrator rights too.
- Uninstall deletes two whole trees: the install directory `C:\Program Files\youtubetv-for-windows` (the app itself), and everything under the data root `C:\ProgramData\youtubetv-for-windows`, which is the settings and user data of every Windows user on this PC.
- Your profile is at `%PROGRAMDATA%\youtubetv-for-windows\users\<key>\profile` (cookies, cache, sign-in state) and your user data at `%PROGRAMDATA%\youtubetv-for-windows\users\<key>\userdata`. Once deleted, they are gone: there is no rollback, and installing the app again means signing in from scratch.
- The one exception is a version change. When the installer replaces an older version it runs the uninstaller with an instruction to keep the data, so that pass leaves your data alone. Only an uninstall you start yourself deletes the data.
- One folder from older builds is not removed: `%APPDATA%\youtubetv-for-windows`, inside your user profile folder. What earlier builds left in it is only graphics caches (GPU and shader caches) and one local-state file, with no cookies, no passwords, no watch history, and no sign-in state. The current build redirects its data paths to `%PROGRAMDATA%` at startup, so normally nothing new is written into that folder. It becomes this app's data root only in the first exception described under "Where your data lives", and only then does it hold a full `users\<key>` tree with your profile and sign-in state. Uninstalling does not delete it, and deleting the folder by hand is safe.
- Reinstalls keep the profile. Only uninstall wipes it.

### Where your data lives

Your data lives under the machine-wide data root `C:\ProgramData\youtubetv-for-windows` (spelled `%PROGRAMDATA%\youtubetv-for-windows` in environment variables), with one directory per Windows user:

- Your own directory: `%PROGRAMDATA%\youtubetv-for-windows\users\<key>`, where `<key>` is your Windows account name with illegal characters replaced.
- Profile: `%PROGRAMDATA%\youtubetv-for-windows\users\<key>\profile` (cookies, cache, sign-in state).
- User data: `%PROGRAMDATA%\youtubetv-for-windows\users\<key>\userdata` (Electron's caches and settings).
- Diagnostics (off by default): `%PROGRAMDATA%\youtubetv-for-windows\users\<key>\diagnostics`.

Two reasons it sits there. Each Windows user gets their own subdirectory, so two people on one PC never share a sign-in state. And the data root is not inside your user profile folder, which makes it easier to handle as one tree when you change accounts or reinstall Windows. `C:\ProgramData` normally allows writes for administrators only, so the installer grants the local Users group access to that data root.

On a normal start, the whole tree listed above is the only place anything is written: the profile, the user data and the diagnostic logs all go under `%PROGRAMDATA%\youtubetv-for-windows`, and neither `%APPDATA%` nor `%LOCALAPPDATA%` is written to (see "What uninstall removes"). The app has two exceptions, and it decides for itself when each one applies:

- Exception one: when `%PROGRAMDATA%` has no value or is an empty string, the data root falls back to `%APPDATA%\youtubetv-for-windows\users\<key>`. Each user still gets their own subdirectory, but this time the profile and the user data are written inside your user profile folder.
- Exception two: when the data root cannot be created or used (not enough permissions, a full disk, a path taken by some other file), the app starts with a temporary profile in a brand-new directory under the Windows temp folder `%LOCALAPPDATA%\Temp` (named `youtubetv-for-windows-profile-` followed by a run of random characters) and shows you a window saying where the data went. Sign-in state does not persist for that start; the next start is a fresh profile.

Uninstall does not delete either of those fallback locations. Deleting either one by hand is safe, because the app recreates what it needs on the next start.

The data root moved, and that is worth stating plainly. Earlier releases were a single-account install and kept their data in your user profile folder; the README of the time pointed at `%LOCALAPPDATA%\youtubetv-for-windows\profile`. Nothing copies that old data to the new location and nothing reads it there, so settings and sign-in state you had in the old place have to be set up and signed in again. The old files are yours to delete, and uninstalling does not touch them.

The full statement is [`docs/privacy.md`](docs/privacy.md).

### Support

There's no help desk and no official support channel. For issues or news, go to the release page:

```text
https://github.com/danielrepublic/youtubetv-for-windows/releases/latest
```
