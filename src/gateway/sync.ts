import type { Sandbox } from '@cloudflare/sandbox';
import type { MoltbotEnv } from '../types';
import { R2_MOUNT_PATH } from '../config';
import { mountR2Storage } from './r2';
import { waitForProcess } from './utils';

export interface SyncResult {
  success: boolean;
  lastSync?: string;
  error?: string;
  details?: string;
}

/**
 * Sync OpenClaw config and workspace from container to R2 for persistence.
 *
 * This function:
 * 1. Mounts R2 if not already mounted
 * 2. Runs a **single** shell command that:
 *    a. Detects the config directory (openclaw or legacy clawdbot)
 *    b. Rsyncs config, workspace, and skills to R2
 *    c. Writes and reads a timestamp for tracking
 *
 * Uses exactly ONE startProcess call to avoid zombie process accumulation
 * (Cloudflare Sandbox SDK does not auto-delete completed processes).
 *
 * Syncs three directories:
 * - Config: /root/.openclaw/ (or /root/.clawdbot/) -> R2:/openclaw/
 * - Workspace: /root/clawd/ -> R2:/workspace/ (excluding skills/)
 * - Skills: /root/clawd/skills/ -> R2:/skills/
 *
 * @param sandbox - The sandbox instance
 * @param env - Worker environment bindings
 * @returns SyncResult with success status and optional error details
 */
export async function syncToR2(sandbox: Sandbox, env: MoltbotEnv): Promise<SyncResult> {
  // Check if R2 is configured
  if (!env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY || !env.CF_ACCOUNT_ID) {
    return { success: false, error: 'R2 storage is not configured' };
  }

  // Mount R2 if not already mounted
  const mounted = await mountR2Storage(sandbox, env);
  if (!mounted) {
    return { success: false, error: 'Failed to mount R2 storage' };
  }

  // Build single-line shell command (startProcess uses a shell internally)
  // One startProcess call = 1 zombie process per sync (vs 6-7 previously)
  const r2 = R2_MOUNT_PATH;
  const syncCmd = [
    'CONFIG_DIR=""',
    `if cat /root/.openclaw/openclaw.json > /dev/null 2>&1 && [ -s /root/.openclaw/openclaw.json ]; then CONFIG_DIR="/root/.openclaw"`,
    `elif cat /root/.clawdbot/clawdbot.json > /dev/null 2>&1 && [ -s /root/.clawdbot/clawdbot.json ]; then CONFIG_DIR="/root/.clawdbot"`,
    `else echo "ERROR: no config file found" >&2; exit 1; fi`,
    'ERRORS=""',
    `rsync -r --no-times --delete --exclude=*.lock --exclude=*.log --exclude=*.tmp "$CONFIG_DIR/" ${r2}/openclaw/ 2>&1 || ERRORS="\${ERRORS}config_rsync_failed;"`,
    `rsync -r --no-times --delete --exclude=skills /root/clawd/ ${r2}/workspace/ 2>&1 || ERRORS="\${ERRORS}workspace_rsync_failed;"`,
    `rsync -r --no-times --delete /root/clawd/skills/ ${r2}/skills/ 2>&1 || ERRORS="\${ERRORS}skills_rsync_failed;"`,
    `date -Iseconds > ${r2}/.last-sync`,
    `if [ -n "$ERRORS" ]; then echo "PARTIAL:$ERRORS"; fi`,
    `cat ${r2}/.last-sync`,
  ].join('; ');

  try {
    const proc = await sandbox.startProcess(syncCmd);
    // 10 minute timeout — s3fs-backed R2 mounts can be slow
    await waitForProcess(proc, 600000);

    const logs = await proc.getLogs();
    const stdout = (logs.stdout || '').trim();
    const stderr = (logs.stderr || '').trim();

    console.log('[sync] single-process result:', {
      exitCode: proc.exitCode,
      status: proc.status,
      stdoutLength: stdout.length,
      stderrLength: stderr.length,
    });

    // Exit code 1 = config directory not found
    if (proc.exitCode === 1) {
      return {
        success: false,
        error: 'Sync aborted: no config file found',
        details: stderr || stdout || 'Neither openclaw.json nor clawdbot.json readable',
      };
    }

    // Parse stdout for timestamp and partial-failure marker
    const lines = stdout.split('\n').filter(Boolean);
    const partialLine = lines.find((l) => l.startsWith('PARTIAL:'));
    // The timestamp is always the last non-empty line
    const timestampLine = lines[lines.length - 1] || '';
    const lastSync = timestampLine.match(/^\d{4}-\d{2}-\d{2}/) ? timestampLine : undefined;

    if (partialLine) {
      return {
        success: false,
        lastSync,
        error: 'Partial sync failure',
        details: partialLine.replace('PARTIAL:', '').replace(/;$/, '').replace(/;/g, '; '),
      };
    }

    if (lastSync) {
      return { success: true, lastSync };
    }

    return {
      success: false,
      error: 'Sync failed',
      details: stderr || stdout || 'No timestamp produced',
    };
  } catch (err) {
    return {
      success: false,
      error: 'Sync error',
      details: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}
