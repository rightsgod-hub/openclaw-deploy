#!/bin/bash
# /usr/local/bin/refresh-gcp-token.sh
# GCPアクセストークンを更新してgatewayにconfig.apply
# Called by Workers cron trigger via sandbox.exec

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
const req=https.request({hostname:'oauth2.googleapis.com',path:'/token',method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','Content-Length':body.length}},res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>{const r=JSON.parse(d);if(r.access_token){process.stdout.write(r.access_token);}else{process.stderr.write('token error: '+d);process.exit(1);}});});
req.write(body);req.end();
" 2>/dev/null)

if [ -z "$NEW_TOKEN" ]; then
    echo "ERROR: GCP token refresh failed"
    exit 1
fi

# --- openclaw.json更新 ---
node -e "
const fs = require('fs');
const configPath = '/root/.openclaw/openclaw.json';
try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const token = process.argv[1];
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
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    console.log('Config updated with refreshed GCP token');
} catch(e) {
    console.error('Failed to update config:', e.message);
    process.exit(1);
}
" "$NEW_TOKEN"

# --- config.apply でgatewayメモリ更新 ---
GATEWAY_TOKEN="${OPENCLAW_GATEWAY_TOKEN:-$MOLTBOT_GATEWAY_TOKEN}"
if [ -n "$GATEWAY_TOKEN" ]; then
    openclaw gateway call config.apply \
        --url ws://localhost:18789 \
        --token "$GATEWAY_TOKEN" </dev/null 2>&1 | head -3 || true
fi

echo "GCP token refreshed at $(date)"
