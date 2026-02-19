#!/bin/bash
# Startup script for OpenClaw in Cloudflare Sandbox
# This script:
# 1. Restores config from R2 backup if available
# 2. Runs openclaw onboard --non-interactive to configure from env vars
# 3. Patches config for features onboard doesn't cover (channels, gateway auth)
# 4. Starts the gateway

set -e

if pgrep -f "openclaw gateway" > /dev/null 2>&1; then
    echo "OpenClaw gateway is already running, exiting."
    exit 0
fi

CONFIG_DIR="/root/.openclaw"
CONFIG_FILE="$CONFIG_DIR/openclaw.json"
BACKUP_DIR="/data/moltbot"

echo "Config directory: $CONFIG_DIR"
echo "Backup directory: $BACKUP_DIR"

mkdir -p "$CONFIG_DIR"

# ============================================================
# RESTORE FROM R2 BACKUP
# ============================================================

should_restore_from_r2() {
    local R2_SYNC_FILE="$BACKUP_DIR/.last-sync"
    local LOCAL_SYNC_FILE="$CONFIG_DIR/.last-sync"

    if [ ! -f "$R2_SYNC_FILE" ]; then
        echo "No R2 sync timestamp found, skipping restore"
        return 1
    fi

    if [ ! -f "$LOCAL_SYNC_FILE" ]; then
        echo "No local sync timestamp, will restore from R2"
        return 0
    fi

    R2_TIME=$(cat "$R2_SYNC_FILE" 2>/dev/null)
    LOCAL_TIME=$(cat "$LOCAL_SYNC_FILE" 2>/dev/null)

    echo "R2 last sync: $R2_TIME"
    echo "Local last sync: $LOCAL_TIME"

    R2_EPOCH=$(date -d "$R2_TIME" +%s 2>/dev/null || echo "0")
    LOCAL_EPOCH=$(date -d "$LOCAL_TIME" +%s 2>/dev/null || echo "0")

    if [ "$R2_EPOCH" -gt "$LOCAL_EPOCH" ]; then
        echo "R2 backup is newer, will restore"
        return 0
    else
        echo "Local data is newer or same, skipping restore"
        return 1
    fi
}

# Check for backup data in new openclaw/ prefix first, then legacy clawdbot/ prefix
if [ -f "$BACKUP_DIR/openclaw/openclaw.json" ]; then
    if should_restore_from_r2; then
        echo "Restoring from R2 backup at $BACKUP_DIR/openclaw..."
        cp -a "$BACKUP_DIR/openclaw/." "$CONFIG_DIR/"
        cp -f "$BACKUP_DIR/.last-sync" "$CONFIG_DIR/.last-sync" 2>/dev/null || true
        echo "Restored config from R2 backup"
    fi
elif [ -f "$BACKUP_DIR/clawdbot/clawdbot.json" ]; then
    # Legacy backup format — migrate .clawdbot data into .openclaw
    if should_restore_from_r2; then
        echo "Restoring from legacy R2 backup at $BACKUP_DIR/clawdbot..."
        cp -a "$BACKUP_DIR/clawdbot/." "$CONFIG_DIR/"
        cp -f "$BACKUP_DIR/.last-sync" "$CONFIG_DIR/.last-sync" 2>/dev/null || true
        # Rename the config file if it has the old name
        if [ -f "$CONFIG_DIR/clawdbot.json" ] && [ ! -f "$CONFIG_FILE" ]; then
            mv "$CONFIG_DIR/clawdbot.json" "$CONFIG_FILE"
        fi
        echo "Restored and migrated config from legacy R2 backup"
    fi
elif [ -f "$BACKUP_DIR/clawdbot.json" ]; then
    # Very old legacy backup format (flat structure)
    if should_restore_from_r2; then
        echo "Restoring from flat legacy R2 backup at $BACKUP_DIR..."
        cp -a "$BACKUP_DIR/." "$CONFIG_DIR/"
        cp -f "$BACKUP_DIR/.last-sync" "$CONFIG_DIR/.last-sync" 2>/dev/null || true
        if [ -f "$CONFIG_DIR/clawdbot.json" ] && [ ! -f "$CONFIG_FILE" ]; then
            mv "$CONFIG_DIR/clawdbot.json" "$CONFIG_FILE"
        fi
        echo "Restored and migrated config from flat legacy R2 backup"
    fi
elif [ -d "$BACKUP_DIR" ]; then
    echo "R2 mounted at $BACKUP_DIR but no backup data found yet"
else
    echo "R2 not mounted, starting fresh"
fi

# Restore workspace from R2 backup if available (only if R2 is newer)
# This includes IDENTITY.md, USER.md, MEMORY.md, memory/, and assets/
WORKSPACE_DIR="/root/clawd"
if [ -d "$BACKUP_DIR/workspace" ] && [ "$(ls -A $BACKUP_DIR/workspace 2>/dev/null)" ]; then
    if should_restore_from_r2; then
        echo "Restoring workspace from $BACKUP_DIR/workspace..."
        mkdir -p "$WORKSPACE_DIR"
        cp -a "$BACKUP_DIR/workspace/." "$WORKSPACE_DIR/"
        echo "Restored workspace from R2 backup"
    fi
fi

# Restore skills from R2 backup if available (only if R2 is newer)
SKILLS_DIR="/root/clawd/skills"
if [ -d "$BACKUP_DIR/skills" ] && [ "$(ls -A $BACKUP_DIR/skills 2>/dev/null)" ]; then
    if should_restore_from_r2; then
        echo "Restoring skills from $BACKUP_DIR/skills..."
        mkdir -p "$SKILLS_DIR"
        cp -a "$BACKUP_DIR/skills/." "$SKILLS_DIR/"
        echo "Restored skills from R2 backup"
    fi
fi

# ============================================================
# ONBOARD (only if no config exists yet)
# ============================================================
if [ ! -f "$CONFIG_FILE" ]; then
    echo "No existing config found, running openclaw onboard..."

    AUTH_ARGS=""
    if [ -n "$CLOUDFLARE_AI_GATEWAY_API_KEY" ] && [ -n "$CF_AI_GATEWAY_ACCOUNT_ID" ] && [ -n "$CF_AI_GATEWAY_GATEWAY_ID" ]; then
        AUTH_ARGS="--auth-choice cloudflare-ai-gateway-api-key \
            --cloudflare-ai-gateway-account-id $CF_AI_GATEWAY_ACCOUNT_ID \
            --cloudflare-ai-gateway-gateway-id $CF_AI_GATEWAY_GATEWAY_ID \
            --cloudflare-ai-gateway-api-key $CLOUDFLARE_AI_GATEWAY_API_KEY"
    elif [ -n "$ANTHROPIC_API_KEY" ]; then
        AUTH_ARGS="--auth-choice apiKey --anthropic-api-key $ANTHROPIC_API_KEY"
    elif [ -n "$OPENAI_API_KEY" ]; then
        AUTH_ARGS="--auth-choice openai-api-key --openai-api-key $OPENAI_API_KEY"
    fi

    openclaw onboard --non-interactive --accept-risk \
        --mode local \
        $AUTH_ARGS \
        --gateway-port 18789 \
        --gateway-bind lan \
        --skip-channels \
        --skip-skills \
        --skip-health

    echo "Onboard completed"
else
    echo "Using existing config"
fi

# ============================================================
# PATCH CONFIG (channels, gateway auth, trusted proxies)
# ============================================================
# FETCH GCP ACCESS TOKEN (must be before patch so token is available)
# ============================================================
fetch_gcp_token() {
    node -e "
const crypto = require('crypto');
const https = require('https');
const key = JSON.parse(process.env.GCP_SERVICE_ACCOUNT_KEY);
function b64u(s){return Buffer.from(s).toString('base64').replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');}
const now=Math.floor(Date.now()/1000);
const h=b64u(JSON.stringify({alg:'RS256',typ:'JWT'}));
const c=b64u(JSON.stringify({iss:key.client_email,scope:'https://www.googleapis.com/auth/cloud-platform',aud:'https://oauth2.googleapis.com/token',exp:now+3600,iat:now}));
const sign=crypto.createSign('RSA-SHA256');
sign.update(h+'.'+c);
const sig=sign.sign(key.private_key,'base64').replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
const jwt=h+'.'+c+'.'+sig;
const body='grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion='+jwt;
const req=https.request({hostname:'oauth2.googleapis.com',path:'/token',method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','Content-Length':body.length}},res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>{const r=JSON.parse(d);if(r.access_token){process.stdout.write(r.access_token);}else{process.stderr.write('token error: '+d);}});});
req.write(body);req.end();
" 2>/dev/null
}

if [ -n "$GCP_SERVICE_ACCOUNT_KEY" ] && [ "$USE_VERTEX_AI" = "true" ]; then
    echo "Fetching GCP access token for Vertex AI..."
    GCP_ACCESS_TOKEN=$(fetch_gcp_token)
    if [ -n "$GCP_ACCESS_TOKEN" ]; then
        export GCP_ACCESS_TOKEN
        echo "GCP access token obtained successfully"
    else
        echo "WARNING: Failed to obtain GCP access token"
    fi
fi

# ============================================================
# openclaw onboard handles provider/model config, but we need to patch in:
# - Channel config (Telegram, Discord, Slack)
# - Gateway token auth
# - Trusted proxies for sandbox networking
# - Base URL override for legacy AI Gateway path
node << 'EOFPATCH'
const fs = require('fs');

const configPath = '/root/.openclaw/openclaw.json';
console.log('Patching config at:', configPath);
let config = {};

try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (e) {
    console.log('Starting with empty config');
}

config.gateway = config.gateway || {};
config.channels = config.channels || {};

// Gateway configuration
config.gateway.port = 18789;
config.gateway.mode = 'local';
config.gateway.trustedProxies = ['10.1.0.0'];

if (process.env.OPENCLAW_GATEWAY_TOKEN) {
    config.gateway.auth = config.gateway.auth || {};
    config.gateway.auth.token = process.env.OPENCLAW_GATEWAY_TOKEN;
}

if (process.env.OPENCLAW_DEV_MODE === 'true') {
    config.gateway.controlUi = config.gateway.controlUi || {};
    config.gateway.controlUi.allowInsecureAuth = true;
}

// Legacy AI Gateway base URL override:
// ANTHROPIC_BASE_URL is picked up natively by the Anthropic SDK,
// so we don't need to patch the provider config. Writing a provider
// entry without a models array breaks OpenClaw's config validation.

// AI Gateway model override
// Supports single model (CF_AI_GATEWAY_MODEL) or multiple models (CF_AI_GATEWAY_MODELS)
// Multiple models example: CF_AI_GATEWAY_MODELS=google/gemini-2.5-flash-lite,google/gemini-2.5-flash,google/gemma-3-12b
// First model in list becomes primary, others available as fallbacks in Control UI
const modelList = process.env.CF_AI_GATEWAY_MODELS
    ? process.env.CF_AI_GATEWAY_MODELS.split(',').map(m => m.trim())
    : process.env.CF_AI_GATEWAY_MODEL
    ? [process.env.CF_AI_GATEWAY_MODEL]
    : [];

const accountId = process.env.CF_AI_GATEWAY_ACCOUNT_ID;
const gatewayId = process.env.CF_AI_GATEWAY_GATEWAY_ID;
const apiKey = process.env.CLOUDFLARE_AI_GATEWAY_API_KEY;

const hasVertexCreds = process.env.USE_VERTEX_AI === 'true' && process.env.GCP_PROJECT_ID && process.env.GCP_SERVICE_ACCOUNT_KEY;
if (modelList.length > 0 && (apiKey || hasVertexCreds)) {
    config.models = config.models || {};
    config.models.providers = config.models.providers || {};

    let primaryModel = null;

    modelList.forEach((raw, idx) => {
        const slashIdx = raw.indexOf('/');
        const gwProvider = raw.substring(0, slashIdx);
        const modelId = raw.substring(slashIdx + 1);

        let baseUrl;
        const useVertexAI = process.env.USE_VERTEX_AI === 'true' && process.env.GCP_PROJECT_ID && process.env.GCP_SERVICE_ACCOUNT_KEY;

        if (gwProvider.includes('google') && useVertexAI) {
            // Vertex AI (enterprise Google Cloud)
            // gemini-3-* models are global-only; other models use regional endpoint
            const region = process.env.GCP_REGION || 'us-central1';
            const projectId = process.env.GCP_PROJECT_ID;
            const isGlobalModel = modelId.startsWith('gemini-3') || region === 'global';
            if (isGlobalModel) {
                baseUrl = 'https://aiplatform.googleapis.com/v1/projects/' + projectId + '/locations/global/publishers/google';
            } else {
                baseUrl = 'https://' + region + '-aiplatform.googleapis.com/v1/projects/' + projectId + '/locations/' + region + '/publishers/google';
            }
            console.log('Using Vertex AI endpoint: ' + baseUrl);
        } else if (gwProvider.includes('google')) {
            // Direct Google API (bypasses AI Gateway for Gemini/Gemma)
            baseUrl = 'https://generativelanguage.googleapis.com/v1beta';
        } else if (accountId && gatewayId) {
            baseUrl = 'https://gateway.ai.cloudflare.com/v1/' + accountId + '/' + gatewayId + '/' + gwProvider;
            if (gwProvider === 'workers-ai') baseUrl += '/v1';
        } else if (gwProvider === 'workers-ai' && process.env.CF_ACCOUNT_ID) {
            baseUrl = 'https://api.cloudflare.com/client/v4/accounts/' + process.env.CF_ACCOUNT_ID + '/ai/v1';
        }

        if (baseUrl) {
            const api = gwProvider === 'anthropic' ? 'anthropic-messages' :
                        gwProvider.includes('google') ? 'google-generative-ai' :
                        'openai-completions';
            const providerName = 'cf-ai-gw-' + gwProvider + '-' + idx;

            const providerConfig = {
                baseUrl: baseUrl,
                api: api,
                models: [{
                    id: modelId,
                    name: modelId,
                    reasoning: true,
                    input: ['text', 'image'],
                    contextWindow: 131072,
                    maxTokens: 8192
                }],
            };

            // Authentication: Vertex AI uses Authorization: Bearer token (fetched before this patch)
            // apiKey is required by OpenClaw auth resolution (getCustomProviderApiKey check)
            // headers.Authorization overrides x-goog-api-key for Vertex AI REST API
            if (useVertexAI && gwProvider.includes('google')) {
                if (process.env.GCP_ACCESS_TOKEN) {
                    providerConfig.headers = { 'Authorization': 'Bearer ' + process.env.GCP_ACCESS_TOKEN };
                    providerConfig.apiKey = process.env.GCP_ACCESS_TOKEN;
                }
            } else {
                providerConfig.apiKey = apiKey;
            }

            config.models.providers[providerName] = providerConfig;

            if (idx === 0) {
                primaryModel = providerName + '/' + modelId;
            }

            console.log('Registered model ' + (idx + 1) + '/' + modelList.length + ': provider=' + providerName + ' model=' + modelId + ' via ' + baseUrl);
        }
    });

    if (primaryModel) {
        config.agents = config.agents || {};
        config.agents.defaults = config.agents.defaults || {};
        config.agents.defaults.model = { primary: primaryModel };
        console.log('Primary model set to: ' + primaryModel);
    }
} else if (modelList.length > 0) {
    console.warn('CF_AI_GATEWAY_MODEL(S) set but missing API key');
}

// Telegram configuration
// Overwrite entire channel object to drop stale keys from old R2 backups
// that would fail OpenClaw's strict config validation (see #47)
if (process.env.TELEGRAM_BOT_TOKEN) {
    const dmPolicy = process.env.TELEGRAM_DM_POLICY || 'pairing';
    config.channels.telegram = {
        botToken: process.env.TELEGRAM_BOT_TOKEN,
        enabled: true,
        dmPolicy: dmPolicy,
    };
    if (process.env.TELEGRAM_DM_ALLOW_FROM) {
        config.channels.telegram.allowFrom = process.env.TELEGRAM_DM_ALLOW_FROM.split(',');
    } else if (dmPolicy === 'open') {
        config.channels.telegram.allowFrom = ['*'];
    }
}

// Discord configuration
// Discord uses a nested dm object: dm.policy, dm.allowFrom (per DiscordDmConfig)
if (process.env.DISCORD_BOT_TOKEN) {
    const dmPolicy = process.env.DISCORD_DM_POLICY || 'pairing';
    const dm = { policy: dmPolicy };
    if (dmPolicy === 'open') {
        dm.allowFrom = ['*'];
    }
    config.channels.discord = {
        token: process.env.DISCORD_BOT_TOKEN,
        enabled: true,
        dm: dm,
    };
}

// Slack configuration
if (process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN) {
    config.channels.slack = {
        botToken: process.env.SLACK_BOT_TOKEN,
        appToken: process.env.SLACK_APP_TOKEN,
        enabled: true,
    };
}

fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
console.log('Configuration patched successfully');
EOFPATCH

# ============================================================
# START GATEWAY
# ============================================================
echo "Starting OpenClaw Gateway..."
echo "Gateway will be available on port 18789"

echo "Dev mode: ${OPENCLAW_DEV_MODE:-false}"

# Token refresh loop helper: update config with new token and restart gateway
refresh_and_restart() {
    local new_token
    new_token=$(fetch_gcp_token)
    if [ -z "$new_token" ]; then
        echo "WARNING: GCP token refresh failed, gateway continues with expired token"
        return
    fi
    export GCP_ACCESS_TOKEN="$new_token"
    echo "GCP token refreshed at $(date)"

    # Update openclaw.json with new token
    node -e "
const fs = require('fs');
const configPath = '/root/.openclaw/openclaw.json';
try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const token = process.env.GCP_ACCESS_TOKEN;
    if (config.models && config.models.providers) {
        Object.values(config.models.providers).forEach(function(p) {
            if (p.headers && p.headers.Authorization) p.headers.Authorization = 'Bearer ' + token;
            if (p.apiKey) p.apiKey = token;
        });
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
        console.log('Config updated with refreshed GCP token');
    }
} catch(e) {
    console.error('Failed to update config:', e.message);
}
"
}

start_gateway() {
    rm -f /tmp/openclaw-gateway.lock 2>/dev/null || true
    rm -f "$CONFIG_DIR/gateway.lock" 2>/dev/null || true
    if [ -n "$OPENCLAW_GATEWAY_TOKEN" ]; then
        openclaw gateway --port 18789 --verbose --allow-unconfigured --bind lan --token "$OPENCLAW_GATEWAY_TOKEN" &
    else
        openclaw gateway --port 18789 --verbose --allow-unconfigured --bind lan &
    fi
    echo $!
}

if [ -n "$GCP_SERVICE_ACCOUNT_KEY" ] && [ "$USE_VERTEX_AI" = "true" ]; then
    # Vertex AI mode: refresh GCP token every 50 minutes
    GATEWAY_PID=$(start_gateway)
    echo "Gateway started with PID $GATEWAY_PID (token refresh loop active)"

    while true; do
        sleep 3000
        echo "Token refresh cycle starting at $(date)..."
        refresh_and_restart
        echo "Restarting gateway with refreshed token..."
        kill "$GATEWAY_PID" 2>/dev/null
        wait "$GATEWAY_PID" 2>/dev/null
        GATEWAY_PID=$(start_gateway)
        echo "Gateway restarted with PID $GATEWAY_PID"
    done
else
    # No Vertex AI: start gateway directly (no token refresh needed)
    rm -f /tmp/openclaw-gateway.lock 2>/dev/null || true
    rm -f "$CONFIG_DIR/gateway.lock" 2>/dev/null || true
    if [ -n "$OPENCLAW_GATEWAY_TOKEN" ]; then
        echo "Starting gateway with token auth..."
        exec openclaw gateway --port 18789 --verbose --allow-unconfigured --bind lan --token "$OPENCLAW_GATEWAY_TOKEN"
    else
        echo "Starting gateway with device pairing (no token)..."
        exec openclaw gateway --port 18789 --verbose --allow-unconfigured --bind lan
    fi
fi
