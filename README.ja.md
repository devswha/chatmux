<div align="center">
  <img src="public/logo.png" alt="Gajae App" width="96" height="96">
  <h1>Gajae App</h1>
  <p>1 つのセルフホスト型 Web・デスクトップワークスペースから、Gajae Code (GJC)、Claude Code、Cursor、Codex、OpenCode を実行します。</p>
</div>

<p align="center">
  <a href="#quick-start">クイックスタート</a> ·
  <a href="#first-run">初回実行</a> ·
  <a href="#daily-workflow">日常のワークフロー</a> ·
  <a href="docs/INSTALL.md">本番インストール</a> ·
  <a href="https://github.com/devswha/gajae-app/issues">Issue</a>
</p>

<div align="right"><i><a href="./README.md">English</a> · <a href="./README.ko.md">한국어</a> · <b>日本語</b> · <a href="./README.de.md">Deutsch</a> · <a href="./README.ru.md">Русский</a> · <a href="./README.tr.md">Türkçe</a> · <a href="./README.zh-CN.md">简体中文</a> · <a href="./README.zh-TW.md">繁體中文</a></i></div>

## Gajae App でできること

Gajae App は、自分のマシンまたはサーバー上で実行されるコーディングエージェントのための単一ユーザー向け操作画面です。プロジェクトとセッションの検出、ストリーミングチャット、承認処理、ファイルブラウザーとエディター、ライブ CLI の可視化、通知、スキル、MCP 設定、リモートデスクトップターゲットを統合します。

このアプリにはモデルのサブスクリプションは含まれません。使用するすべてのエージェント CLI は、Gajae App を実行する同じホスト上かつ同じオペレーティングシステムユーザーでインストールして認証してください。

### 対応エージェント

- **Gajae Code (GJC)**
- **Claude Code**
- **Cursor**
- **Codex**
- **OpenCode**

プロバイダー固有のモデル、effort 制御、権限モード、セッション履歴、スキル、MCP 機能は、そのプロバイダーが対応している場合にのみ表示されます。

<a id="quick-start"></a>
## クイックスタート

### 要件

- Node.js 22.22.2 以上（22.x）または 24.15.0 以上（24.x）
- ソース開発では rustup 経由の Rust 1.85.1（リリース成果物にはネイティブコアが含まれます）
- npm と Git
- すでにインストール・認証済みの対応エージェント CLI が少なくとも 1 つ

### ソースから Web アプリを起動する

```bash
git clone https://github.com/devswha/gajae-app.git
cd gajae-app
npm ci
npm run dev
```

<http://127.0.0.1:5173> を開きます。開発バックエンドは `127.0.0.1:3001` で待ち受けます。

### 開発環境でデスクトップアプリを起動する

Web スタックを実行したまま、2 つ目のターミナルで Electron を起動します。

ターミナル 1:

```bash
npm run dev
```

ターミナル 2:

```bash
npm run desktop:dev
```

<a id="first-run"></a>
## 初回実行

1. **所有者アカウントを作成します。** Gajae App を開き、唯一のローカルアプリケーションアカウントを作成します。ユーザー名は 3 文字以上、パスワードは 6 文字以上である必要があります。
2. **Git ID を設定します。** このホストで行うコミットに使用する名前とメールアドレスを入力します。これはグローバル Git の `user.name` と `user.email` に書き込みます。GitHub へのサインインは不要です。
3. **コーディングエージェントを接続します。** オンボーディング中に利用可能なプロバイダーのログインフローを完了するか、スキップして後で **Settings → Agents** を使用します。ホストレベルの CLI 認証が信頼の基準であり続けます。
4. **プロジェクトを追加します。** サイドバーのプロジェクト操作から既存ディレクトリを選択するか、ワークスペースを作成・クローンします。パスはブラウザーを表示しているデバイスではなく、サーバーを実行しているマシンを指します。
5. **セッションを開始します。** プロジェクトを選択し、利用可能なプロバイダーを選び、プロバイダーが対応するモデルと権限制御を調整してから、最初のプロンプトを送信します。

<a id="daily-workflow"></a>
## 日常のワークフロー

### プロジェクトとセッション

- 絶対パスでローカルワークスペースを追加するか、プロジェクトウィザードから Git リポジトリをクローンします。
- HTTPS クローンで必要な場合にのみ **Settings → API & Credentials** に GitHub トークンを保存します。SSH URL はサーバーユーザーの SSH 設定を使用します。
- サイドバーでプロジェクトを展開して、インデックス化されたセッションを再開します。Gajae App は対応プロバイダーのセッションストアを読み取り、プロバイダー ID を分離して維持します。
- 選択したプロジェクトから新しいチャットを開始します。実行を停止するとアクティブなエージェントプロセスが停止しますが、プロジェクトや履歴は削除されません。

### チャットと承認

- テキスト、画像添付、ファイルメンション、プロバイダー対応のスラッシュコマンドを送信します。
- 無制限の実行を盲目的に有効化する代わりに、チャット内でツール呼び出しを確認し、権限リクエストに応答します。
- モデル、effort、thinking、権限制御は、選択したプロバイダーが公開している場合にのみ使用します。
- サイドバーから以前のセッションを再開します。プロバイダー固有のセッション識別子を変更せずにセッション名を編集できます。

### ファイル

Files パネルを開くと、設定済みワークスペースルートの参照、画像と Markdown のプレビュー、テキストファイルの編集、フォルダーの作成、ファイルのアップロードができます。ファイルアクセスは検証済みのプロジェクトパスに制限され、シンボリックリンクおよびパストラバーサルによる逸脱は拒否されます。

### ライブ CLI セッション

Gajae App は、すでに `tmux` 上で実行中の対応エージェントセッションを表示できます。ライブ行は tmux セッション名を使い、ターミナルバックドのビューとして開き、Web サーバーではなく tmux が所有し続けます。サーバーの再起動によって、これらの外部セッションが終了してはなりません。

### 通知

**Settings → Notifications** でブラウザーまたはデスクトップ通知を有効にします。実行完了、エラー、権限要求、対応するライブターンイベントにはそれぞれ独立した制御があるため、ノイズの多いレーンを個別に無効化できます。

## リモート利用

サーバーはデフォルトでループバックにバインドされます。別のデバイスから利用する場合は、そのバインディングを維持し、信頼できる VPN または SSH トンネルを使用してください。

```bash
ssh -N -L 3001:127.0.0.1:3001 user@server
```

次にローカルで <http://127.0.0.1:3001> を開きます。ポート 3001 をパブリックインターネットに直接公開しないでください。

Electron アプリはリモート Gajae App サーバーを登録できます。リモートターゲットには HTTPS が必要で、プレーン HTTP が許可されるのは正確なループバックオリジンのみです。各ローカルまたはリモートターゲットは、Cookie とストレージを共有しないよう、隔離された Electron セッションパーティションを使用します。

## 本番インストール

本番環境は、glibc 2.35 以降、22.x 系列の Node.js 22.22.2 以降、ユーザーレベルの systemd サービスを使用する Linux x86_64 でサポートされます。

[GitHub Releases](https://github.com/devswha/gajae-app/releases) の不変な `gajae-app-server-<version>-linux-x64-node22.tar.gz` アーティファクトを使用してください。サポート対象のインストールでは、次をすべて満たす必要があります。

1. 固定したバージョンと一致する `.sha256` ファイルをダウンロードする。
2. 展開前にチェックサムを検証する。
3. `~/.gajae-app/releases/<version>` の下に展開する。
4. `~/.gajae-app/current` をそのリリースに向ける。
5. `gajae-app.service` をユーザーサービスとして実行し、`http://127.0.0.1:3001/health` を検証する。

正確な初回インストールコマンドは [docs/INSTALL.md](docs/INSTALL.md)、サービス運用、アップグレード、リモートアクセス、ロールバック、削除は [docs/SELF-HOST.md](docs/SELF-HOST.md) に従ってください。変更可能な `latest` URL、パッケージレジストリのコピー、コンテナーイメージ、未検証のソースビルドを本番サーバーとしてデプロイしないでください。

## トラブルシューティング

| 症状 | 確認事項 |
|---|---|
| プロバイダーを利用できない | その CLI がインストール・認証済みで、Gajae App を実行するユーザーの `PATH` から見えることを確認してから、**Settings → Agents** を再確認してください。 |
| プロジェクトパスが拒否される | サーバーホストに存在し、サーバーユーザーがアクセスできる絶対パスを入力してください。 |
| Electron の開発環境で空白または失敗したページが開く | `npm run desktop:dev` を実行する前に、`npm run dev` を起動したままにしてください。 |
| サービスが開始しない | `systemctl --user status gajae-app.service` と `journalctl --user -u gajae-app.service -f` を実行してください。 |
| リモートアクセスに失敗する | まずローカルの `/health` エンドポイントを確認し、次に SSH/VPN 経路または登録済み HTTPS オリジンを検証してください。 |
| ログイン後も古い認証情報が無効と表示される | **Settings → Agents** でプロバイダーを再接続し、サービスユーザーで CLI を直接確認してください。 |

## 開発コマンド

| コマンド | 目的 |
|---|---|
| `npm run dev` | Vite クライアントと開発バックエンドを起動 |
| `npm run server:dev` | 開発バックエンドのみを起動 |
| `npm run client` | Vite クライアントのみを起動 |
| `npm run desktop:dev` | 開発クライアントに対して Electron を起動 |
| `npm test` | サーバー、クライアント、Electron のテストを実行 |
| `npm run typecheck` | クライアントとサーバーを型チェック |
| `npm run lint` | 製品およびツールコード全体で ESLint を実行 |
| `npm run check:identity` | 製品、法務、来歴アイデンティティの規則を検証 |
| `npm run build` | 本番クライアントとサーバーをビルド |
| `npm run verify` | 完全なリリースゲートを実行 |

Node.js 22.22.2 以上（22.x）または 24.15.0 以上（24.x）を使用し、変更を送信する前に完全なゲートを実行してください。

```bash
npm run verify
```

これにより、依存関係監査、型チェック、すべてのテストパーティション、lint、アイデンティティ検証、本番ビルドが実行されます。

## セキュリティとデータ境界

- Web 認証は、永続的なログアウト失効機能を備えた `HttpOnly`、`SameSite=Strict` Cookie を使用します。
- 認証情報は URL クエリパラメーターから受け付けません。外部エージェント API キーは `X-API-Key` ヘッダーを使用します。
- プロジェクトファイルは正規パスおよびシンボリックリンクの検査を通して解決され、書き込みには同一ディレクトリ内の原子的置換を使用します。
- アップロードには、完了または失敗後にクリーンアップされるリクエストごとのプライベート一時ディレクトリを使用します。
- Electron はデフォルトでターゲット権限を拒否し、IPC を登録済みランチャーフレームに限定します。
- アップグレードまたはホスト移行前に `~/.gajae-app/data` をバックアップしてください。リリースの切り替えでは、このディレクトリを保持する必要があります。

## プロジェクト情報

- [本番インストール](docs/INSTALL.md)
- [セルフホスティングとロールバック](docs/SELF-HOST.md)
- [アップストリームの来歴と選択的取り込み](docs/UPSTREAM.md)
- [貢献](CONTRIBUTING.md)
- [Issue トラッカー](https://github.com/devswha/gajae-app/issues)

<!-- upstream-lineage:start -->
Upstream lineage: Gajae App is derived from [CloudCLI UI](https://github.com/siteboon/claudecodeui). Required attribution and license terms are preserved in [LICENSE](LICENSE) and [NOTICE](NOTICE).
<!-- upstream-lineage:end -->

## ライセンス

[GNU AGPL v3](LICENSE)
