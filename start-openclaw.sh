#!/bin/bash
# Startup script for OpenClaw in Cloudflare Sandbox
# This script:
# 1. Restores config/workspace/skills from R2 via rclone (if configured)
# 2. Runs openclaw onboard --non-interactive to configure from env vars
# 3. Patches config for features onboard doesn't cover (channels, gateway auth)
# 4. Starts a background sync loop (rclone, watches for file changes)
# 5. Starts the gateway

# set -e removed: single command failure must not kill the entire script
# Each section handles its own errors with || true or fallback logic

CONFIG_DIR="/root/.openclaw"
CONFIG_FILE="$CONFIG_DIR/openclaw.json"
WORKSPACE_DIR="/root/clawd"
SKILLS_DIR="/root/clawd/skills"
RCLONE_CONF="/root/.config/rclone/rclone.conf"
LAST_SYNC_FILE="/tmp/.last-sync"

echo "Config directory: $CONFIG_DIR"

mkdir -p "$CONFIG_DIR"

# ============================================================
# RCLONE SETUP
# ============================================================

r2_configured() {
    [ -n "$R2_ACCESS_KEY_ID" ] && [ -n "$R2_SECRET_ACCESS_KEY" ] && [ -n "$CF_ACCOUNT_ID" ]
}

R2_BUCKET="${R2_BUCKET_NAME:-moltbot-data}"

setup_rclone() {
    mkdir -p "$(dirname "$RCLONE_CONF")"
    cat > "$RCLONE_CONF" << EOF
[r2]
type = s3
provider = Cloudflare
access_key_id = $R2_ACCESS_KEY_ID
secret_access_key = $R2_SECRET_ACCESS_KEY
endpoint = https://${CF_ACCOUNT_ID}.r2.cloudflarestorage.com
acl = private
no_check_bucket = true
EOF
    touch /tmp/.rclone-configured
    echo "Rclone configured for bucket: $R2_BUCKET"
}

RCLONE_FLAGS="--transfers=16 --fast-list --s3-no-check-bucket"

# ============================================================
# RESTORE FROM R2
# ============================================================

# Fork: Helper to decide if R2 restore is needed
should_restore_from_r2() {
    if [ ! -f "$WORKSPACE_DIR/MEMORY.md" ]; then
        echo "MEMORY.md not found in local workspace, forcing restore from R2"
        return 0
    fi
    if rclone lsf "r2:${R2_BUCKET}/.last-sync" $RCLONE_FLAGS 2>/dev/null | grep -q ".last-sync"; then
        echo "Found R2 backup (.last-sync exists), prioritizing R2 data"
        return 0
    fi
    return 1
}

if r2_configured; then
    setup_rclone

    echo "Checking R2 for existing backup..."
    # Check if R2 has an openclaw config backup
    if rclone ls "r2:${R2_BUCKET}/openclaw/openclaw.json" $RCLONE_FLAGS 2>/dev/null | grep -q openclaw.json; then
        if should_restore_from_r2; then
            echo "Restoring config from R2..."
            rclone copy "r2:${R2_BUCKET}/openclaw/" "$CONFIG_DIR/" $RCLONE_FLAGS \
                --exclude='workspace/**' \
                || echo "WARNING: config restore failed"
            rclone copyto "r2:${R2_BUCKET}/.last-sync" "$CONFIG_DIR/.last-sync" 2>/dev/null || true
            echo "Config restored"
        fi
    elif rclone ls "r2:${R2_BUCKET}/clawdbot/clawdbot.json" $RCLONE_FLAGS 2>/dev/null | grep -q clawdbot.json; then
        if should_restore_from_r2; then
            echo "Restoring from legacy R2 backup..."
            rclone copy "r2:${R2_BUCKET}/clawdbot/" "$CONFIG_DIR/" $RCLONE_FLAGS \
                --exclude='workspace/**' \
                || echo "WARNING: legacy config restore failed"
            rclone copyto "r2:${R2_BUCKET}/.last-sync" "$CONFIG_DIR/.last-sync" 2>/dev/null || true
            if [ -f "$CONFIG_DIR/clawdbot.json" ] && [ ! -f "$CONFIG_FILE" ]; then
                mv "$CONFIG_DIR/clawdbot.json" "$CONFIG_FILE"
            fi
            echo "Legacy config restored and migrated"
        fi
    else
        echo "No backup found in R2, starting fresh"
    fi

    # Fork: Restore workspace with retry logic and IDENTITY.md verification
    if rclone lsf "r2:${R2_BUCKET}/workspace/IDENTITY.md" $RCLONE_FLAGS 2>/dev/null | grep -q "IDENTITY.md"; then
        echo "Restoring workspace from R2 backup..."
        mkdir -p "$WORKSPACE_DIR"
        RESTORE_TMP="${WORKSPACE_DIR}.restore-tmp"
        rm -rf "${RESTORE_TMP}"
        mkdir -p "${RESTORE_TMP}"
        RESTORE_SUCCESS=0
        for RETRY in 1 2 3; do
            if rclone copy "r2:${R2_BUCKET}/workspace/" "${RESTORE_TMP}/" $RCLONE_FLAGS \
                --exclude='.venv/**' \
                --exclude='.git/**'; then
                # Check if any files were actually restored
                FILE_COUNT=$(find "${RESTORE_TMP}" -type f 2>/dev/null | wc -l)
                if [ "$FILE_COUNT" -eq 0 ]; then
                    echo "WARNING: rclone copy succeeded but 0 files restored (R2 empty?), skipping retries"
                    break
                fi
                if [ -f "${RESTORE_TMP}/IDENTITY.md" ]; then
                    echo "Restored workspace from R2 backup (attempt $RETRY, $FILE_COUNT files)"
                    RESTORE_SUCCESS=1
                    break
                else
                    echo "WARNING: Restore got $FILE_COUNT files but IDENTITY.md missing (attempt $RETRY)"
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

    # Restore skills
    if should_restore_from_r2; then
        rclone copy "r2:${R2_BUCKET}/skills/" "$SKILLS_DIR/" $RCLONE_FLAGS 2>/dev/null \
            && echo "Restored skills from R2 backup" || true
    fi
else
    echo "R2 not configured, starting fresh"
fi

# Fork: MEMORY.md placeholder
if [ ! -f "$WORKSPACE_DIR/MEMORY.md" ]; then
    echo "WARNING: MEMORY.md not found after workspace restore. Creating empty placeholder."
    touch "$WORKSPACE_DIR/MEMORY.md"
fi

# ============================================================
# Fork: WRITE GWS CREDENTIALS
# ============================================================
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
# Fork: WRITE GCP KEY FILE (for GOOGLE_APPLICATION_CREDENTIALS / BQ SDK)
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
if (!config.gateway.reload) config.gateway.reload = {};
config.gateway.reload.mode = 'hot';

if (process.env.OPENCLAW_GATEWAY_TOKEN) {
    config.gateway.auth = config.gateway.auth || {};
    config.gateway.auth.token = process.env.OPENCLAW_GATEWAY_TOKEN;
}

// Fork: controlUi allowedOrigins
config.gateway.controlUi = config.gateway.controlUi || {};
config.gateway.controlUi.allowedOrigins = ['*'];

if (process.env.OPENCLAW_DEV_MODE === 'true') {
    config.gateway.controlUi.allowInsecureAuth = true;
}

// Legacy AI Gateway base URL override:
// ANTHROPIC_BASE_URL is picked up natively by the Anthropic SDK,
// so we don't need to patch the provider config. Writing a provider
// entry without a models array breaks OpenClaw's config validation.

// AI Gateway model override (CF_AI_GATEWAY_MODEL=provider/model-id)
// Adds a provider entry for any AI Gateway provider and sets it as default model.
// Examples:
//   workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast
//   openai/gpt-4o
//   anthropic/claude-sonnet-4-5
if (process.env.CF_AI_GATEWAY_MODEL) {
    const raw = process.env.CF_AI_GATEWAY_MODEL;
    const slashIdx = raw.indexOf('/');
    const gwProvider = raw.substring(0, slashIdx);
    const modelId = raw.substring(slashIdx + 1);

    const accountId = process.env.CF_AI_GATEWAY_ACCOUNT_ID;
    const gatewayId = process.env.CF_AI_GATEWAY_GATEWAY_ID;
    const apiKey = process.env.CLOUDFLARE_AI_GATEWAY_API_KEY;

    let baseUrl;
    if (accountId && gatewayId) {
        baseUrl = 'https://gateway.ai.cloudflare.com/v1/' + accountId + '/' + gatewayId + '/' + gwProvider;
        if (gwProvider === 'workers-ai') baseUrl += '/v1';
    } else if (gwProvider === 'workers-ai' && process.env.CF_ACCOUNT_ID) {
        baseUrl = 'https://api.cloudflare.com/client/v4/accounts/' + process.env.CF_ACCOUNT_ID + '/ai/v1';
    }

    if (baseUrl && apiKey) {
        const api = gwProvider === 'anthropic' ? 'anthropic-messages' : 'openai-completions';
        const providerName = 'cf-ai-gw-' + gwProvider;

        config.models = config.models || {};
        config.models.providers = config.models.providers || {};
        config.models.providers[providerName] = {
            baseUrl: baseUrl,
            apiKey: apiKey,
            api: api,
            models: [{ id: modelId, name: modelId, contextWindow: 131072, maxTokens: 8192 }],
        };
        config.agents = config.agents || {};
        config.agents.defaults = config.agents.defaults || {};
        config.agents.defaults.model = { primary: providerName + '/' + modelId };
        console.log('AI Gateway model override: provider=' + providerName + ' model=' + modelId + ' via ' + baseUrl);
    } else {
        console.warn('CF_AI_GATEWAY_MODEL set but missing required config (account ID, gateway ID, or API key)');
    }
}

// Fork: CF_AI_GATEWAY_MODELS - multiple model support
if (process.env.CF_AI_GATEWAY_MODELS) {
    const modelList = process.env.CF_AI_GATEWAY_MODELS.split(',').map(m => m.trim());
    const accountId = process.env.CF_AI_GATEWAY_ACCOUNT_ID;
    const gatewayId = process.env.CF_AI_GATEWAY_GATEWAY_ID;
    const apiKey = process.env.CLOUDFLARE_AI_GATEWAY_API_KEY;

    if (!config.models) config.models = {};
    if (!config.models.providers) config.models.providers = {};

    for (const raw of modelList) {
        const slashIdx = raw.indexOf('/');
        if (slashIdx < 0) continue;
        const gwProvider = raw.substring(0, slashIdx);
        const modelId = raw.substring(slashIdx + 1);
        let baseUrl;
        if (accountId && gatewayId) {
            baseUrl = 'https://gateway.ai.cloudflare.com/v1/' + accountId + '/' + gatewayId + '/' + gwProvider;
            if (gwProvider === 'workers-ai') baseUrl += '/v1';
        }
        if (baseUrl && apiKey) {
            const api = gwProvider === 'anthropic' ? 'anthropic-messages' : 'openai-completions';
            const providerName = 'cf-ai-gw-' + gwProvider;
            if (!config.models.providers[providerName]) {
                config.models.providers[providerName] = {
                    baseUrl: baseUrl,
                    apiKey: apiKey,
                    api: api,
                    models: [],
                };
            }
            config.models.providers[providerName].models.push({
                id: modelId, name: modelId, contextWindow: 131072, maxTokens: 8192
            });
            console.log('[patch] AI Gateway model added: ' + providerName + '/' + modelId);
        }
    }
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

// Fork: Discord configuration with extended options (guilds, eventQueue, accounts)
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

// Slack configuration
if (process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN) {
    config.channels.slack = {
        botToken: process.env.SLACK_BOT_TOKEN,
        appToken: process.env.SLACK_APP_TOKEN,
        enabled: true,
    };
}

// Fork: Discord plugin
if (config.channels.discord && config.channels.discord.enabled) {
    config.plugins = config.plugins || {};
    config.plugins.entries = config.plugins.entries || {};
    config.plugins.entries.discord = { enabled: true };
}

// Fork: Messages settings
config.messages = config.messages || {};
config.messages.ackReactionScope = "group-mentions";

// Fork: Tools settings
config.tools = config.tools || {};
config.tools.profile = 'coding';
config.tools.exec = config.tools.exec || {};
config.tools.exec.ask = 'off';
config.tools.exec.security = 'full';

// Fork: Moonshot provider
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

// Fork: chatCompletions endpoint
if (!config.gateway) config.gateway = {};
if (!config.gateway.http) config.gateway.http = {};
if (!config.gateway.http.endpoints) config.gateway.http.endpoints = {};
config.gateway.http.endpoints.chatCompletions = { enabled: true };
console.log('[patch] chatCompletions endpoint enabled');

// Fork: Agent defaults
if (!config.agents) config.agents = {};
if (!config.agents.defaults) config.agents.defaults = {};
if (!config.agents.defaults.model) config.agents.defaults.model = {};
config.agents.defaults.model.primary = 'cf-ai-gw-google-0/gemini-3-flash-preview';
config.agents.defaults.model.fallbacks = ['moonshot/kimi-k2.5', 'moonshot/kimi-k2-turbo-preview'];
console.log('[patch] primary model: cf-ai-gw-google-0/gemini-3-flash-preview, fallbacks: moonshot/kimi-k2.5');
if (!config.agents.defaults.workspace) {
    config.agents.defaults.workspace = '/root/clawd';
}
config.agents.defaults.timeoutSeconds = 300;
if (!config.agents.defaults.models) config.agents.defaults.models = {};
config.agents.defaults.models['moonshot/kimi-k2.5'] = { alias: 'Kimi K2.5' };
config.agents.defaults.models['cf-ai-gw-google-0/gemini-3-flash-preview'] = { alias: 'Gemini Flash' };
config.agents.defaults.models['moonshot/kimi-k2-turbo-preview'] = { alias: 'Kimi K2 Turbo' };

fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
console.log('Configuration patched successfully');
EOFPATCH

# ============================================================
# BACKGROUND SYNC LOOP
# ============================================================
if r2_configured; then
    echo "Starting background R2 sync loop..."
    (
        MARKER=/tmp/.last-sync-marker
        LOGFILE=/tmp/r2-sync.log
        touch "$MARKER"

        while true; do
            sleep 30

            CHANGED=/tmp/.changed-files
            {
                find "$CONFIG_DIR" -newer "$MARKER" -type f -printf '%P\n' 2>/dev/null
                find "$WORKSPACE_DIR" -newer "$MARKER" \
                    -not -path '*/node_modules/*' \
                    -not -path '*/.git/*' \
                    -type f -printf '%P\n' 2>/dev/null
            } > "$CHANGED"

            COUNT=$(wc -l < "$CHANGED" 2>/dev/null || echo 0)

            if [ "$COUNT" -gt 0 ]; then
                echo "[sync] Uploading changes ($COUNT files) at $(date)" >> "$LOGFILE"
                rclone sync "$CONFIG_DIR/" "r2:${R2_BUCKET}/openclaw/" \
                    $RCLONE_FLAGS --exclude='*.lock' --exclude='*.log' --exclude='*.tmp' --exclude='.git/**' 2>> "$LOGFILE"
                if [ -d "$WORKSPACE_DIR" ]; then
                    rclone sync "$WORKSPACE_DIR/" "r2:${R2_BUCKET}/workspace/" \
                        $RCLONE_FLAGS --exclude='skills/**' --exclude='.git/**' --exclude='node_modules/**' 2>> "$LOGFILE"
                fi
                if [ -d "$SKILLS_DIR" ]; then
                    rclone sync "$SKILLS_DIR/" "r2:${R2_BUCKET}/skills/" \
                        $RCLONE_FLAGS 2>> "$LOGFILE"
                fi
                date -Iseconds > "$LAST_SYNC_FILE"
                touch "$MARKER"
                echo "[sync] Complete at $(date)" >> "$LOGFILE"
            fi
        done
    ) &
    echo "Background sync loop started (PID: $!)"
fi

# ============================================================
# Fork: REFRESH GCP TOKEN BEFORE GATEWAY START
# ============================================================
if [ -n "$GCP_SERVICE_ACCOUNT_KEY" ]; then
    echo "Refreshing GCP access token before gateway start..."
    rm -f /tmp/gcp-token-last-refresh
    timeout 30 bash /usr/local/bin/refresh-gcp-token.sh || true
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

if [ -n "$OPENCLAW_GATEWAY_TOKEN" ]; then
    echo "Starting gateway with token auth..."
    exec openclaw gateway --port 18789 --verbose --allow-unconfigured --bind lan --token "$OPENCLAW_GATEWAY_TOKEN"
else
    echo "Starting gateway with device pairing (no token)..."
    exec openclaw gateway --port 18789 --verbose --allow-unconfigured --bind lan
fi