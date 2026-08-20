<p align="center">
  <img src="../assets/readme-hero.svg" alt="ChatMux — 所有编码代理，一个指挥台：Oh My OpenAgent、Codex、Claude、Gajae Code、Cursor、OpenCode 和 Oh My Pi 会话多路复用到一个自托管界面" width="900">
</p>

<p align="center"><sub><a href="../../README.md">English</a> · <a href="README.ko.md">한국어</a> · <a href="README.ja.md">日本語</a> · <b>简体中文</b></sub></p>

<p align="center">Claude Code、Codex、OpenCode 等代理，一个界面统一管理 —<br>直接连接 tmux 中已运行的会话。</p>

<p align="center">
  <a href="https://github.com/devswha/chatmux/releases"><img src="https://img.shields.io/github/v/release/devswha/chatmux?display_name=tag&label=release&style=flat-square&color=6366f1" alt="GitHub 发布"></a>
  <a href="../../LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-0c1324?style=flat-square" alt="AGPL-3.0 许可证"></a>
  <img src="https://img.shields.io/badge/node-22.22.2%2B%20%7C%2024.15.0%2B-22d3c5?style=flat-square" alt="支持的 Node 版本">
  <img src="https://img.shields.io/badge/runtime-tmux-ff6b4a?style=flat-square" alt="tmux 运行时">
</p>

你照常在 tmux 中运行编码代理 — Oh My OpenAgent、Gajae Code、Claude Code、Codex、Cursor CLI、OpenCode、Oh My Pi。ChatMux 会自动发现它们，并把所有会话显示在一个浏览器页面中，无论你使用桌面还是手机。

- **无需注册：** 已在 tmux 中运行的代理会直接出现在侧边栏。不用包装、接线或重启。
- **多提供方：** 所有提供方都在一个可拖拽排序的列表中，实时显示 `RUN`、`READY` 和 `ERROR` 徽章。
- **聊天或终端：** 能识别记录的会话以对话形式呈现；其余则是真实的附加终端。输入只会送达 ChatMux 已验证身份的 pane。
- **适配手机：** 通过 Tailscale 或局域网密码安装 PWA — 完整的会话列表、对话，以及带按键栏的真实 TUI。
- **tmux 始终是主宰：** 随时重启或删除 ChatMux；你的 tmux 会话原样继续运行。

ChatMux 不捆绑任何 AI 订阅。请以运行 ChatMux 的同一 OS 用户安装并登录各个代理 CLI。

## 开始使用

```bash
curl -fsSL https://github.com/devswha/chatmux/releases/latest/download/install.sh | bash
```

需要 Linux x86_64（glibc 2.35+）、tmux、用户级 systemd 以及 `curl`/`tar`/`sha256sum`。

安装器下载正式发布归档并校验其 SHA-256，启动用户级服务，然后打印访问地址以及手机二维码。`chatmux status` 可随时再次显示这些信息。

<p align="center">
  <img src="../assets/install.png" alt="install.sh 输出：下载与校验、本地和 Tailscale 手机地址，以及在手机上打开 ChatMux 的二维码" width="760">
</p>

版本锁定、访问模式、更新、回滚与恢复见[安装指南](../INSTALL.md)。

## 在浏览器中

打开打印出的 `Local` 地址 — 正在运行的 tmux 代理会自动出现在侧边栏。能识别记录的会话会渲染为带输入框的结构化对话：

<p align="center">
  <img src="../assets/desktop-chat-live.png" alt="桌面端 ChatMux：侧边栏显示七个实时编码代理，Oh My OpenAgent 排在首位，随后是 GJC、Codex、Claude、Cursor、OpenCode 和 Oh My Pi，并显示 RUN 或 READY 状态" width="900">
</p>

同一会话的 `CLI output` 标签页把真正运行在 tmux 里的 TUI 渲染到浏览器中 — 回应菜单提示、查看原始输出，或用真实按键直接接管：

<p align="center">
  <img src="../assets/browser-cli.png" alt="同一会话的 CLI output 标签页：运行在 tmux 里的真正 Codex TUI 被渲染到浏览器中" width="900">
</p>

## 在手机上

在手机上打开 Tailscale，扫描安装输出中的二维码，然后使用应用内的 **Install app** 按钮将 ChatMux 保存为 PWA：

<table align="center">
  <tr>
    <td align="center">
      <img src="../assets/mobile-sidebar-live.png" width="250" alt="移动端侧边栏：OMO 排在首位，显示七个实时编码代理、活动徽章和拖拽手柄"><br>
      <sub>完整会话总表</sub>
    </td>
    <td align="center">
      <img src="../assets/mobile-chat-live.png" width="250" alt="显示真实提问和回答的 Codex 会话移动端对话视图"><br>
      <sub>对话视图</sub>
    </td>
    <td align="center">
      <img src="../assets/mobile-cli-live.png" width="250" alt="在 Codex TUI 与终端按键栏中显示同一段真实对话的移动端 CLI 输出视图"><br>
      <sub>带按键栏的真实 TUI</sub>
    </td>
  </tr>
</table>

## 代理支持

以下代理均会被自动发现，支持直接输入，也可从 ChatMux 启动新会话。已索引的历史记录会显示为对话，实时 CLI 输出则始终可用。

| 代理 | 聊天视图 |
|---|---|
| **Claude Code** | 历史索引后 |
| **Codex CLI** | 历史索引后 |
| **Cursor CLI** | 历史索引后 |
| **OpenCode** | 历史索引后 |
| **Oh My OpenAgent** (`omo`) | 历史索引后 |
| **Oh My Pi** | 历史索引后 |
| **Gajae Code (GJC)** | 原生支持 |

SSH tmux 和本地 shell 也可作为纯终端连接使用。

<sub>Cursor 会话使用文档中的 <code>agent</code> 命令；为旧安装保留了传统的 <code>cursor-agent</code> 别名。</sub>

## 远程访问

如果已登录 Tailscale，安装器会自动配置 Tailscale Serve：获批的 tailnet 账户无需额外密码即可使用私有 HTTPS 地址，其他用户一律拒绝。没有 Tailscale 时，安装会启用带一次性所有者密码的局域网密码访问：

```bash
chatmux access password             # 轮换/找回（注销所有会话）
chatmux access enable tailscale     # Tailscale 就绪后切换模式
```

用户白名单、更长会话、VPN 模式、SSH 隧道与公网 TLS 选项见[远程访问指南](../REMOTE-ACCESS.md)。

## CLI

`chatmux` 命令用于管理已安装的服务：

```bash
chatmux status                  # 版本、地址、数据位置
chatmux access users            # 允许的 Tailscale 账户
chatmux access allow user@example.com
chatmux sandbox ~/my-project    # 在 Docker 沙箱中运行
```


## 安全与数据边界

- ChatMux 将 tmux 进程谱系与原生记录标识符关联。仅凭工作目录一致绝不足以授权破坏性操作，且在中继或终止之前都会重新核验 tmux 会话标识符。
- 后端绑定在环回地址。Tailscale 模式只信任来自预期 HTTPS 源环回的 Serve 身份标头；安装器绝不会启用 Funnel 或公开监听器，未获批用户一律拒绝。
- 密码模式使用 `HttpOnly`、`SameSite=Strict` Cookie 与持久化的注销吊销。
- 状态与索引位于 `~/.chatmux` 之下。迁移或升级前请备份 `~/.chatmux/data`。

## 开发

```bash
git clone https://github.com/devswha/chatmux.git
cd chatmux
npm ci
npm run dev
```

打开 <http://127.0.0.1:5173>。开发需要 22.x 线 Node.js `22.22.2+` 或 24.x 线 `24.15.0+`、npm、Git、tmux 和 Rust `1.85.1`。`npm run verify` 运行完整的发布门禁：审计、类型检查、Rust 检查、测试、lint、身份检查和生产构建。

## 文档

- [生产安装](../INSTALL.md)
- [远程访问](../REMOTE-ACCESS.md)
- [自托管运维](../SELF-HOST.md)
- [产品范围与路线图](../ROADMAP.md)
- [上游来源](../UPSTREAM.md)
- [参与贡献](../../CONTRIBUTING.md)
- [问题追踪](https://github.com/devswha/chatmux/issues)

## 许可证

[AGPL-3.0](../../LICENSE) · 献给生活在 tmux 里的人
