#!/bin/bash
# /usr/local/bin/refresh-gcp-token.sh
# GCPアクセストークンを更新してgatewayにconfig.apply
# Called by Workers cron trigger via sandbox.exec

# --- 更新頻度の制御（GCPトークンは1時間有効、期限切れ20分前に更新） ---
LAST_REFRESH_FILE="/tmp/gcp-token-last-refresh"
if [ -f "$LAST_REFRESH_FILE" ]; then
    LAST_EPOCH=$(cat "$LAST_REFRESH_FILE" 2>/dev/null || echo "0")
    NOW_EPOCH=$(date +%s)
    ELAPSED=$((NOW_EPOCH - LAST_EPOCH))
    if [ "$ELAPSED" -lt 2400 ]; then
        echo "GCP token still fresh (${ELAPSED}s elapsed, threshold: 2400s). Skipping."
        exit 0
    fi
fi

# --- Token取得（GCPキーをファイルから読み込み） ---
NEW_TOKEN=$(node -e "
const crypto = require('crypto');
const https = require('https');
const fs = require('fs');
let key;
const keyPath = '/root/.gcp-service-account.json';
if (require('fs').existsSync(keyPath)) {
    key = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
} else if (process.env.GCP_SERVICE_ACCOUNT_KEY) {
    key = JSON.parse(process.env.GCP_SERVICE_ACCOUNT_KEY);
} else {
    process.stderr.write('No GCP key available\n');
    process.exit(1);
}
function b64u(s){return Buffer.from(s).toString('base64').replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');}
const now=Math.floor(Date.now()/1000);
const h=b64u(JSON.stringify({alg:'RS256',typ:'JWT'}));
const c=b64u(JSON.stringify({iss:key.client_email,scope:'https://www.googleapis.com/auth/cloud-platform',aud:'https://oauth2.googleapis.com/token',exp:now+3600,iat:now}));
const sign=crypto.createSign('RSA-SHA256');
sign.update(h+'.'+c);
const sig=sign.sign(key.private_key,'base64').replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
const jwt=h+'.'+c+'.'+sig;
const body='grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion='+jwt;
const req=https.request({hostname:'oauth2.googleapis.com',path:'/token',method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','Content-Length':body.length}},res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>{const r=JSON.parse(d);if(r.access_token){process.stdout.write(r.access_token);process.stderr.write('expires_in='+r.expires_in);}else{process.stderr.write('token error: '+d);process.exit(1);}});});
req.write(body);req.end();
" 2>/tmp/gcp-token-debug.log)

if [ -z "$NEW_TOKEN" ]; then
    echo "ERROR: GCP token refresh failed"
    exit 1
fi

# --- GW_TOKEN取得（disk書き込み前に取得）---
GW_TOKEN=$(node -e "try{const c=JSON.parse(require('fs').readFileSync('/root/.openclaw/openclaw.json','utf8'));process.stdout.write(c.gateway&&c.gateway.auth&&c.gateway.auth.token||'')}catch(e){}" 2>/dev/null)

# --- openclaw.json更新 + baseHash計算（disk書き込み前にSHA256計算してconfig.get廃止）---
APPLY_PAYLOAD=$(node -e "
const crypto = require('crypto');
const fs = require('fs');
const configPath = '/root/.openclaw/openclaw.json';
const token = process.argv[1];
try {
    // 変更前のrawを読み込みSHA256計算（サーバーのin-memory snapshotHashと一致）
    const rawBefore = fs.readFileSync(configPath, 'utf8');
    const baseHash = crypto.createHash('sha256').update(rawBefore).digest('hex');

    // tokenをメモリ上で更新（diskには書き込まない — サーバーがconfig.apply成功時に書き込む）
    const config = JSON.parse(rawBefore);
    if (!config.models) config.models = {};
    if (!config.models.providers) config.models.providers = {};
    if (!config.models.providers['cf-ai-gw-google-0']) {
        // openclaw doctor が削除した場合の再構築
        config.models.providers['cf-ai-gw-google-0'] = {
            baseUrl: 'https://aiplatform.googleapis.com/v1/projects/scrap-database-449306/locations/global/publishers/google',
            api: 'google-generative-ai',
            models: [{ id: 'gemini-3-flash-preview', name: 'gemini-3-flash-preview', reasoning: true, input: ['text', 'image'], contextWindow: 131072, maxTokens: 8192 }],
            headers: { 'Authorization': 'Bearer ' + token },
            apiKey: token
        };
    } else {
        if (config.models.providers['cf-ai-gw-google-0'].headers) {
            config.models.providers['cf-ai-gw-google-0'].headers.Authorization = 'Bearer ' + token;
        }
        config.models.providers['cf-ai-gw-google-0'].apiKey = token;
    }

    // フォールバック用に更新済みconfigをtempfileへ書き込み（実際のconfigは更新しない）
    fs.writeFileSync('/tmp/gcp-config-updated.json', JSON.stringify(config, null, 2));

    // config.apply用ペイロード（discord/gateway除外）
    const applyConfig = Object.assign({}, config);
    delete applyConfig.discord;
    delete applyConfig.gateway;
    delete applyConfig.plugins;
    process.stdout.write(JSON.stringify({ raw: JSON.stringify(applyConfig), baseHash: baseHash }));
} catch(e) {
    process.stderr.write('Failed: ' + e.message + '\n');
    process.exit(1);
}
" "$NEW_TOKEN" 2>/tmp/config-update-debug.log)

if [ -z "$APPLY_PAYLOAD" ]; then
    echo "ERROR: Config update failed"
    cat /tmp/config-update-debug.log | head -3
    exit 1
fi

# --- ゲートウェイのメモリ上の設定を強制更新（config.getなし）---
# diskには書き込まない — config.apply成功時はサーバーが書き込む
# config.apply失敗時はフォールバックとしてdiskに書き込み、exit 2でcronにgateway再起動を指示
APPLY_SUCCESS=0
if [ -n "$GW_TOKEN" ]; then
    APPLY_OUT=$(openclaw gateway call config.apply \
        --url ws://localhost:18789 \
        --token "$GW_TOKEN" \
        --params "$APPLY_PAYLOAD" </dev/null 2>&1)
    APPLY_RC=$?
    if [ $APPLY_RC -eq 0 ]; then
        echo "config.apply succeeded"
        APPLY_SUCCESS=1
    else
        echo "WARNING: config.apply failed (rc=$APPLY_RC)"
        echo "$APPLY_OUT" | head -3
        # フォールバック: 更新済みconfigをdiskに書き込み（次のgateway起動時に反映）
        if [ -f /tmp/gcp-config-updated.json ]; then
            cp /tmp/gcp-config-updated.json /root/.openclaw/openclaw.json
            echo "Fallback: wrote updated config to disk"
        fi
    fi
else
    echo "WARNING: Could not read gateway token for config.apply"
    # gateway未起動: diskに書き込み（起動時に反映）
    if [ -f /tmp/gcp-config-updated.json ]; then
        cp /tmp/gcp-config-updated.json /root/.openclaw/openclaw.json
        echo "Fallback: wrote updated config to disk (no gateway token)"
    fi
fi

# Always write timestamp
date +%s > "$LAST_REFRESH_FILE"

# --- expires_in をログ出力 ---
if [ -f /tmp/gcp-token-debug.log ]; then
    cat /tmp/gcp-token-debug.log
fi

echo "GCP token refreshed at $(date)"

# Exit code signals cron handler:
# 0 = fully applied to running gateway (server wrote config + triggered SIGUSR1 restart)
# 2 = token written to disk but gateway needs restart to load it
if [ "$APPLY_SUCCESS" -eq 1 ]; then
    exit 0
else
    exit 2
fi
