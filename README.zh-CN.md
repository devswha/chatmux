<div align="center">
  <img src="public/logo.png" alt="Gajae App" width="96" height="96">
  <h1>Gajae App</h1>
  <p>在一个自托管的 Web 和桌面工作区中运行 Gajae Code (GJC)、Claude Code、Cursor、Codex 和 OpenCode。</p>
</div>

<p align="center">
  <a href="#quick-start">快速开始</a> ·
  <a href="#first-run">首次运行</a> ·
  <a href="#daily-workflow">日常工作流</a> ·
  <a href="docs/INSTALL.md">生产安装</a> ·
  <a href="https://github.com/devswha/gajae-app/issues">问题</a>
</p>

<div align="right"><i><a href="./README.md">English</a> · <a href="./README.ko.md">한국어</a> · <a href="./README.ja.md">日本語</a> · <a href="./README.de.md">Deutsch</a> · <a href="./README.ru.md">Русский</a> · <a href="./README.tr.md">Türkçe</a> · <b>简体中文</b> · <a href="./README.zh-TW.md">繁體中文</a></i></div>

## Gajae App 的功能

Gajae App 是为在您自己的机器或服务器上运行的编程代理提供的单用户控制界面。它结合了项目和会话发现、流式聊天、审批处理、文件浏览器和编辑器、实时 CLI 可见性、通知、技能、MCP 配置以及远程桌面目标。

该应用不包含模型订阅。请在运行 Gajae App 的同一主机、同一操作系统用户下，安装并验证您打算使用的每个代理 CLI。

### 支持的代理

- **Gajae Code (GJC)**
- **Claude Code**
- **Cursor**
- **Codex**
- **OpenCode**

提供商特定的模型、推理强度控制、权限模式、会话历史、技能和 MCP 功能仅在该提供商支持时出现。

<a id="quick-start"></a>
## 快速开始

### 要求

- Node.js 22.22.2 以上（22.x）或 24.15.0 以上（24.x）
- 源码开发需要通过 rustup 安装 Rust 1.85.1；发布制品已包含原生核心
- npm 和 Git
- 至少一个已安装并已验证的受支持代理 CLI

### 从源码启动 Web 应用

```bash
git clone https://github.com/devswha/gajae-app.git
cd gajae-app
npm ci
npm run dev
```

打开 <http://127.0.0.1:5173>。开发后端监听 `127.0.0.1:3001`。

### 在开发环境中启动桌面应用

保持 Web 栈运行，并在第二个终端中启动 Electron。

终端 1：

```bash
npm run dev
```

终端 2：

```bash
npm run desktop:dev
```

<a id="first-run"></a>
## 首次运行

1. **创建所有者账户。** 打开 Gajae App 并创建唯一的本地应用账户。用户名至少须为 3 个字符，密码至少须为 6 个字符。
2. **设置 Git 身份。** 输入用于在此主机上提交的姓名和电子邮件。这会写入全局 Git `user.name` 和 `user.email`；不需要 GitHub 登录。
3. **连接编程代理。** 在引导过程中完成可用的提供商登录流程，或跳过并稍后使用 **Settings → Agents**。主机级 CLI 验证仍是唯一事实来源。
4. **添加项目。** 使用侧边栏项目操作选择现有目录，或创建/克隆工作区。路径指向运行服务器的机器，而不一定是显示浏览器的设备。
5. **启动会话。** 选择项目，选择可用的提供商，调整该提供商支持的模型和权限控制，然后发送第一个提示。

<a id="daily-workflow"></a>
## 日常工作流

### 项目和会话

- 通过绝对路径添加本地工作区，或通过项目向导克隆 Git 仓库。
- 仅当 HTTPS 克隆需要 GitHub 令牌时，才将它存储在 **Settings → API & Credentials** 中；SSH URL 使用服务器用户的 SSH 配置。
- 在侧边栏展开项目以恢复已索引会话。Gajae App 读取受支持的提供商会话存储，并保持提供商身份彼此分离。
- 从所选项目启动新聊天。停止运行会停止活跃代理进程；不会删除项目或其历史记录。

### 聊天和审批

- 发送文本、图像附件、文件提及以及提供商支持的斜杠命令。
- 在聊天中审查工具调用并响应权限请求，而非盲目启用无限制执行。
- 仅在所选提供商提供这些控制时，使用模型、推理强度、思考和权限控制。
- 从侧边栏恢复较早会话。可编辑会话名称而不更改提供商原生会话标识符。

### 文件

打开“文件”面板以浏览已配置的工作区根目录、预览图像和 Markdown、编辑文本文件、创建文件夹和上传文件。文件访问受限于已验证的项目路径；符号链接和路径遍历逃逸会被拒绝。

### 实时 CLI 会话

Gajae App 可以显示已在 `tmux` 下运行的受支持代理会话。实时行使用 tmux 会话名称，以由终端支持的视图打开，并继续由 tmux 而不是 Web 服务器拥有。服务器重启不得终止这些外部会话。

### 通知

在 **Settings → Notifications** 中启用浏览器或桌面通知。运行完成、错误、需要权限和受支持的实时轮次事件均有独立控制，因此可以独立禁用嘈杂的通道。

## 远程使用

服务器默认绑定到回环地址。对于另一台设备，请保持该绑定，并使用可信 VPN 或 SSH 隧道：

```bash
ssh -N -L 3001:127.0.0.1:3001 user@server
```

然后在本地打开 <http://127.0.0.1:3001>。不要将端口 3001 直接暴露到公共互联网。

Electron 应用可以注册远程 Gajae App 服务器。远程目标需要 HTTPS；仅精确的回环源接受纯 HTTP。每个本地或远程目标使用隔离的 Electron 会话分区，因此 Cookie 和存储不会共享。

## 生产安装

生产环境支持 Linux x86_64、glibc 2.35 或更高版本、22.x 系列的 Node.js 22.22.2 或更高版本，以及用户级 systemd 服务。

使用来自 [GitHub Releases](https://github.com/devswha/gajae-app/releases) 的不可变 `gajae-app-server-<version>-linux-x64-node22.tar.gz` 制品。受支持的安装必须：

1. 下载固定版本及其匹配的 `.sha256` 文件；
2. 在解压前验证校验和；
3. 解压到 `~/.gajae-app/releases/<version>`；
4. 将 `~/.gajae-app/current` 指向该发布版本；
5. 以用户服务运行 `gajae-app.service`，并验证 `http://127.0.0.1:3001/health`。

请遵循 [docs/INSTALL.md](docs/INSTALL.md) 获取准确的首次安装命令，并遵循 [docs/SELF-HOST.md](docs/SELF-HOST.md) 获取服务操作、升级、远程访问、回滚和删除说明。不得将可变的 `latest` URL、包注册表副本、容器镜像或未经验证的源码构建部署为生产服务器。

## 故障排除

| 症状 | 检查 |
|---|---|
| 某个提供商不可用 | 确认其 CLI 已安装、已验证，并且对运行 Gajae App 的用户在 `PATH` 中可见；然后重新检查 **Settings → Agents**。 |
| 项目路径被拒绝 | 输入服务器主机上存在且服务器用户可访问的绝对路径。 |
| Electron 开发环境打开空白或失败页面 | 在运行 `npm run desktop:dev` 前保持 `npm run dev` 活跃。 |
| 服务无法启动 | 运行 `systemctl --user status gajae-app.service` 和 `journalctl --user -u gajae-app.service -f`。 |
| 远程访问失败 | 先确认本地 `/health` 端点，再验证 SSH/VPN 路由或已注册的 HTTPS 源。 |
| 登录后旧凭据仍显示无效 | 在 **Settings → Agents** 中重新连接提供商，并直接以服务用户身份验证 CLI。 |

## 开发命令

| 命令 | 用途 |
|---|---|
| `npm run dev` | 启动 Vite 客户端和开发后端 |
| `npm run server:dev` | 仅启动开发后端 |
| `npm run client` | 仅启动 Vite 客户端 |
| `npm run desktop:dev` | 针对开发客户端启动 Electron |
| `npm test` | 运行服务器、客户端和 Electron 测试 |
| `npm run typecheck` | 对客户端和服务器进行类型检查 |
| `npm run lint` | 对产品和工具代码运行 ESLint |
| `npm run check:identity` | 验证产品、法律和来源身份规则 |
| `npm run build` | 构建生产客户端和服务器 |
| `npm run verify` | 运行完整发布门禁 |

使用 Node.js 22.22.2 以上（22.x）或 24.15.0 以上（24.x），并在提交更改前运行完整门禁：

```bash
npm run verify
```

这会运行依赖审计、类型检查、所有测试分区、lint、身份验证和生产构建。

## 安全性和数据边界

- Web 验证使用带有持久化注销撤销的 `HttpOnly`、`SameSite=Strict` Cookie。
- 不接受来自 URL 查询参数的凭据。外部代理 API 密钥使用 `X-API-Key` 标头。
- 项目文件通过规范路径和符号链接检查解析；写入使用同目录原子替换。
- 上传使用每请求专用的私有临时目录，在完成或失败后清理。
- Electron 默认拒绝目标权限，并将 IPC 限制于已注册的启动器框架。
- 升级或主机迁移前备份 `~/.gajae-app/data`。发布切换必须保留该目录。

## 项目信息

- [生产安装](docs/INSTALL.md)
- [自托管和回滚](docs/SELF-HOST.md)
- [上游来源和选择性引入](docs/UPSTREAM.md)
- [贡献](CONTRIBUTING.md)
- [问题跟踪器](https://github.com/devswha/gajae-app/issues)

<!-- upstream-lineage:start -->
Upstream lineage: Gajae App is derived from [CloudCLI UI](https://github.com/siteboon/claudecodeui). Required attribution and license terms are preserved in [LICENSE](LICENSE) and [NOTICE](NOTICE).
<!-- upstream-lineage:end -->

## 许可证

[GNU AGPL v3](LICENSE)
