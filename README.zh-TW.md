<div align="center">
  <img src="public/logo.png" alt="Gajae App" width="96" height="96">
  <h1>Gajae App</h1>
  <p>在一個自託管的 Web 與桌面工作區中執行 Gajae Code (GJC)、Claude Code、Cursor、Codex 和 OpenCode。</p>
</div>

<p align="center">
  <a href="#quick-start">快速開始</a> ·
  <a href="#first-run">首次執行</a> ·
  <a href="#daily-workflow">日常工作流程</a> ·
  <a href="docs/INSTALL.md">正式環境安裝</a> ·
  <a href="https://github.com/devswha/gajae-app/issues">問題</a>
</p>

<div align="right"><i><a href="./README.md">English</a> · <a href="./README.ko.md">한국어</a> · <a href="./README.ja.md">日本語</a> · <a href="./README.de.md">Deutsch</a> · <a href="./README.ru.md">Русский</a> · <a href="./README.tr.md">Türkçe</a> · <a href="./README.zh-CN.md">简体中文</a> · <b>繁體中文</b></i></div>

## Gajae App 的功能

Gajae App 是為在您自己的機器或伺服器上執行的程式設計代理提供的單一使用者控制介面。它結合了專案和工作階段探索、串流聊天、核准處理、檔案瀏覽器和編輯器、即時 CLI 可見性、通知、技能、MCP 設定以及遠端桌面目標。

此應用程式不包含模型訂閱。請在執行 Gajae App 的同一主機、同一作業系統使用者下，安裝並驗證您打算使用的每個代理 CLI。

### 支援的代理

- **Gajae Code (GJC)**
- **Claude Code**
- **Cursor**
- **Codex**
- **OpenCode**

提供者特定的模型、推理強度控制、權限模式、工作階段歷程、技能和 MCP 功能僅在該提供者支援時出現。

<a id="quick-start"></a>
## 快速開始

### 要求

- Node.js 22.22.2 以上（22.x）或 24.15.0 以上（24.x）
- 原始碼開發需要透過 rustup 安裝 Rust 1.85.1；發行成品已包含原生核心
- npm 和 Git
- 至少一個已安裝並已驗證的受支援代理 CLI

### 從原始碼啟動 Web 應用程式

```bash
git clone https://github.com/devswha/gajae-app.git
cd gajae-app
npm ci
npm run dev
```

開啟 <http://127.0.0.1:5173>。開發後端監聽 `127.0.0.1:3001`。

### 在開發環境中啟動桌面應用程式

保持 Web 堆疊執行，並在第二個終端機中啟動 Electron。

終端機 1：

```bash
npm run dev
```

終端機 2：

```bash
npm run desktop:dev
```

<a id="first-run"></a>
## 首次執行

1. **建立擁有者帳戶。** 開啟 Gajae App 並建立唯一的本機應用程式帳戶。使用者名稱至少須為 3 個字元，密碼至少須為 6 個字元。
2. **設定 Git 身分。** 輸入用於在此主機上提交的姓名和電子郵件。這會寫入全域 Git `user.name` 和 `user.email`；不需要 GitHub 登入。
3. **連線程式設計代理。** 在引導過程中完成可用的提供者登入流程，或跳過並稍後使用 **Settings → Agents**。主機層級 CLI 驗證仍是唯一事實來源。
4. **新增專案。** 使用側邊欄專案操作選擇現有目錄，或建立/複製工作區。路徑指向執行伺服器的機器，而不一定是顯示瀏覽器的裝置。
5. **啟動工作階段。** 選擇專案，選擇可用的提供者，調整該提供者支援的模型和權限控制，然後傳送第一個提示。

<a id="daily-workflow"></a>
## 日常工作流程

### 專案和工作階段

- 透過絕對路徑新增本機工作區，或透過專案精靈複製 Git 儲存庫。
- 僅當 HTTPS 複製需要 GitHub 權杖時，才將它儲存在 **Settings → API & Credentials** 中；SSH URL 使用伺服器使用者的 SSH 設定。
- 在側邊欄展開專案以恢復已建立索引的工作階段。Gajae App 讀取受支援的提供者工作階段儲存區，並保持提供者身分彼此分離。
- 從所選專案啟動新聊天。停止執行會停止作用中的代理程序；不會刪除專案或其歷程。

### 聊天和核准

- 傳送文字、影像附件、檔案提及以及提供者支援的斜線命令。
- 在聊天中檢閱工具呼叫並回應權限請求，而非盲目啟用不受限制的執行。
- 僅在所選提供者提供這些控制時，使用模型、推理強度、思考和權限控制。
- 從側邊欄恢復較早工作階段。可編輯工作階段名稱而不變更提供者原生工作階段識別碼。

### 檔案

開啟「檔案」面板以瀏覽已設定的工作區根目錄、預覽影像和 Markdown、編輯文字檔案、建立資料夾和上傳檔案。檔案存取受限於已驗證的專案路徑；符號連結和路徑周遊逸出會被拒絕。

### 即時 CLI 工作階段

Gajae App 可以顯示已在 `tmux` 下執行的受支援代理工作階段。即時列使用 tmux 工作階段名稱，以由終端機支援的檢視開啟，並繼續由 tmux 而不是 Web 伺服器擁有。伺服器重新啟動不得終止這些外部工作階段。

### 通知

在 **Settings → Notifications** 中啟用瀏覽器或桌面通知。執行完成、錯誤、需要權限和受支援的即時回合事件均有獨立控制，因此可以獨立停用嘈雜的通道。

## 遠端使用

伺服器預設繫結到迴送位址。對於另一台裝置，請保持該繫結，並使用可信任 VPN 或 SSH 通道：

```bash
ssh -N -L 3001:127.0.0.1:3001 user@server
```

然後在本機開啟 <http://127.0.0.1:3001>。不要將連接埠 3001 直接暴露到公共網際網路。

Electron 應用程式可以註冊遠端 Gajae App 伺服器。遠端目標需要 HTTPS；僅精確的迴送來源接受純 HTTP。每個本機或遠端目標使用隔離的 Electron 工作階段分割區，因此 Cookie 和儲存空間不會共用。

## 正式環境安裝

正式環境支援 Linux x86_64、glibc 2.35 或更新版本、22.x 系列的 Node.js 22.22.2 或更新版本，以及使用者層級 systemd 服務。

使用來自 [GitHub Releases](https://github.com/devswha/gajae-app/releases) 的不可變 `gajae-app-server-<version>-linux-x64-node22.tar.gz` 成品。受支援的安裝必須：

1. 下載固定版本及其相符的 `.sha256` 檔案；
2. 在解壓縮前驗證檢查碼；
3. 解壓縮到 `~/.gajae-app/releases/<version>`；
4. 將 `~/.gajae-app/current` 指向該發行版本；
5. 以使用者服務執行 `gajae-app.service`，並驗證 `http://127.0.0.1:3001/health`。

請遵循 [docs/INSTALL.md](docs/INSTALL.md) 取得精確的首次安裝命令，並遵循 [docs/SELF-HOST.md](docs/SELF-HOST.md) 取得服務操作、升級、遠端存取、復原和移除說明。不得將可變的 `latest` URL、套件登錄檔副本、容器映像或未經驗證的原始碼建置部署為正式環境伺服器。

## 疑難排解

| 症狀 | 檢查 |
|---|---|
| 某個提供者無法使用 | 確認其 CLI 已安裝、已驗證，並且對執行 Gajae App 的使用者在 `PATH` 中可見；然後重新檢查 **Settings → Agents**。 |
| 專案路徑被拒絕 | 輸入伺服器主機上存在且伺服器使用者可存取的絕對路徑。 |
| Electron 開發環境開啟空白或失敗頁面 | 在執行 `npm run desktop:dev` 前保持 `npm run dev` 作用中。 |
| 服務無法啟動 | 執行 `systemctl --user status gajae-app.service` 和 `journalctl --user -u gajae-app.service -f`。 |
| 遠端存取失敗 | 先確認本機 `/health` 端點，再驗證 SSH/VPN 路由或已註冊的 HTTPS 來源。 |
| 登入後舊憑證仍顯示無效 | 在 **Settings → Agents** 中重新連線提供者，並直接以服務使用者身分驗證 CLI。 |

## 開發命令

| 命令 | 用途 |
|---|---|
| `npm run dev` | 啟動 Vite 用戶端和開發後端 |
| `npm run server:dev` | 僅啟動開發後端 |
| `npm run client` | 僅啟動 Vite 用戶端 |
| `npm run desktop:dev` | 針對開發用戶端啟動 Electron |
| `npm test` | 執行伺服器、用戶端和 Electron 測試 |
| `npm run typecheck` | 對用戶端和伺服器進行型別檢查 |
| `npm run lint` | 對產品和工具程式碼執行 ESLint |
| `npm run check:identity` | 驗證產品、法律和來源身分規則 |
| `npm run build` | 建置正式環境用戶端和伺服器 |
| `npm run verify` | 執行完整發行閘門 |

使用 Node.js 22.22.2 以上（22.x）或 24.15.0 以上（24.x），並在提交變更前執行完整閘門：

```bash
npm run verify
```

這會執行相依性稽核、型別檢查、所有測試分割區、lint、身分驗證和正式環境建置。

## 安全性和資料邊界

- Web 驗證使用帶有持久化登出撤銷的 `HttpOnly`、`SameSite=Strict` Cookie。
- 不接受來自 URL 查詢參數的憑證。外部代理 API 金鑰使用 `X-API-Key` 標頭。
- 專案檔案透過正規路徑和符號連結檢查解析；寫入使用同目錄原子取代。
- 上傳使用每個請求專用的私有暫存目錄，在完成或失敗後清理。
- Electron 預設拒絕目標權限，並將 IPC 限制於已註冊的啟動器框架。
- 升級或主機移轉前備份 `~/.gajae-app/data`。發行切換必須保留該目錄。

## 專案資訊

- [正式環境安裝](docs/INSTALL.md)
- [自託管和復原](docs/SELF-HOST.md)
- [上游來源和選擇性納入](docs/UPSTREAM.md)
- [貢獻](CONTRIBUTING.md)
- [問題追蹤器](https://github.com/devswha/gajae-app/issues)

<!-- upstream-lineage:start -->
Upstream lineage: Gajae App is derived from [CloudCLI UI](https://github.com/siteboon/claudecodeui). Required attribution and license terms are preserved in [LICENSE](LICENSE) and [NOTICE](NOTICE).
<!-- upstream-lineage:end -->

## 授權

[GNU AGPL v3](LICENSE)
