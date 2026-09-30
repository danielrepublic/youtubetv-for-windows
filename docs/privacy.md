# 隱私權聲明 / Privacy statement

本文件說明 `youtubetv-for-windows` 如何處理你的資料。先說結論：這個程式是 unofficial 且 not official 的，它把資料留在你的電腦上，不會傳到開發者手裡，也沒有帳號系統。This app offers no guarantee of anything beyond what's written here, and there is no rollback for data you delete.

## 繁體中文

### 資料放在哪裡

- 資料根目錄：`C:\ProgramData\youtubetv-for-windows`（環境變數寫法是 `%PROGRAMDATA%\youtubetv-for-windows`）。這是整台電腦共用的根目錄，不是放在某個人的資料夾裡。
- 你的個人資料夾裡沒有這個程式的資料：設定檔、使用者資料與診斷紀錄全部寫在上面的 `%PROGRAMDATA%` 根目錄底下，這個程式不會寫入 `%APPDATA%` 或 `%LOCALAPPDATA%`。
- 每個 Windows 使用者一個子目錄：`%PROGRAMDATA%\youtubetv-for-windows\users\<key>`。`<key>` 由你的 Windows 帳號名稱（`%USERPROFILE%` 最後一段）把不合法字元換成底線而來。分成人各有各的子目錄，是為了讓兩個帳號不會共用同一份 Chromium 設定檔而互相破壞登入狀態。
- 這個根目錄的權限：Windows 預設只有系統管理員寫得進 `C:\ProgramData`，所以安裝程式把本機 `Users` 群組對這個資料根目錄設成可讀寫。實話說，這代表同一台電腦上的其他本機帳號在技術上也讀得到這個樹裡的檔案，這是整台電腦共用一個安裝的副作用。

### 這個程式會存什麼

- 瀏覽設定檔：`%PROGRAMDATA%\youtubetv-for-windows\users\<key>\profile`。裡面是 YouTube TV 運作需要的東西：Cookie、快取、你的登入狀態。沒有這些，登入和偏好設定就留不住。
- 使用者資料：`%PROGRAMDATA%\youtubetv-for-windows\users\<key>\userdata`（Electron 的快取與設定）。
- 診斷紀錄：只有在你親手建立以下檔案時才會產生：

```text
%PROGRAMDATA%\youtubetv-for-windows\users\<key>\diagnostics\ENABLED
```

開啟後，程式會在同目錄下寫入 `diagnostic-<時間>-p<行程>-<編號>.jsonl`。內容只有事件名稱與網域（例如 `navigation-committed` 加上 origin），不含網址路徑、查詢參數、Cookie、權杖或帳號識別。預設是關的，刪掉 `ENABLED` 就停。

### 這些資料會傳去哪裡

- 你的瀏覽行為（看什麼影片、搜什麼）只發生在你和 YouTube/Google 之間，和用瀏覽器看 YouTube 一樣。程式沒有自己的伺服器，也不會把你的資料轉寄給開發者。
- 程式不會讀取你的密碼，不會檢查你的憑證，也不會把登入狀態複製到任何別的地方。登入只發生在 Google/YouTube 自己的頁面上。

### 保存與刪除

- 設定檔沒有版本區隔，重新安裝會保留它：安裝程式在換版本時會叫解除安裝程式保留資料再裝新的。只有你自己發起的解除安裝（控制台、開始功能表，或重跑安裝檔選「解除安裝並刪除所有資料」）會刪掉整棵 `%PROGRAMDATA%\youtubetv-for-windows`，也就是這台電腦上所有 Windows 使用者的 `profile`、`userdata` 與 `diagnostics`（見 README「解除安裝會刪掉什麼」）。
- 刪掉就是真的刪掉。程式裡沒有任何備份、沒有匯出、沒有復原（no rollback），重新安裝也不會把它找回來。
- 資料根目錄是搬過來的。早期版本是「只給單一帳號」的安裝，資料放在你的個人資料夾，當年的說明寫的是 `%LOCALAPPDATA%\youtubetv-for-windows\profile`。舊資料不會被搬到 `C:\ProgramData\youtubetv-for-windows`，程式也不會去讀它，所以等於要重新設定一次、重新登入一次。舊檔案要你自己刪，解除安裝不會刪到那裡。
- 診斷紀錄不會自動刪除，你可以整個刪掉 `diagnostics` 目錄。
- 還有一個舊版本留下來的目錄不會被刪掉：`%APPDATA%\youtubetv-for-windows`（在你的個人資料夾裡）。裡面只有顯示用的快取（GPU 與 shader 快取）和一份本機狀態檔，沒有 Cookie、密碼、觀看紀錄或登入狀態。現在的版本啟動時就把資料路徑轉到 `%PROGRAMDATA%`，不會再寫入這個目錄；解除安裝也不會刪掉它，想清掉的話直接刪掉整個資料夾就好。

### 聯絡與責任

- 這個專案沒有客服。資料相關的問題請到發佈頁反映：`https://github.com/danielrepublic/youtubetv-for-windows/releases/latest`。
- YouTube/Google 那一側的資料（觀看紀錄、帳號）適用它們自己的條款，與本程式無關。

## English

### Where the data lives

- Data root: `C:\ProgramData\youtubetv-for-windows` (`%PROGRAMDATA%\youtubetv-for-windows` in environment variables). It is a machine-wide root, not something inside one person's profile folder.
- Nothing from this app lands in your user profile folder: the profile, the user data and the diagnostic logs are all written under the `%PROGRAMDATA%` root above, and the app never writes to `%APPDATA%` or `%LOCALAPPDATA%`.
- One subdirectory per Windows user: `%PROGRAMDATA%\youtubetv-for-windows\users\<key>`, where `<key>` comes from your Windows account name (the last segment of `%USERPROFILE%`) with illegal characters replaced by underscores. The per-user split exists so two accounts never share one Chromium user-data directory and corrupt each other's sign-in state.
- Who can read that root: Windows normally allows writes in `C:\ProgramData` for administrators only, so the installer grants the local `Users` group modify access to the data root. To be straight about it, that means other local accounts on the same PC can technically read the files in that tree. That is a side effect of the machine-wide install.

### What the app stores

- Browser profile: `%PROGRAMDATA%\youtubetv-for-windows\users\<key>\profile`. It holds what YouTube TV needs to work: cookies, cache, and your sign-in state. Without it, sign-in and preferences can't persist.
- User data: `%PROGRAMDATA%\youtubetv-for-windows\users\<key>\userdata` (Electron's caches and settings).
- Diagnostic logs: produced only if you create this file by hand:

```text
%PROGRAMDATA%\youtubetv-for-windows\users\<key>\diagnostics\ENABLED
```

When enabled, the app writes `diagnostic-<time>-p<pid>-<n>.jsonl` next to it. Each line carries only an event name plus an origin (for example `navigation-committed` with an origin), never URL paths, query strings, cookies, tokens, or account identifiers. It's off by default; deleting `ENABLED` stops it.

### Where that data goes

- Your viewing (what you watch or search) happens only between you and YouTube/Google, exactly like watching in a browser. The app runs no server of its own and never forwards your data to the developer.
- The app never reads your password, never inspects credentials, and never copies sign-in state anywhere else. Sign-in happens only on Google/YouTube pages.

### Retention and deletion

- The profile has no version segment, and reinstalls keep it: when the installer replaces an older version it runs the uninstaller with an instruction to keep the data. Only an uninstall you start yourself (Control Panel, the Start menu, or the installer run again with "Uninstall and delete all data") deletes the whole `%PROGRAMDATA%\youtubetv-for-windows` tree, which is the `profile`, `userdata`, and `diagnostics` of every Windows user on this PC. See "What uninstall removes" in the README.
- Deleted means deleted. The app keeps no backup, exports nothing, and offers no restore (no rollback); reinstalling does not bring it back.
- The data root moved. Earlier releases were a single-account install that kept data in your user profile folder, and the README of the time pointed at `%LOCALAPPDATA%\youtubetv-for-windows\profile`. Nothing copies that old data into `C:\ProgramData\youtubetv-for-windows` and nothing reads it there, so settings and sign-in state have to be set up and signed in again. The old files are yours to delete, and uninstalling does not touch them.
- Diagnostic logs are never auto-deleted; you can remove the whole `diagnostics` directory.
- One leftover folder from older builds is not removed: `%APPDATA%\youtubetv-for-windows`, inside your user profile folder. It holds only graphics caches (GPU and shader caches) and one local-state file, with no cookies, no passwords, no watch history, and no sign-in state. The current build redirects its data paths to `%PROGRAMDATA%` at startup and no longer writes there; uninstalling does not delete it, and deleting the folder by hand is safe.

### Contact and responsibility

- There's no help desk. For data questions, use the release page: `https://github.com/danielrepublic/youtubetv-for-windows/releases/latest`.
- Data on the YouTube/Google side (watch history, accounts) falls under their terms, not this app.
