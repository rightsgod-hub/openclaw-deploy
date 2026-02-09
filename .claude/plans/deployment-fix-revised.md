# OpenClaw Moltworker デプロイ修正 実装プラン（修正版）

**作成日**: 2026-02-08
**修正理由**: Browser Rendering APIはFreeプランでも利用可能（誤情報を訂正）

---

## Context

### 問題の背景

OpenClaw Moltworkerは、Cloudflare Workers上でサンドボックス化されたAIエージェントを実行するアプリケーションです。現在、GitHub ActionsでCloudflare Workersへのデプロイ時に`Unauthorized`エラーが発生し、デプロイが失敗しています。

この問題は、単純なAPI Token権限不足ではなく、**アプリケーションが起動時に要求する必須シークレット**（Cloudflare AccessやAI Gateway設定）が未設定であることが根本原因です。

### 根本原因

コードベースの分析（`src/index.ts:56-92`）により、以下の必須依存関係が判明:

1. **認証レイヤー（必須）**:
   - `CF_ACCESS_TEAM_DOMAIN` - Admin UI認証用のCloudflare Zero Trust Team Domain
   - `CF_ACCESS_AUD` - JWT検証用のAccess Application Audience
   - `MOLTBOT_GATEWAY_TOKEN` - Control UIアクセス用のゲートウェイトークン

2. **AIプロバイダーレイヤー（以下のいずれか1つが必須）**:
   - Cloudflare AI Gateway: `CLOUDFLARE_AI_GATEWAY_API_KEY` + `CF_AI_GATEWAY_ACCOUNT_ID` + `CF_AI_GATEWAY_GATEWAY_ID`
   - 直接Anthropic: `ANTHROPIC_API_KEY`
   - 直接OpenAI: `OPENAI_API_KEY`

現在の設定では、Gemini API Keyは設定済み（`CLOUDFLARE_AI_GATEWAY_API_KEY`）ですが、AI Gateway IDとAccount IDが不足しています。

### 現在の設定状況

**設定済み（`.env`より）**:
- `CLOUDFLARE_API_TOKEN`: デプロイ用APIトークン
- `CLOUDFLARE_ACCOUNT_ID`: 47c17c4aa5a04891a4e412b5ebbc49b1
- `CLOUDFLARE_AI_GATEWAY_API_KEY`: Gemini API Key
- `CF_AI_GATEWAY_MODEL`: google/gemini-1.5-flash

**未設定（必須）**:
- `CF_ACCESS_TEAM_DOMAIN` - Cloudflare Zero Trustから取得
- `CF_ACCESS_AUD` - Access Applicationから取得
- `MOLTBOT_GATEWAY_TOKEN` - openssl rand -hex 32で生成
- `CF_AI_GATEWAY_GATEWAY_ID` - Cloudflare AI Gatewayから取得
- `CF_AI_GATEWAY_ACCOUNT_ID` - Account IDと同じ値

**参考資料**:
- 引き継ぎファイル: `_local/引き継ぎ_デプロイ修正.md`
- 公式リポジトリ: https://github.com/cloudflare/moltworker

---

## 前提条件（修正版）

### Cloudflare Workers プラン要件

**Freeプランで動作します**:
- Browser Rendering API: 10分/日、3並行ブラウザ
- テスト・開発用途には十分

**Paidプラン推奨**（$5/月）:
- Browser Rendering API: 10時間/月、10並行ブラウザ
- 本番運用・頻繁な利用に推奨
- 超過分: $0.09/時間

**参考**: [Cloudflare Browser Rendering Pricing](https://developers.cloudflare.com/browser-rendering/pricing/)

### Cloudflare Accessが必須な理由

**目的**: Admin UI（`/_admin/`）をあなた専用にする

- **Admin UIで何ができる？**
  - デバイスペアリング承認
  - 未承認デバイスの削除
  - Gateway設定の確認

- **保護しないとどうなる？**
  - 誰でも`/_admin/`にアクセス可能
  - 勝手にデバイス承認される
  - あなたのGemini API使い放題

- **Cloudflare Accessの役割**
  - メール認証でログイン画面を追加
  - あなたのメールアドレスだけアクセス可能にする
  - JWT検証でセキュリティ確保

- **コード上の必須要件**（src/index.ts:64-73）
  - `CF_ACCESS_TEAM_DOMAIN`と`CF_ACCESS_AUD`が未設定
  - → 500 Internal Server Error
  - → Admin UI動作不可 → デバイス承認不可

- **プラン**: Cloudflare Zero Trust **Freeプラン**で動作（50ユーザーまで無料）

- **管理画面が違う理由**
  - Cloudflare Dashboard (dash.cloudflare.com): Workers、DNS、AI Gateway
  - Zero Trust Dashboard (one.dash.cloudflare.com): **アクセス制御専用**
  - Zero Trustは元々別製品（2020年統合、ダッシュボードは別々のまま）

---

## 実装手順

### Phase 0: 事前確認（ブラウザ操作 - 必須）

**目的**: API Token権限確認のみ

#### API Token権限確認

**ユーザー操作**:
1. Cloudflare Dashboard → Profile → API Tokens
2. トークン末尾`...x32x`を選択
3. 権限を確認:
   - ✅ Account - Cloudflare Workers Script: Edit（必須）
   - ✅ Account - Workers R2 Storage: Edit（推奨）
   - ⚠️ User - User Details: Read（推奨追加）
   - ⚠️ Zone - Zone: Read（推奨追加）

**不足の場合**: トークンを再生成 → `.env`更新 → GitHub Secrets更新

---

### Phase 1: Cloudflare Access設定（ブラウザ + CLI - 必須）

**目的**: Admin UI認証レイヤーの設定

#### 1-1. Zero Trust初期設定

**ユーザー操作**:
1. Cloudflare Dashboard → Zero Trust
2. 初回の場合: Team Domain設定（例: `myteam.cloudflareaccess.com`）
3. Team Domainをメモ

#### 1-2. Access Application作成

**ユーザー操作**:
1. Zero Trust → Access → Applications → Add an Application → Self-hosted
2. 設定:
   - Application name: `moltbot-sandbox`
   - Application domain: `moltbot-sandbox.YOUR_SUBDOMAIN.workers.dev`（暫定値）
   - Identity Provider: One-time PIN（メール認証）またはGoogle
3. Policy設定:
   - Policy name: `Admin Only`
   - Action: Allow
   - Include: Emails → ユーザーのメールアドレス追加
4. Application Audience (AUD)をメモ

#### 1-3. シークレット設定

**Claude Code実行（Bash）**:
```bash
export CLOUDFLARE_API_TOKEN=ZFs-Nrw2CGRfiq7WEOnp8U7kKVUSXFm26wRjx32x

echo "USER_PROVIDED_TEAM_DOMAIN" | npx wrangler secret put CF_ACCESS_TEAM_DOMAIN
echo "USER_PROVIDED_AUD" | npx wrangler secret put CF_ACCESS_AUD
```

**検証**:
```bash
npx wrangler secret list | grep -E "CF_ACCESS"
```

**エラー時の対処**: Phase 0で権限確認、トークン再生成

---

### Phase 2: AI Gateway設定（ブラウザ + CLI - 必須）

**目的**: Gemini API Gateway接続設定

#### 2-1. AI Gateway確認/作成

**ユーザー操作**:
1. Cloudflare Dashboard → AI → AI Gateway
2. 既存Gatewayがあれば: Gateway名クリック → Overview → Gateway IDメモ
3. なければ:
   - "Create Gateway"クリック
   - Gateway name: `openclaw-gateway`
   - Provider Keys → Google AI Studio → Gemini API Key貼り付け
   - Overview → Gateway IDメモ

#### 2-2. シークレット設定

**Claude Code実行（Bash）**:
```bash
export CLOUDFLARE_API_TOKEN=ZFs-Nrw2CGRfiq7WEOnp8U7kKVUSXFm26wRjx32x

echo "USER_PROVIDED_GATEWAY_ID" | npx wrangler secret put CF_AI_GATEWAY_GATEWAY_ID
echo "47c17c4aa5a04891a4e412b5ebbc49b1" | npx wrangler secret put CF_AI_GATEWAY_ACCOUNT_ID
echo "AIzaSyAVcrAkHlBiYRriKYjgoy8LP7B3yQspaus" | npx wrangler secret put CLOUDFLARE_AI_GATEWAY_API_KEY
```

**検証**:
```bash
npx wrangler secret list | grep -E "CF_AI_GATEWAY|CLOUDFLARE_AI_GATEWAY"
```

---

### Phase 3: Gateway Token生成（CLI - 必須）

**目的**: Control UIアクセス用トークン生成

**Claude Code実行（Bash）**:
```bash
MOLTBOT_GATEWAY_TOKEN=$(openssl rand -hex 32)

echo "🔑 重要: このトークンをControl UIアクセス時に使用します"
echo "Token: $MOLTBOT_GATEWAY_TOKEN"
echo ""
echo "このトークンを安全に保存してください"

echo "$MOLTBOT_GATEWAY_TOKEN" | npx wrangler secret put MOLTBOT_GATEWAY_TOKEN
```

**検証**:
```bash
npx wrangler secret list | grep MOLTBOT_GATEWAY_TOKEN
```

**ユーザーへの指示**: トークンをメモ帳やパスワードマネージャーに保存

---

### Phase 4: .env更新（手動 - オプション）

**ユーザー操作**: `.env`に以下を追加（ローカル開発用）

```bash
# AI Gateway完全設定
CF_AI_GATEWAY_ACCOUNT_ID=47c17c4aa5a04891a4e412b5ebbc49b1
CF_AI_GATEWAY_GATEWAY_ID=Phase2で取得した値

# Gateway Token
MOLTBOT_GATEWAY_TOKEN=Phase3で生成した値

# Cloudflare Access
CF_ACCESS_TEAM_DOMAIN=Phase1で取得した値
CF_ACCESS_AUD=Phase1で取得した値
```

---

### Phase 5: GitHub Secrets確認（ブラウザ - 必須）

**目的**: GitHub Actionsのデプロイ認証情報確認

**ユーザー操作**:
1. GitHub: `https://github.com/rightsgod-hub/openclaw-deploy/settings/secrets/actions`
2. 確認:
   - `CLOUDFLARE_API_TOKEN` - 存在するか確認
   - 未設定の場合: New repository secret → 名前 `CLOUDFLARE_API_TOKEN`、値 `.env`の値

---

### Phase 6: シークレット総合検証（CLI - 必須）

**目的**: 全シークレット設定を確認

**Claude Code実行（Bash）**:
```bash
echo "=== Wrangler Secrets検証 ==="
npx wrangler secret list

echo ""
echo "=== 必須シークレット確認 ==="
echo "以下の6つのシークレットが表示されていることを確認:"
echo "  1. CLOUDFLARE_AI_GATEWAY_API_KEY"
echo "  2. CF_AI_GATEWAY_ACCOUNT_ID"
echo "  3. CF_AI_GATEWAY_GATEWAY_ID"
echo "  4. MOLTBOT_GATEWAY_TOKEN"
echo "  5. CF_ACCESS_TEAM_DOMAIN"
echo "  6. CF_ACCESS_AUD"
```

---

### Phase 7: GitHub Actionsデプロイ（CLI/ブラウザ - 必須）

**目的**: デプロイ実行と成功確認

#### 7-1. デプロイトリガー

**Claude Code実行（Bash）**:
```bash
cd /Users/scrap_y-yoshida/Desktop/Antigravity/Openclow
gh workflow run deploy.yml

echo ""
echo "デプロイを開始しました。以下のURLで進捗を確認できます:"
echo "https://github.com/rightsgod-hub/openclaw-deploy/actions"
```

**代替（gh CLI未認証の場合）**:
- ユーザーがGitHub → Actions → Deploy → Run workflowを手動実行

#### 7-2. デプロイ監視

**ユーザー操作**:
1. GitHub Actions画面でワークフロー実行を確認
2. 成功指標:
   - ✅ 全ステップが緑チェック
   - ✅ ログに"Built successfully"
   - ✅ ログに"Deployed moltbot-sandbox"

#### 7-3. エラー時の診断

| エラー | 原因 | 対処 |
|-------|------|------|
| `Unauthorized` | GitHub Secrets未設定 | Phase 5確認 |
| `Authentication error` | API Token権限不足 | Phase 0確認、トークン再生成 |

---

### Phase 8: 動作確認（ブラウザ + CLI - 必須）

**目的**: デプロイ成功とアプリケーション機能確認

#### 8-1. デプロイURL取得

**Claude Code実行（Bash）**:
```bash
cd /Users/scrap_y-yoshida/Desktop/Antigravity/Openclow
npx wrangler deployments list
```

**期待される出力**:
```
URL: https://moltbot-sandbox.YOUR_SUBDOMAIN.workers.dev
```

#### 8-2. ヘルスチェック

**Claude Code実行（Bash）**:
```bash
curl https://moltbot-sandbox.YOUR_SUBDOMAIN.workers.dev/sandbox-health
```

**期待される応答**: `{"status":"ok"}`

#### 8-3. Control UIアクセステスト

**ユーザー操作**:
1. ブラウザで開く: `https://moltbot-sandbox.YOUR_SUBDOMAIN.workers.dev/?token=MOLTBOT_GATEWAY_TOKEN`
2. Cloudflare Accessのログイン画面が表示される
3. メール認証またはGoogleでログイン
4. 1-2分待機（コールドスタート）
5. Control UIが表示される

#### 8-4. Admin UIアクセステスト

**ユーザー操作**:
1. ブラウザで開く: `https://moltbot-sandbox.YOUR_SUBDOMAIN.workers.dev/_admin/`
2. Cloudflare Access認証を通過
3. Admin UIが表示される
4. "Devices"セクションを確認

#### 8-5. デバイスペアリング

**ユーザー操作**:
1. Control UIでテストメッセージ送信（保留状態になる）
2. Admin UI → Devices → 保留中のデバイスを"Approve"
3. Control UIに戻る
4. 接続確立メッセージを確認

#### 8-6. 機能テスト

**ユーザー操作**:
1. Control UIでメッセージ送信: "Hello, can you hear me?"
2. Geminiからの応答を確認（10-30秒以内）
3. 初回は1-2分かかる可能性あり（コールドスタート）

**成功基準**:
- ✅ Health endpointが200 OK
- ✅ Control UIロード成功
- ✅ Cloudflare Access認証動作
- ✅ デバイスペアリング完了
- ✅ Gemini応答受信

---

## トラブルシューティング

### Wrangler認証エラー

**症状**: `Authentication error [code: 10000]`

**対処**:
1. 環境変数確認: `echo $CLOUDFLARE_API_TOKEN`
2. Phase 0でAPI Token権限再確認
3. トークン再生成 → `.env`更新 → 再度`export`

**代替手段**: Cloudflare Dashboard → Workers & Pages → [Worker] → Settings → Variablesでシークレット手動設定

### デプロイ後の応答なし

**症状**: Control UIが応答しない

**対処**:
1. Admin UIでデバイス承認済みか確認
2. ブラウザコンソールでエラー確認
3. 1-2分待機（コールドスタート）
4. AI Gateway設定を再確認（Phase 2）

---

## Critical Files

実装・デバッグで参照するファイル:

- `src/index.ts:56-92` - シークレット検証ロジック（起動時チェック）
- `src/auth/middleware.ts:49-151` - Cloudflare Access認証実装
- `src/types.ts:6-45` - 環境変数インターフェース定義
- `wrangler.jsonc:74-103` - シークレット一覧コメント
- `.github/workflows/deploy.yml:26-40` - GitHub Actionsデプロイフロー

---

## Verification

実装完了後の検証項目:

### デプロイ成功検証
- [ ] GitHub Actionsワークフローが緑チェック
- [ ] エラーログなし
- [ ] Worker URLアクセス可能

### ランタイム成功検証
- [ ] Control UIロード（`/?token=...`）
- [ ] Cloudflare Access認証動作
- [ ] デバイスペアリング完了
- [ ] Gemini応答（30秒以内）

### 運用成功検証
- [ ] Admin UIアクセス可能（`/_admin/`）
- [ ] Gateway status "running"表示
- [ ] ブラウザコンソールにエラーなし

---

## Notes

- **所要時間**: 約60分（Phase 0-8全体）
- **前提条件**: Cloudflare Workers アカウント（Freeプランで動作、Paid推奨）
- **Browser Rendering API**: Freeで10分/日、Paidで10時間/月
- **オプション機能**: R2 Storage（引き継ぎファイルPhase 6参照、データ永続化用）
- **セキュリティ**: `.env`ファイルはGit追跡外（`.gitignore`で保護済み）
- **引き継ぎ元**: `_local/引き継ぎ_デプロイ修正.md`を実装プランに変換

---

**作成者**: Claude Sonnet 4.5
**修正日**: 2026-02-08
**修正理由**: Browser Rendering APIの価格体系を正確に反映
