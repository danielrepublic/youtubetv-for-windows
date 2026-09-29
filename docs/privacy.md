# 隱私權聲明 / Privacy statement

本文件說明 `youtubetv-for-windows` 如何處理你的資料。先說結論：這個程式是 unofficial 且 not official 的，它把資料留在你的電腦上，不會傳到開發者手裡，也沒有帳號系統。This app offers no guarantee of anything beyond what's written here, and there is no rollback for data you delete.

## 繁體中文

### 這個程式會存什麼

- 瀏覽設定檔：`%LOCALAPPDATA%\youtubetv-for-windows\profile`。裡面是 YouTube TV 運作需要的東西：Cookie、快取、你的登入狀態。沒有這些，登入和偏好設定就留不住。
- 更新暫存：`%LOCALAPPDATA%\youtubetv-for-windows\updates`（待安裝檔與鎖定檔）與 `update-status`（安裝完成標記）。程式自己管理，你不用管。
- 漫遊設定：`%APPDATA%\youtubetv-for-windows`（快取與設定）。
- 診斷紀錄：只有在你親手建立以下檔案時才會產生：

```text
%LOCALAPPDATA%\youtubetv-for-windows\diagnostics\ENABLED
```

開啟後，程式會在同目錄下寫入 `diagnostic-<時間>-p<行程>-<編號>.jsonl`。內容只有事件名稱與網域（例如 `navigation-committed` 加上 origin），不含網址路徑、查詢參數、Cookie、權杖或帳號識別。預設是關的，刪掉 `ENABLED` 就停。

### 這些資料會傳去哪裡

- 你的瀏覽行為（看什麼影片、搜什麼）只發生在你和 YouTube/Google 之間，和用瀏覽器看 YouTube 一樣。程式沒有自己的伺服器，也不會把你的資料轉寄給開發者。
- 每次啟動時，程式會向 GitHub 發佈頁檢查新版本（讀取 `https://github.com/danielrepublic/youtubetv-for-windows/releases/latest` 背後的版本資訊）。這是版本檢查，不是追蹤。
- 程式不會讀取你的密碼，不會檢查你的憑證，也不會把登入狀態複製到任何別的地方。登入只發生在 Google/YouTube 自己的頁面上。

### 保存與刪除

- 設定檔沒有版本區隔，更新或重新安裝會保留它。只有解除安裝會刪除全部資料（見 README「解除安裝會刪掉什麼」）。
- 診斷紀錄不會自動刪除，你可以整個刪掉 `diagnostics` 目錄。

### 聯絡與責任

- 這個專案沒有客服。資料相關的問題請到發佈頁反映：`https://github.com/danielrepublic/youtubetv-for-windows/releases/latest`。
- YouTube/Google 那一側的資料（觀看紀錄、帳號）適用它們自己的條款，與本程式無關。

## English

### What the app stores

- Browser profile: `%LOCALAPPDATA%\youtubetv-for-windows\profile`. It holds what YouTube TV needs to work: cookies, cache, and your sign-in state. Without it, sign-in and preferences can't persist.
- Update scratch: `%LOCALAPPDATA%\youtubetv-for-windows\updates` (pending installers and lock files) and `update-status` (install completion markers). The app manages these; you can ignore them.
- Roaming settings: `%APPDATA%\youtubetv-for-windows` (caches and settings).
- Diagnostic logs: produced only if you create this file by hand:

```text
%LOCALAPPDATA%\youtubetv-for-windows\diagnostics\ENABLED
```

When enabled, the app writes `diagnostic-<time>-p<pid>-<n>.jsonl` next to it. Each line carries only an event name plus an origin (for example `navigation-committed` with an origin), never URL paths, query strings, cookies, tokens, or account identifiers. It's off by default; deleting `ENABLED` stops it.

### Where that data goes

- Your viewing (what you watch or search) happens only between you and YouTube/Google, exactly like watching in a browser. The app runs no server of its own and never forwards your data to the developer.
- On each launch, the app checks GitHub for a newer release (reading version info behind `https://github.com/danielrepublic/youtubetv-for-windows/releases/latest`). That's a version check, not tracking.
- The app never reads your password, never inspects credentials, and never copies sign-in state anywhere else. Sign-in happens only on Google/YouTube pages.

### Retention and deletion

- The profile has no version segment: updates and reinstalls keep it. Only uninstall deletes everything (see "What uninstall removes" in the README).
- Diagnostic logs are never auto-deleted; you can remove the whole `diagnostics` directory.

### Contact and responsibility

- There's no help desk. For data questions, use the release page: `https://github.com/danielrepublic/youtubetv-for-windows/releases/latest`.
- Data on the YouTube/Google side (watch history, accounts) falls under their terms, not this app.
