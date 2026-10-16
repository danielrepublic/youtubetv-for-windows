# 隱私權聲明 / Privacy statement

本文件說明 `youtubetv-for-windows` 如何處理你的資料。先說結論：這個程式是 unofficial 且 not official 的，它把資料留在你的電腦上，不會傳到開發者手裡，也沒有帳號系統。This app offers no guarantee of anything beyond what's written here, and there is no rollback for data you delete.

## 繁體中文

### 資料放在哪裡

- 資料根目錄：`C:\ProgramData\youtubetv-for-windows`（環境變數寫法是 `%PROGRAMDATA%\youtubetv-for-windows`）。這是整台電腦共用的根目錄，不是放在某個人的資料夾裡。
- 平常啟動時，上面那個 `%PROGRAMDATA%` 根目錄是唯一的落點：設定檔、使用者資料與診斷紀錄全部寫在它底下，你的個人資料夾裡不會出現這個程式的檔案，`%APPDATA%` 與 `%LOCALAPPDATA%` 都不在寫入的範圍內。
- 每個 Windows 使用者一個子目錄：`%PROGRAMDATA%\youtubetv-for-windows\users\by-sid\<SID>`。`<SID>` 是你的 Windows 使用者安全性識別碼（security identifier，例如 `S-1-5-21-…`），每個帳號固定一組、Windows 不會重複使用，`by-sid` 則是固定的子目錄名稱。分成人各有各的子目錄，是為了讓兩個帳號不會共用同一份 Chromium 設定檔而互相破壞登入狀態。
- 這個程式有兩個例外，什麼時候會用到由程式自己判斷：
- 例外一：`%PROGRAMDATA%` 沒有值或是空字串的時候，資料根目錄退到 `%APPDATA%\youtubetv-for-windows\users\by-sid\<SID>`，這一次的設定檔與使用者資料就寫在你的個人資料夾裡。
- 例外二：資料根目錄不能建立或不能使用（權限不足、磁碟滿、路徑被別的檔案佔掉），或程式取不到你 Windows 帳號的身分識別（SID）的時候，程式會用 Windows 暫存資料夾 `%LOCALAPPDATA%\Temp` 底下的一個全新目錄（名稱是 `youtubetv-for-windows-profile-` 開頭，後面接一段隨機字元）當作暫時設定檔啟動，並跳一個視窗告訴你資料改放在哪裡。取不到 SID 時不會改用帳號名稱當路徑，以免兩個帳號共用同一份設定檔。這一次開啟的登入狀態不會保留，下次啟動會是一個全新的設定檔。
- 這兩個例外用的目錄，解除安裝都不會刪掉。手動刪掉是安全的，程式下次啟動會自己重新建立需要的部分。
- 這個根目錄的權限：Windows 預設只有系統管理員寫得進 `C:\ProgramData`，所以安裝程式把本機 `Users` 群組對這個資料根目錄設成可讀寫。實話說，這代表同一台電腦上的其他本機帳號在技術上也讀得到這個樹裡的檔案，這是整台電腦共用一個安裝的副作用。要說清楚的是：把每個使用者分到 `by-sid\<SID>` 只是路徑上的隔離，並不會改變這裡的 NTFS 權限；權限收緊是另一件事，追蹤在 https://github.com/danielrepublic/youtubetv-for-windows/issues/2 。

### 這個程式會存什麼

- 瀏覽設定檔：`%PROGRAMDATA%\youtubetv-for-windows\users\by-sid\<SID>\profile`。裡面是 YouTube TV 運作需要的東西：Cookie、快取、你的登入狀態。沒有這些，登入和偏好設定就留不住。
- 使用者資料：`%PROGRAMDATA%\youtubetv-for-windows\users\by-sid\<SID>\userdata`（Electron 的快取與設定）。
- 診斷紀錄：只有在你親手建立以下檔案時才會產生：

```text
%PROGRAMDATA%\youtubetv-for-windows\users\by-sid\<SID>\diagnostics\ENABLED
```

開啟後，程式會在同目錄下寫入 `diagnostic-<時間>-p<行程>-<編號>.jsonl`。內容只有事件名稱與網域（例如 `navigation-committed` 加上 origin），不含網址路徑、查詢參數、Cookie、權杖或帳號識別。預設是關的，刪掉 `ENABLED` 就停。

### 這些資料會傳去哪裡

- 你的瀏覽行為（看什麼影片、搜什麼）只發生在你和 YouTube/Google 之間，和用瀏覽器看 YouTube 一樣。程式沒有自己的伺服器，也不會把你的資料轉寄給開發者。
- 程式不會讀取你的密碼，不會檢查你的憑證，也不會把登入狀態複製到任何別的地方。登入只發生在 Google/YouTube 自己的頁面上。

### 保存與刪除

- 設定檔沒有版本區隔，重新安裝會保留它：安裝程式在換版本時會叫解除安裝程式保留資料再裝新的。只有你自己發起的解除安裝（控制台、開始功能表，或重跑安裝檔選「解除安裝並刪除所有資料」）會刪掉整棵 `%PROGRAMDATA%\youtubetv-for-windows`，也就是這台電腦上所有 Windows 使用者的 `profile`、`userdata` 與 `diagnostics`（見 README「解除安裝會刪掉什麼」）。
- 刪掉就是真的刪掉。程式裡沒有任何備份、沒有匯出、沒有復原（no rollback），重新安裝也不會把它找回來。
- 資料位置改過兩次，兩批舊資料的處理方式不同。第一，早期版本是「只給單一帳號」的安裝，資料放在你的個人資料夾，當年的說明寫的是 `%LOCALAPPDATA%\youtubetv-for-windows\profile`；舊資料不會被搬到 `C:\ProgramData\youtubetv-for-windows`，程式也不會去讀它，解除安裝同樣不會刪它，要清掉得自己刪。第二，舊版本用你的 Windows 帳號名稱當每個使用者的資料夾名稱（`users\<帳號名稱>`），就放在整台電腦共用的 `%PROGRAMDATA%\youtubetv-for-windows` 底下，所以可能和其他 Windows 帳號共用；現在的版本改用 Windows 使用者安全性識別碼（`users\by-sid\<SID>`）。程式不會搬移、複製、採用或合併這批 `users\<帳號名稱>` 舊資料，登入狀態也不會自動轉移。當程式在你目前 Windows 設定檔位置推導出的舊路徑上，偵測到舊的設定檔或使用者資料時，只要那些舊檔案還在，每次啟動都會跳這個中英文提示視窗；已經登入 SID 設定檔的人仍然保持登入。偵測是盡力而為，不保證一定找得到：如果 Windows 帳號改過名，舊目錄仍用舊名稱，程式可能不會發現它。差別在這裡：重新安裝與平常啟動都會保留 `users\<帳號名稱>` 這批舊資料，但你親手執行的解除安裝會刪掉整個 `%PROGRAMDATA%\youtubetv-for-windows` 資料根目錄，連這批舊資料一起刪掉；只有放在個人資料夾的那批早期資料不受解除安裝影響。
- 診斷紀錄不會自動刪除，你可以整個刪掉 `diagnostics` 目錄。
- 還有一個舊版本留下來的目錄不會被刪掉：`%APPDATA%\youtubetv-for-windows`（在你的個人資料夾裡）。早期版本留在裡面的只有顯示用的快取（GPU 與 shader 快取）和一份本機狀態檔，沒有 Cookie、密碼、觀看紀錄或登入狀態。現在的版本啟動時就把資料路徑轉到 `%PROGRAMDATA%`，所以平常這個目錄只會留著早期版本留下的那些檔案。只有「資料放在哪裡」那一節的例外一發生時，它才會變成這個程式的資料根目錄，那時裡面才會有一整棵 `users\by-sid\<SID>` 的設定檔與登入狀態。解除安裝不會刪掉它，想清掉的話直接刪掉整個資料夾就好。

### 聯絡與責任

- 這個專案沒有客服。資料相關的問題請到發佈頁反映：`https://github.com/danielrepublic/youtubetv-for-windows/releases/latest`。
- YouTube/Google 那一側的資料（觀看紀錄、帳號）適用它們自己的條款，與本程式無關。

## English

### Where the data lives

- Data root: `C:\ProgramData\youtubetv-for-windows` (`%PROGRAMDATA%\youtubetv-for-windows` in environment variables). It is a machine-wide root, not something inside one person's profile folder.
- On a normal start that `%PROGRAMDATA%` root is the only landing place: the profile, the user data and the diagnostic logs all go under it, your user profile folder gets no file from this app, and neither `%APPDATA%` nor `%LOCALAPPDATA%` is written to.
- One subdirectory per Windows user: `%PROGRAMDATA%\youtubetv-for-windows\users\by-sid\<SID>`, where `<SID>` is your Windows user security identifier (for example `S-1-5-21-…`), fixed per account and never reused by Windows, and `by-sid` is the fixed subdirectory name at that level. The per-user split exists so two accounts never share one Chromium user-data directory and corrupt each other's sign-in state.
- The app has two exceptions, and it decides for itself when each one applies:
- Blank `%PROGRAMDATA%`: when that environment variable has no value or is an empty string, the data root falls back to `%APPDATA%\youtubetv-for-windows\users\by-sid\<SID>`, so that start writes the profile and the user data inside your user profile folder.
- Unusable data root or unavailable identity: when the data root cannot be created or used (not enough permissions, a full disk, a path taken by some other file), or when the app cannot obtain your Windows user security identifier (SID), the app starts with a temporary profile in a brand-new directory under the Windows temp folder `%LOCALAPPDATA%\Temp` (named `youtubetv-for-windows-profile-` followed by a run of random characters) and shows you a window saying where the data went. It never falls back to an account-name path when the SID is unavailable, so two accounts cannot share one profile. Sign-in state does not persist for that start; the next start is a fresh profile.
- Uninstall does not delete either of those fallback locations. Deleting either one by hand is safe, because the app recreates what it needs on the next start.
- Who can read that root: Windows normally allows writes in `C:\ProgramData` for administrators only, so the installer grants the local `Users` group modify access to the data root. To be straight about it, that means other local accounts on the same PC can technically read the files in that tree. That is a side effect of the machine-wide install. To be clear: splitting users into `by-sid\<SID>` is only a path separation and does not change those NTFS permissions; tightening them is a separate change, tracked at https://github.com/danielrepublic/youtubetv-for-windows/issues/2 .

### What the app stores

- Browser profile: `%PROGRAMDATA%\youtubetv-for-windows\users\by-sid\<SID>\profile`. It holds what YouTube TV needs to work: cookies, cache, and your sign-in state. Without it, sign-in and preferences can't persist.
- User data: `%PROGRAMDATA%\youtubetv-for-windows\users\by-sid\<SID>\userdata` (Electron's caches and settings).
- Diagnostic logs: produced only if you create this file by hand:

```text
%PROGRAMDATA%\youtubetv-for-windows\users\by-sid\<SID>\diagnostics\ENABLED
```

When enabled, the app writes `diagnostic-<time>-p<pid>-<n>.jsonl` next to it. Each line carries only an event name plus an origin (for example `navigation-committed` with an origin), never URL paths, query strings, cookies, tokens, or account identifiers. It's off by default; deleting `ENABLED` stops it.

### Where that data goes

- Your viewing (what you watch or search) happens only between you and YouTube/Google, exactly like watching in a browser. The app runs no server of its own and never forwards your data to the developer.
- The app never reads your password, never inspects credentials, and never copies sign-in state anywhere else. Sign-in happens only on Google/YouTube pages.

### Retention and deletion

- The profile has no version segment, and reinstalls keep it: when the installer replaces an older version it runs the uninstaller with an instruction to keep the data. Only an uninstall you start yourself (Control Panel, the Start menu, or the installer run again with "Uninstall and delete all data") deletes the whole `%PROGRAMDATA%\youtubetv-for-windows` tree, which is the `profile`, `userdata`, and `diagnostics` of every Windows user on this PC. See "What uninstall removes" in the README.
- Deleted means deleted. The app keeps no backup, exports nothing, and offers no restore (no rollback); reinstalling does not bring it back.
- The data location has moved twice, and the two old data sets are handled differently. First, earlier releases were a single-account install that kept data in your user profile folder, and the README of the time pointed at `%LOCALAPPDATA%\youtubetv-for-windows\profile`; nothing copies that old data into `C:\ProgramData\youtubetv-for-windows` and nothing reads it there, uninstall does not delete it either, and clearing it is up to you. Second, older builds named each user's folder after the Windows account name (`users\<account name>`) under the machine-wide `%PROGRAMDATA%\youtubetv-for-windows`, so it may be shared with other Windows accounts; the current build uses the Windows user security identifier (`users\by-sid\<SID>`). The app never moves, copies, adopts, merges, or deletes the old `users\<account name>` data, and sign-in state is never transferred from it automatically. When the app detects legacy profile or userdata at the old path derived from your current Windows profile location, this notice appears on every launch while those legacy leaves remain. Already-signed-in SID profiles remain signed in. Detection is best-effort and not guaranteed: a renamed account keeps its old directory under the old name, so the app may not find it. The difference matters: reinstall and a normal launch both keep the old `users\<account name>` data, but an uninstall you start yourself deletes the whole `%PROGRAMDATA%\youtubetv-for-windows` data root, including that legacy data; only the earlier per-user-profile data is untouched by uninstall.
- Diagnostic logs are never auto-deleted; you can remove the whole `diagnostics` directory.
- One folder from older builds is not removed: `%APPDATA%\youtubetv-for-windows`, inside your user profile folder. What earlier builds left in it is only graphics caches (GPU and shader caches) and one local-state file, with no cookies, no passwords, no watch history, and no sign-in state. The current build redirects its data paths to `%PROGRAMDATA%` at startup, so normally nothing new is written into that folder. It becomes this app's data root only in the first exception listed under "Where the data lives", and only then does it hold a full `users\by-sid\<SID>` tree with your profile and sign-in state. Uninstalling does not delete it, and deleting the folder by hand is safe.

### Contact and responsibility

- There's no help desk. For data questions, use the release page: `https://github.com/danielrepublic/youtubetv-for-windows/releases/latest`.
- Data on the YouTube/Google side (watch history, accounts) falls under their terms, not this app.
