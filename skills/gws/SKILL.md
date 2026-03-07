---
name: gws
description: Google Workspace CLI（gws）— Drive・Gmail・Calendar・Sheets・Docs・Chat等を統一CLIで操作。AIエージェント向けMCPサーバー機能付き。npm install -g @googleworkspace/cli でインストール。
---

# Google Workspace CLI (gws) スキル

Google が公式リリースした CLI ツール。Drive・Gmail・Calendar・Sheets・Docs・Chat・Admin など全 Workspace API をひとつのコマンドで操作できる。人間とAIエージェント両方を想定した設計。

- **公式リポジトリ**: https://github.com/googleworkspace/cli
- **npm パッケージ**: `@googleworkspace/cli`
- **リリース日**: 2026年3月2日
- **ステータス**: v1.0 に向けて開発中（破壊的変更あり）。Google の公式サポート対象外プロダクト。

---

## インストール

```bash
# npm（推奨）— OS/アーキテクチャ別のネイティブバイナリが同梱
npm install -g @googleworkspace/cli

# インストール確認
gws --version
```

---

## 認証セットアップ

### 手順1: 初回セットアップ（Google Cloud プロジェクト設定）

```bash
# OAuth 認証情報の設定、必要な API の有効化を対話形式で実行
gws auth setup
```

### 手順2: ログイン

```bash
# OAuth ログイン（ブラウザで URL を開いてスコープを承認）
gws auth login

# サービスを絞ってスコープを選択する場合
gws auth login -s drive,gmail,calendar
```

### サービスアカウント認証（エージェント・自動化向け）

```bash
export GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=/path/to/service-account.json
gws drive files list
```

---

## コマンド体系

コマンドは Google Discovery Service をランタイムで読み込んで動的に生成される。Google が API を追加すると自動的に利用可能になる。

```
gws <サービス> <リソース> <メソッド> [オプション]
```

### ヘルプ確認

```bash
gws --help
gws gmail --help
gws drive files --help
gws schema gmail.users.messages.list   # メソッドのパラメータ・型・デフォルト値を確認
```

---

## 主要サービスと代表コマンド

### Gmail

```bash
# メッセージ一覧
gws gmail users messages list --userId me --maxResults 10

# メッセージ取得（本文含む）
gws gmail users messages get --userId me --id <messageId>

# メッセージ送信
gws gmail users messages send --userId me --body '{"raw": "<base64encoded>"}'

# スレッド一覧
gws gmail users threads list --userId me --q "is:unread"
```

### Drive

```bash
# ファイル一覧
gws drive files list

# ファイル検索
gws drive files list --q "name contains 'report'"

# ファイル取得（メタデータ）
gws drive files get --fileId <fileId>

# ファイルアップロード
gws drive files create --body '{"name": "example.txt"}'
```

### Calendar

```bash
# カレンダー一覧
gws calendar calendars list --calendarId primary

# イベント一覧
gws calendar events list --calendarId primary --maxResults 10

# イベント作成（テキストから簡単作成）
gws calendar events quickAdd --calendarId primary --text "Meeting tomorrow 3pm"

# イベント作成（詳細指定）
gws calendar events insert --calendarId primary --body '{"summary": "MTG", "start": {...}, "end": {...}}'
```

### Sheets

```bash
# スプレッドシート取得
gws sheets spreadsheets get --spreadsheetId <id>

# セル値の取得
gws sheets spreadsheets values get --spreadsheetId <id> --range "Sheet1!A1:D10"

# セル値の更新
gws sheets spreadsheets values update --spreadsheetId <id> --range "Sheet1!A1" --valueInputOption RAW --body '{"values": [["hello"]]}'
```

### Docs

```bash
# ドキュメント取得
gws docs documents get --documentId <id>

# ドキュメント作成
gws docs documents create --body '{"title": "新しいドキュメント"}'
```

---

## MCP サーバーモード（AIエージェント統合）

`gws mcp` で stdio 経由の MCP サーバーを起動。Claude Desktop・VS Code など MCP 対応クライアントから Workspace API をツールとして呼び出せる。

```bash
# Drive・Gmail・Calendar を MCP ツールとして公開
gws mcp -s drive,gmail,calendar

# 全サービスを公開
gws mcp -s all

# コンパクトモード（コンテキストウィンドウ節約: ~200-400ツール → 約26ツール）
gws mcp -s drive,gmail,calendar --tool-mode compact
```

### Claude Desktop の設定例（`claude_desktop_config.json`）

```json
{
  "mcpServers": {
    "google-workspace": {
      "command": "gws",
      "args": ["mcp", "-s", "drive,gmail,calendar,sheets,docs"]
    }
  }
}
```

---

## エージェントスキル（SKILL.md）

リポジトリには 100+ の SKILL.md ファイルが含まれる。各サービスの API ごとに 1 ファイル、加えて Gmail・Drive・Calendar・Sheets・Docs の上位ワークフロー 50 本が含まれる。

```bash
# スキル一覧はリポジトリの skills/ ディレクトリを参照
# https://github.com/googleworkspace/cli/blob/main/docs/skills.md
```

---

## 出力フォーマット

```bash
# デフォルト: 構造化 JSON（AIエージェント向け）
gws drive files list

# ドライランプレビュー
gws drive files create --dry-run ...

# 自動ページネーション（複数ページを自動取得）
gws gmail users messages list --userId me --all-pages
```

---

## よく使うユースケース例

### 未読メールの件名一覧を取得

```bash
gws gmail users messages list --userId me --q "is:unread" --maxResults 20
```

### 直近のカレンダーイベントを確認

```bash
gws calendar events list --calendarId primary --maxResults 5 --orderBy startTime --singleEvents true
```

### Drive の特定フォルダ内ファイルを検索

```bash
gws drive files list --q "'<folderId>' in parents and name contains 'invoice'"
```

### スプレッドシートのデータを JSON で取得

```bash
gws sheets spreadsheets values get --spreadsheetId <id> --range "Sheet1!A:Z"
```

---

## 注意事項

- **v1.0 未満**: 破壊的変更が入る可能性あり。本番運用前にバージョン固定を検討
- **非公式サポート**: Google の公式サポート対象外（"not an officially supported Google product"）
- **個人アカウント制限**: `@gmail.com` 個人アカウントでは `gws auth login` の一部スコープが使えない場合がある（issue #119）。Workspace アカウント推奨
- **Discovery Service 依存**: コマンド体系は実行時に動的生成されるため、オフライン環境では使用不可
- **MCP コンパクトモード**: ツール数が多いと LLM のコンテキストを圧迫するため、`--tool-mode compact` の使用を推奨

---

## 参考リンク

- GitHub: https://github.com/googleworkspace/cli
- npm: https://www.npmjs.com/package/@googleworkspace/cli
- Skills ドキュメント: https://github.com/googleworkspace/cli/blob/main/docs/skills.md
- リリース一覧: https://github.com/googleworkspace/cli/releases
