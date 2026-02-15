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
 * 2. Verifies source has critical files (prevents overwriting good backup with empty data)
 * 3. Runs rsync to copy config, workspace, and skills to R2
 * 4. Writes a timestamp file for tracking
 *
 * Syncs three directories:
 * - Config: /root/.openclaw/ (or /root/.clawdbot/) → R2:/openclaw/
 * - Workspace: /root/clawd/ → R2:/workspace/ (IDENTITY.md, MEMORY.md, memory/, assets/)
 * - Skills: /root/clawd/skills/ → R2:/skills/
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

  // Determine which config directory exists by reading the config file
  // Use cat to read file content directly instead of test -f
  let configDir = '/root/.openclaw';
  let catNew;
  let catLegacy;
  try {
    catNew = await sandbox.startProcess('cat /root/.openclaw/openclaw.json');
    await waitForProcess(catNew, 10000);
    const newLogs = await catNew.getLogs();

    console.log('[sync] New config check result:', {
      exitCode: catNew.exitCode,
      status: catNew.status,
      stdoutLength: newLogs.stdout?.length || 0,
      hasContent: !!newLogs.stdout && newLogs.stdout.trim().length > 0,
    });

    if (!newLogs.stdout || newLogs.stdout.trim().length === 0) {
      catLegacy = await sandbox.startProcess('cat /root/.clawdbot/clawdbot.json');
      await waitForProcess(catLegacy, 10000);
      const legacyLogs = await catLegacy.getLogs();

      console.log('[sync] Legacy config check result:', {
        exitCode: catLegacy.exitCode,
        status: catLegacy.status,
        stdoutLength: legacyLogs.stdout?.length || 0,
        hasContent: !!legacyLogs.stdout && legacyLogs.stdout.trim().length > 0,
      });

      if (legacyLogs.stdout && legacyLogs.stdout.trim().length > 0) {
        configDir = '/root/.clawdbot';
      } else {
        return {
          success: false,
          error: 'Sync aborted: no config file found',
          details: `Neither openclaw.json nor clawdbot.json readable. New: ${newLogs.stderr || 'empty'}, Legacy: ${legacyLogs.stderr || 'empty'}`,
        };
      }
    }
  } catch (err) {
    return {
      success: false,
      error: 'Failed to read config files',
      details: err instanceof Error ? err.message : 'Unknown error',
    };
  } finally {
    // Always clean up processes, regardless of success or error
    if (catNew) {
      try {
        await catNew.kill();
      } catch (killErr) {
        console.log('[sync] catNew cleanup (non-critical):', killErr);
      }
    }
    if (catLegacy) {
      try {
        await catLegacy.kill();
      } catch (killErr) {
        console.log('[sync] catLegacy cleanup (non-critical):', killErr);
      }
    }
  }

  // Sync to the new openclaw/ R2 prefix (even if source is legacy .clawdbot)
  // Also sync workspace directory (excluding skills since they're synced separately)
  const syncCmd = `rsync -r --no-times --delete --exclude='*.lock' --exclude='*.log' --exclude='*.tmp' ${configDir}/ ${R2_MOUNT_PATH}/openclaw/ && rsync -r --no-times --delete --exclude='skills' /root/clawd/ ${R2_MOUNT_PATH}/workspace/ && rsync -r --no-times --delete /root/clawd/skills/ ${R2_MOUNT_PATH}/skills/ && date -Iseconds > ${R2_MOUNT_PATH}/.last-sync`;

  let proc;
  let timestampProc;
  try {
    proc = await sandbox.startProcess(syncCmd);
    await waitForProcess(proc, 600000); // 10 minute timeout for sync (s3fs is slow)

    // Check for success by reading the timestamp file
    timestampProc = await sandbox.startProcess(`cat ${R2_MOUNT_PATH}/.last-sync`);
    await waitForProcess(timestampProc, 5000);
    const timestampLogs = await timestampProc.getLogs();
    const lastSync = timestampLogs.stdout?.trim();

    if (lastSync && lastSync.match(/^\d{4}-\d{2}-\d{2}/)) {
      return { success: true, lastSync };
    } else {
      const logs = await proc.getLogs();
      return {
        success: false,
        error: 'Sync failed',
        details: logs.stderr || logs.stdout || 'No timestamp file created',
      };
    }
  } catch (err) {
    return {
      success: false,
      error: 'Sync error',
      details: err instanceof Error ? err.message : 'Unknown error',
    };
  } finally {
    // Always clean up processes, regardless of success or error
    if (proc) {
      try {
        await proc.kill();
      } catch (killErr) {
        console.log('[sync] proc cleanup (non-critical):', killErr);
      }
    }
    if (timestampProc) {
      try {
        await timestampProc.kill();
      } catch (killErr) {
        console.log('[sync] timestampProc cleanup (non-critical):', killErr);
      }
    }
  }
}
