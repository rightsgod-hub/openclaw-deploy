#!/bin/bash
# Startup script for OpenClaw in Cloudflare Sandbox
# This script:
# 1. Writes rclone config for R2 access (no FUSE mount needed)
# 2. Restores config/workspace from R2 backup using rclone copy
# 3. Runs openclaw onboard --non-interactive to configure from env vars
# 4. Patches config for features onboard doesn't cover (channels, gateway auth)
# 5. Starts the gateway

# set -e removed: single command failure must not kill the entire script
# Each section handles its own errors with || true or fallback logic

# 二重起動防止（複数インスタンス競合を防止）
exec 9>/tmp/openclaw-start.lock
flock -n 9 || { echo "Another start-openclaw.sh is already running, exiting."; exit 0; }

if ss -tlnp 2>/dev/null | grep -q ":18789"; then
    echo "OpenClaw gateway is already running on port 18789, exiting."
    exit 0
fi

CONFIG_DIR="/root/.openclaw"
CONFIG_FILE="$CONFIG_DIR/openclaw.json"
R2_BUCKET="${R2_BUCKET_NAME:-moltbot-data}"

echo "Config directory: $CONFIG_DIR"
echo "R2 bucket: $R2_BUCKET"

mkdir -p "$CONFIG_DIR"

# ============================================================
# CONFIGURE RCLONE FOR R2 DIRECT ACCESS (no FUSE mount)
# ============================================================
RCLONE_AVAILABLE=0

if [ -n "$R2_ACCESS_KEY_ID" ] && [ -n "$R2_SECRET_ACCESS_KEY" ] && [ -n "$CF_ACCOUNT_ID" ]; then
    mkdir -p /root/.config/rclone
    cat > /root/.config/rclone/rclone.conf << RCLONECONF
[r2]
type = s3
provider = Cloudflare
access_key_id = $R2_ACCESS_KEY_ID
secret_access_key = $R2_SECRET_ACCESS_KEY
endpoint = https://${CF_ACCOUNT_ID}.r2.cloudflarestorage.com
region = auto
no_check_bucket = true
RCLONECONF
    echo "rclone configured for R2 bucket: $R2_BUCKET"
    RCLONE_AVAILABLE=1
else
    echo "WARNING: R2 credentials not set, skipping R2 operations"
fi

# ============================================================
# RESTORE FROM R2 BACKUP (via rclone - no FUSE, no lazy listing)
# ============================================================

should_restore_from_r2() {
    local WORKSPACE_DIR="/root/clawd"

    # 1. ワークスペースに記憶ファイル（MEMORY.md）がない場合は、無条件で復元
    if [ ! -f "$WORKSPACE_DIR/MEMORY.md" ]; then
        echo "MEMORY.md not found in local workspace, forcing restore from R2"
        return 0
    fi

    # 2. R2にバックアップがあるなら、基本的にそちらを優先
    if rclone lsf "r2:${R2_BUCKET}/.last-sync" 2>/dev/null | grep -q ".last-sync"; then
        echo "Found R2 backup (.last-sync exists), prioritizing R2 data"
        return 0
    fi

    return 1
}

if [ "$RCLONE_AVAILABLE" -eq 1 ]; then
    # Check for config backup in R2
    if rclone lsf "r2:${R2_BUCKET}/openclaw/openclaw.json" 2>/dev/null | grep -q "openclaw.json"; then
        if should_restore_from_r2; then
            echo "Restoring config from R2 backup (openclaw/)..."
            rclone copy "r2:${R2_BUCKET}/openclaw/" "$CONFIG_DIR/" \
                --exclude='workspace/**' \
                || echo "WARNING: Config restore from R2 failed"
            rclone copyto "r2:${R2_BUCKET}/.last-sync" "$CONFIG_DIR/.last-sync" 2>/dev/null || true
            echo "Restored config from R2 backup"
        fi
    elif rclone lsf "r2:${R2_BUCKET}/clawdbot/clawdbot.json" 2>/dev/null | grep -q "clawdbot.json"; then
        # Legacy backup format
        if should_restore_from_r2; then
            echo "Restoring from legacy R2 backup (clawdbot/)..."
            rclone copy "r2:${R2_BUCKET}/clawdbot/" "$CONFIG_DIR/" \
                --exclude='workspace/**' \
                || echo "WARNING: Legacy config restore failed"
            rclone copyto "r2:${R2_BUCKET}/.last-sync" "$CONFIG_DIR/.last-sync" 2>/dev/null || true
            if [ -f "$CONFIG_DIR/clawdbot.json" ] && [ ! -f "$CONFIG_FILE" ]; then
                mv "$CONFIG_DIR/clawdbot.json" "$CONFIG_FILE"
            fi
            echo "Restored and migrated config from legacy R2 backup"
        fi
    else
        echo "No R2 backup found, starting fresh"
    fi

    # Restore workspace from R2
    WORKSPACE_DIR="/root/clawd"
    if rclone lsf "r2:${R2_BUCKET}/workspace/IDENTITY.md" 2>/dev/null | grep -q "IDENTITY.md"; then
        echo "Restoring workspace from R2 backup..."
        mkdir -p "$WORKSPACE_DIR"
        # Restore to a temporary directory first to avoid data loss on failure
        RESTORE_TMP="${WORKSPACE_DIR}.restore-tmp"
        rm -rf "${RESTORE_TMP}"
        mkdir -p "${RESTORE_TMP}"
        RESTORE_SUCCESS=0
        for RETRY in 1 2 3; do
            if rclone copy "r2:${R2_BUCKET}/workspace/" "${RESTORE_TMP}/" \
                --exclude='.venv/**' \
                --exclude='.git/**'; then
                # Verify restore content (IDENTITY.md must exist)
                if [ -f "${RESTORE_TMP}/IDENTITY.md" ]; then
                    echo "Restored workspace from R2 backup (attempt $RETRY)"
                    RESTORE_SUCCESS=1
                    break
                else
                    echo "WARNING: Restore completed but IDENTITY.md missing (attempt $RETRY)"
                fi
            else
                echo "WARNING: Workspace restore attempt $RETRY failed"
            fi
            if [ "$RETRY" -lt 3 ]; then
                echo "Waiting 5 seconds before retry..."
                sleep 5
            fi
        done
        if [ "$RESTORE_SUCCESS" -eq 1 ]; then
            # Only replace workspace after confirmed successful restore
            rm -rf "${WORKSPACE_DIR:?}"/*
            cp -a "${RESTORE_TMP}"/. "${WORKSPACE_DIR}/"
            rm -rf "${RESTORE_TMP}"
            echo "Workspace replaced with R2 backup"
        else
            echo "ERROR: All 3 workspace restore attempts failed. Keeping existing workspace."
            rm -rf "${RESTORE_TMP}"
        fi
    else
        echo "No workspace backup in R2, using deployed template"
    fi

    # Restore skills from R2
    SKILLS_DIR="/root/clawd/skills"
    if should_restore_from_r2; then
        rclone copy "r2:${R2_BUCKET}/skills/" "$SKILLS_DIR/" 2>/dev/null \
            && echo "Restored skills from R2 backup" || true
    fi
fi

# MEMORY.mdが存在しない場合は空ファイル作成
WORKSPACE_DIR="/root/clawd"
if [ ! -f "$WORKSPACE_DIR/MEMORY.md" ]; then
    echo "WARNING: MEMORY.md not found after workspace restore. Creating empty placeholder."
    touch "$WORKSPACE_DIR/MEMORY.md"
fi

# Write Google Workspace OAuth credentials for gws CLI
if [ -n "$GWS_CLIENT_ID" ] && [ -n "$GWS_CLIENT_SECRET" ] && [ -n "$GWS_REFRESH_TOKEN" ]; then
    mkdir -p /root/.config/gws
    cat > /root/.config/gws/credentials.json << GWSCREDS
{
  "type": "authorized_user",
  "client_id": "$GWS_CLIENT_ID",
  "client_secret": "$GWS_CLIENT_SECRET",
  "refresh_token": "$GWS_REFRESH_TOKEN"
}
GWSCREDS
    mkdir -p /root/.config/gcloud
    cp /root/.config/gws/credentials.json /root/.config/gcloud/application_default_credentials.json
    echo "Google Workspace credentials configured"
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
        --skip-health || {
        echo "WARNING: openclaw onboard failed, creating minimal config for gateway startup"
        cat > "$CONFIG_FILE" << 'MINCONFIG'
{"gateway":{"port":18789,"mode":"local","trustedProxies":["10.1.0.0"]}}
MINCONFIG
    }

    echo "Onboard completed"
else
    echo "Using existing config"
fi

# ============================================================
# PATCH CONFIG (channels, gateway auth, trusted proxies)
# ============================================================
# WRITE GCP KEY FILE (for GOOGLE_APPLICATION_CREDENTIALS / BQ SDK)
# ============================================================
if [ -n "$GCP_SERVICE_ACCOUNT_KEY" ]; then
    GCP_KEY_FILE="/root/.gcp-service-account.json"
    echo "$GCP_SERVICE_ACCOUNT_KEY" > "$GCP_KEY_FILE"
    chmod 600 "$GCP_KEY_FILE"
    export GOOGLE_APPLICATION_CREDENTIALS="$GCP_KEY_FILE"
    export GOOGLE_CLOUD_PROJECT="scrap-database-449306"
    export GOOGLE_CLOUD_LOCATION="global"
    echo "GCP service account key written to $GCP_KEY_FILE"

fi

# ============================================================
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

config.gateway.controlUi = config.gateway.controlUi || {};
config.gateway.controlUi.allowedOrigins = ['*'];

if (process.env.OPENCLAW_DEV_MODE === 'true') {
    config.gateway.controlUi.allowInsecureAuth = true;
}

const modelList = process.env.CF_AI_GATEWAY_MODELS
    ? process.env.CF_AI_GATEWAY_MODELS.split(',').map(m => m.trim())
    : process.env.CF_AI_GATEWAY_MODEL
    ? [process.env.CF_AI_GATEWAY_MODEL]
    : [];

const accountId = process.env.CF_AI_GATEWAY_ACCOUNT_ID;
const gatewayId = process.env.CF_AI_GATEWAY_GATEWAY_ID;
const apiKey = process.env.CLOUDFLARE_AI_GATEWAY_API_KEY;

if (!config.models) config.models = {};
if (!config.models.providers) config.models.providers = {};

if (!config.agents) config.agents = {};
if (!config.agents.defaults) config.agents.defaults = {};
if (!config.agents.defaults.model) config.agents.defaults.model = {};
config.agents.defaults.model.primary = 'moonshot/kimi-k2.5';
console.log('Primary model set to: moonshot/kimi-k2.5');

if (!config.agents.defaults.workspace) {
    config.agents.defaults.workspace = '/root/clawd';
    console.log('Workspace set to: /root/clawd');
}

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

if (process.env.DISCORD_BOT_TOKEN) {
    const dmPolicy = process.env.DISCORD_DM_POLICY || 'open';
    const discordConfig = {
        token: process.env.DISCORD_BOT_TOKEN,
        enabled: true,
        dmPolicy: dmPolicy,
        groupPolicy: 'open',
        guilds: {
            '*': {
                requireMention: false,
            },
        },
        eventQueue: {
            listenerTimeout: 300000,
        },
        accounts: {},
    };
    if (process.env.DISCORD_DM_ALLOW_FROM) {
        discordConfig.allowFrom = process.env.DISCORD_DM_ALLOW_FROM.split(',');
    } else if (dmPolicy === 'open') {
        discordConfig.allowFrom = ['*'];
    }
    config.channels.discord = discordConfig;
}

if (process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN) {
    config.channels.slack = {
        botToken: process.env.SLACK_BOT_TOKEN,
        appToken: process.env.SLACK_APP_TOKEN,
        enabled: true,
    };
}

if (config.channels.discord && config.channels.discord.enabled) {
    config.plugins = config.plugins || {};
    config.plugins.entries = config.plugins.entries || {};
    config.plugins.entries.discord = { enabled: true };
}

config.messages = config.messages || {};
config.messages.ackReactionScope = "group-mentions";

config.tools = config.tools || {};
config.tools.profile = 'coding';
config.tools.exec = config.tools.exec || {};
config.tools.exec.ask = 'off';
config.tools.exec.security = 'full';

if (process.env.MOONSHOT_API_KEY) {
    if (!config.models) config.models = {};
    if (!config.models.providers) config.models.providers = {};
    config.models.providers['moonshot'] = {
        api: 'openai-completions',
        baseUrl: 'https://api.moonshot.ai/v1',
        apiKey: process.env.MOONSHOT_API_KEY,
        models: [{
            id: 'kimi-k2.5',
            name: 'Kimi K2.5',
            reasoning: false,
            input: ['text', 'image'],
            contextWindow: 256000,
            maxTokens: 8192
        }, {
            id: 'kimi-k2-turbo-preview',
            name: 'Kimi K2 Turbo',
            reasoning: false,
            input: ['text', 'image'],
            contextWindow: 131072,
            maxTokens: 8192
        }]
    };
    console.log('[patch] moonshot provider added');
}

if (!config.gateway) config.gateway = {};
if (!config.gateway.http) config.gateway.http = {};
if (!config.gateway.http.endpoints) config.gateway.http.endpoints = {};
config.gateway.http.endpoints.chatCompletions = { enabled: true };
console.log('[patch] chatCompletions endpoint enabled');

if (!config.agents) config.agents = {};
if (!config.agents.defaults) config.agents.defaults = {};
if (!config.agents.defaults.models) config.agents.defaults.models = {};
config.agents.defaults.models['moonshot/kimi-k2.5'] = { alias: 'Kimi K2.5' };
config.agents.defaults.models['cf-ai-gw-google-0/gemini-3-flash-preview'] = { alias: 'Gemini Flash' };
config.agents.defaults.models['moonshot/kimi-k2-turbo-preview'] = { alias: 'Kimi K2 Turbo' };
if (!config.agents.defaults.model) config.agents.defaults.model = {};
config.agents.defaults.model.primary = 'moonshot/kimi-k2.5';
console.log('[patch] primary model: moonshot/kimi-k2.5');
config.agents.defaults.timeoutSeconds = 300;
console.log('[patch] agent timeoutSeconds set to 300s');

fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
console.log('Configuration patched successfully');
EOFPATCH

# ============================================================
# REFRESH GCP TOKEN BEFORE GATEWAY START
# ============================================================
if [ -n "$GCP_SERVICE_ACCOUNT_KEY" ]; then
    echo "Refreshing GCP access token before gateway start..."
    rm -f /tmp/gcp-token-last-refresh
    bash /usr/local/bin/refresh-gcp-token.sh || true
    echo "Pre-start GCP token refresh completed"
fi

# ============================================================
# START GATEWAY
# ============================================================
echo "Starting OpenClaw Gateway..."
echo "Gateway will be available on port 18789"

echo "Dev mode: ${OPENCLAW_DEV_MODE:-false}"

rm -f /tmp/openclaw-gateway.lock 2>/dev/null || true
rm -f "$CONFIG_DIR/gateway.lock" 2>/dev/null || true
exec 9>&-
if [ -n "$OPENCLAW_GATEWAY_TOKEN" ]; then
    echo "Starting gateway with token auth..."
    exec openclaw gateway --port 18789 --verbose --allow-unconfigured --bind lan --token "$OPENCLAW_GATEWAY_TOKEN"
else
    echo "Starting gateway with device pairing (no token)..."
    exec openclaw gateway --port 18789 --verbose --allow-unconfigured --bind lan
fi
