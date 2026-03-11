import type { Sandbox } from '@cloudflare/sandbox';
import type { MoltbotEnv } from '../types';
import { getR2BucketName } from '../config';
import { execWithTimeout } from './exec';
import { mountR2Storage } from './r2';

// CF Container sandboxではkill/pkillが効かないため、フラグで並行実行を防止する
let syncInProgress = false;


export interface SyncResult {
  success: boolean;
  lastSync?: string;
  error?: string;
  details?: string;
}

/**
 * Sync OpenClaw config and workspace from container to R2 for persistence.
 *
 * Uses rclone copy to directly push data to R2 (no FUSE mount, no dest-side deletion).
 *
 * Syncs three directories:
 * - Config: /root/.openclaw/ → R2:/openclaw/
 * - Workspace: /root/clawd/ → R2:/workspace/
 * - Skills: /root/clawd/skills/ → R2:/skills/
 */
export async function syncToR2(sandbox: Sandbox, env: MoltbotEnv): Promise<SyncResult> {
  if (syncInProgress) {
    console.log('[sync] Already in progress, skipping');
    return { success: true, lastSync: 'skipped' };
  }
  syncInProgress = true;

  try {
    return await _syncToR2(sandbox, env);
  } finally {
    syncInProgress = false;
  }
}

async function _syncToR2(sandbox: Sandbox, env: MoltbotEnv): Promise<SyncResult> {
  if (!env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY || !env.CF_ACCOUNT_ID) {
    return { success: false, error: 'R2 storage is not configured' };
  }

  const configured = await mountR2Storage(sandbox, env);
  if (!configured) {
    return { success: false, error: 'Failed to configure rclone for R2' };
  }

  const bucketName = getR2BucketName(env);
  const r2 = `r2:${bucketName}`;

  // Determine config directory
  let configDir = '/root/.openclaw';
  try {
    const checkNew = await execWithTimeout(sandbox, 'test -f /root/.openclaw/openclaw.json', { timeout: 5000 });
    if (checkNew.exitCode !== 0) {
      const checkLegacy = await execWithTimeout(sandbox, 'test -f /root/.clawdbot/clawdbot.json', { timeout: 5000 });
      if (checkLegacy.exitCode === 0) {
        configDir = '/root/.clawdbot';
      } else {
        return {
          success: false,
          error: 'Sync aborted: no config file found',
          details: 'Neither openclaw.json nor clawdbot.json found.',
        };
      }
    }
  } catch (err) {
    return {
      success: false,
      error: 'Failed to verify source files',
      details: err instanceof Error ? err.message : 'Unknown error',
    };
  }

  // Verify workspace has real content before syncing
  try {
    const identityCheck = await execWithTimeout(sandbox,
      'test -f /root/clawd/IDENTITY.md && ! grep -q "Fill this in" /root/clawd/IDENTITY.md',
      { timeout: 5000 }
    );
    if (identityCheck.exitCode !== 0) {
      return {
        success: false,
        error: 'Sync aborted: workspace not initialized',
        details: 'IDENTITY.md is missing or contains template content.',
      };
    }
  } catch (err) {
    return {
      success: false,
      error: 'Failed to verify workspace state',
      details: err instanceof Error ? err.message : 'Unknown error',
    };
  }

  // rclone copy: source → R2 (copies source files without deleting dest-only files)
  const syncCmd = `rclone copy ${configDir}/ ${r2}/openclaw/ --exclude='*.lock' --exclude='*.log' --exclude='*.tmp' --exclude='workspace/**' --no-update-modtime && rclone copy /root/clawd/ ${r2}/workspace/ --exclude='skills/**' --exclude='.venv/**' --exclude='.git/**' --no-update-modtime && rclone copy /root/clawd/skills/ ${r2}/skills/ --no-update-modtime && date -Iseconds > /tmp/.r2-last-sync && rclone copyto /tmp/.r2-last-sync ${r2}/.last-sync`;

  try {
    const syncResult = await execWithTimeout(sandbox, syncCmd, { timeout: 60000 });

    if (syncResult.exitCode !== 0) {
      return {
        success: false,
        error: 'Sync failed',
        details: syncResult.stderr || syncResult.stdout || 'rclone exited non-zero',
      };
    }

    // Read timestamp back to confirm
    const tsResult = await execWithTimeout(sandbox,
      `rclone cat ${r2}/.last-sync 2>/dev/null || cat /tmp/.r2-last-sync 2>/dev/null || echo ""`,
      { timeout: 10000 },
    );
    const lastSync = tsResult.stdout?.trim();

    if (lastSync && lastSync.match(/^\d{4}-\d{2}-\d{2}/)) {
      return { success: true, lastSync };
    } else {
      return {
        success: false,
        error: 'Sync failed',
        details: 'No valid timestamp after sync',
      };
    }
  } catch (err) {
    return {
      success: false,
      error: 'Sync error',
      details: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}
