# 發佈認證紀錄 / Release certification record

> 這是範本，不是證據。Todo 11 的發佈守門員會讀這份文件的欄位。Status vocabulary: `awaiting-maintainer-evidence`, `blocked`, or `passed`. A release must not be marked stable unless every hard gate below is `passed` with evidence attached. Live evidence below is genuinely uncollected and marked pending; never pre-fill it as passing.

## 狀態 / Status

```text
Status: awaiting-maintainer-evidence
Candidate version: [pending, e.g. 0.1.0]
Certified date: [pending, YYYY-MM-DD]
Certified by: [pending, maintainer name]
Release page: https://github.com/danielrepublic/youtubetv-for-windows/releases/latest
Verdict: DO NOT PUBLISH as stable until all hard gates pass.
```

## 環境 / Environment

| 欄位 / Field            | 值 / Value |
| ----------------------- | ---------- |
| Device model            | [pending]  |
| Windows version / build | [pending]  |
| Electron version        | [pending]  |
| App version             | [pending]  |

## 硬門檻一：實際 2160p / Hard gate 1: actual 2160p

| 欄位 / Field                     | 值 / Value                                              |
| -------------------------------- | ------------------------------------------------------- |
| Display model and resolution     | [pending, must show 3840x2160]                          |
| Network measurement (>= 25 Mbps) | [pending, value plus test method and date]              |
| Public 4K video URL              | [pending]                                               |
| Stats-for-nerds capture          | [pending, screenshot showing current 3840x2160 / 2160p] |
| Result                           | [pending: passed / blocked]                             |

A non-2160p capture, a stale screenshot, or a missing URL blocks stable publication. There is no guarantee 4K will work on any other setup.

## 硬門檻二：登入在重開後仍有效 / Hard gate 2: sign-in persists after relaunch

| 欄位 / Field                        | 值 / Value                                       |
| ----------------------------------- | ------------------------------------------------ |
| Ordinary test account type          | [pending, ordinary account; no secrets recorded] |
| Sign-in completed in child flow     | [pending: passed / blocked]                      |
| Still signed in after full relaunch | [pending: passed / blocked]                      |
| Result                              | [pending: passed / blocked]                      |

A full process restart is required; a window reload doesn't count. Record no passwords, tokens, or account identifiers.

## 硬門檻三：同 Wi-Fi 手機配對與控制 / Hard gate 3: same-Wi-Fi phone pairing and playback control

| 欄位 / Field                        | 值 / Value                  |
| ----------------------------------- | --------------------------- |
| Phone model and YouTube app version | [pending]                   |
| Same Wi-Fi confirmed                | [pending: yes / no]         |
| Desktop appears as a target device  | [pending: passed / blocked] |
| Playback controlled from the phone  | [pending: passed / blocked] |
| Result                              | [pending: passed / blocked] |

## 發佈守門規則 / Publication guard rules

1. 全部三個硬門檻都是 `passed`，才能標成 stable。All three hard gates must read `passed` before the GitHub Release is marked stable.
2. 任一欄位缺失、過期（非本次候選版本測得）、含有機密、或結果為 blocked，守門員必須擋下發佈，並指出缺的是哪一項。
3. 自動化測試通過不能代替這份紀錄。A green unit suite never replaces live evidence.
4. Electron 升級會讓之前的認證失效，必須重測。
5. 這份文件是 not official 產品的誠實聲明：認證只證明「在這台機器、這個版本、這一天」是可用的，不保證其他環境，也沒有 rollback 可以回到已發佈的版本。

## 證據附件 / Evidence attachments

```text
release-evidence/certification/<version>-<date>/
  environment.md        device, Windows build, Electron and app versions
  network.md            speed measurement, method, timestamp
  stats-for-nerds.png   current 3840x2160 / 2160p capture (no account menus)
  signin-relaunch.md    sign-in plus post-relaunch state, secret-free
  phone-pairing.md      device discovery plus playback-control result
  guard-result.log      publication guard output with exit code
```

All attachments: [pending, awaiting maintainer evidence].
