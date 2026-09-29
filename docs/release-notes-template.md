# 發佈說明範本 / Release notes template

> 給維護者：發佈每個版本時，複製這份範本，填上方括號的欄位，不要刪掉底部的風險聲明。All placeholders in [brackets] must be filled before publishing. There is no guarantee attached to any release, and there is no rollback once a user installs it.

---

## 繁體中文

### 版本 [x.y.z]（[YYYY-MM-DD]）

下載位置：`https://github.com/danielrepublic/youtubetv-for-windows/releases/latest`

安裝檔：`youtubetv-for-windows-[x.y.z]-x64.exe`

SHA-256：`[填入安裝檔的 SHA-256]`

### 這個版本做了什麼

- [一句話說明，例如：修正了什麼、支援了什麼]
- [有的話再加一條，沒有就刪掉這行]

### 已知限制

- 安裝檔未簽署，Windows SmartScreen 會跳出警告，處理方式見 README「SmartScreen 警告」。
- 自動更新用的正式簽章金鑰[已佈署 / 尚未佈署]。尚未佈署時，請使用者從本頁手動下載。
- 4K、登入、手機配對都不保證，條件見 README。

### 風險聲明（不要刪除）

這個程式不是官方產品，和 YouTube 或 Google 沒有任何關係（not official）。它沒有服務保證，YouTube 隨時可能改變或封鎖存取。更新一旦交給安裝程式就沒有自動回復（no rollback），失敗時請手動重新下載安裝。

## English

### Version [x.y.z] ([YYYY-MM-DD])

Download: `https://github.com/danielrepublic/youtubetv-for-windows/releases/latest`

Installer: `youtubetv-for-windows-[x.y.z]-x64.exe`

SHA-256: `[installer SHA-256 here]`

### What changed

- [One line, e.g. what was fixed or added]
- [Add another line if needed, else delete this line]

### Known limits

- The installer is unsigned, so Windows SmartScreen will warn; see "About the SmartScreen warning" in the README.
- The production release-signing key is [provisioned / not yet provisioned]. Until it is, users should download from this page by hand.
- 4K, sign-in, and phone pairing carry no guarantee; see the README for conditions.

### Risk disclosure (do not delete)

This app is not official and is not affiliated with YouTube or Google. There is no SLA, and YouTube may change or block access at any time. There is no rollback (no automatic rollback) once an update hands off to the installer; on failure, download and install the latest version manually.
