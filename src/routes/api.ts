import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { createAccessMiddleware } from '../auth';
import {
  ensureMoltbotGateway,
  findExistingMoltbotProcess,
  mountR2Storage,
  syncToR2,
} from '../gateway';
import { R2_MOUNT_PATH } from '../config';

// CLI commands can take 10-15 seconds to complete due to WebSocket connection overhead
const CLI_TIMEOUT_MS = 20000;

/**
 * API routes
 * - /api/admin/* - Protected admin API routes (Cloudflare Access required)
 *
 * Note: /api/status is now handled by publicRoutes (no auth required)
 */
const api = new Hono<AppEnv>();

/**
 * Admin API routes - all protected by Cloudflare Access
 */
const adminApi = new Hono<AppEnv>();

// Middleware: Verify Cloudflare Access JWT for all admin routes
adminApi.use('*', createAccessMiddleware({ type: 'json' }));

// GET /api/admin/devices - List pending and paired devices
adminApi.get('/devices', async (c) => {
  const sandbox = c.get('sandbox');

  try {
    // Ensure moltbot is running first
    await ensureMoltbotGateway(sandbox, c.env);

    // Run OpenClaw CLI to list devices
    // Must specify --url and --token (OpenClaw v2026.2.3 requires explicit credentials with --url)
    const token = c.env.MOLTBOT_GATEWAY_TOKEN;
    const tokenArg = token ? ` --token ${token}` : '';
    const result = await sandbox.exec(
      `openclaw devices list --json --url ws://localhost:18789${tokenArg}`,
      { timeout: CLI_TIMEOUT_MS },
    );
    const stdout = result.stdout || '';
    const stderr = result.stderr || '';

    // Try to parse JSON output
    try {
      // Find JSON in output (may have other log lines)
      const jsonMatch = stdout.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const data = JSON.parse(jsonMatch[0]);
        return c.json(data);
      }

      // If no JSON found, return raw output for debugging
      return c.json({
        pending: [],
        paired: [],
        raw: stdout,
        stderr,
      });
    } catch {
      return c.json({
        pending: [],
        paired: [],
        raw: stdout,
        stderr,
        parseError: 'Failed to parse CLI output',
      });
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// POST /api/admin/devices/:requestId/approve - Approve a pending device
adminApi.post('/devices/:requestId/approve', async (c) => {
  const sandbox = c.get('sandbox');
  const requestId = c.req.param('requestId');

  if (!requestId) {
    return c.json({ error: 'requestId is required' }, 400);
  }

  try {
    // Ensure moltbot is running first
    await ensureMoltbotGateway(sandbox, c.env);

    // Run OpenClaw CLI to approve the device
    const token = c.env.MOLTBOT_GATEWAY_TOKEN;
    const tokenArg = token ? ` --token ${token}` : '';
    const result = await sandbox.exec(
      `openclaw devices approve ${requestId} --url ws://localhost:18789${tokenArg}`,
      { timeout: CLI_TIMEOUT_MS },
    );
    const stdout = result.stdout || '';
    const stderr = result.stderr || '';

    // Check for success indicators (case-insensitive, CLI outputs "Approved ...")
    const success = stdout.toLowerCase().includes('approved') || result.exitCode === 0;

    return c.json({
      success,
      requestId,
      message: success ? 'Device approved' : 'Approval may have failed',
      stdout,
      stderr,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// POST /api/admin/devices/approve-all - Approve all pending devices
adminApi.post('/devices/approve-all', async (c) => {
  const sandbox = c.get('sandbox');

  try {
    // Ensure moltbot is running first
    await ensureMoltbotGateway(sandbox, c.env);

    // First, get the list of pending devices
    const token = c.env.MOLTBOT_GATEWAY_TOKEN;
    const tokenArg = token ? ` --token ${token}` : '';
    const listResult = await sandbox.exec(
      `openclaw devices list --json --url ws://localhost:18789${tokenArg}`,
      { timeout: CLI_TIMEOUT_MS },
    );
    const stdout = listResult.stdout || '';

    // Parse pending devices
    let pending: Array<{ requestId: string }> = [];
    try {
      const jsonMatch = stdout.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const data = JSON.parse(jsonMatch[0]);
        pending = data.pending || [];
      }
    } catch {
      return c.json({ error: 'Failed to parse device list', raw: stdout }, 500);
    }

    if (pending.length === 0) {
      return c.json({ approved: [], message: 'No pending devices to approve' });
    }

    // Approve each pending device
    const results: Array<{ requestId: string; success: boolean; error?: string }> = [];

    for (const device of pending) {
      try {
        // eslint-disable-next-line no-await-in-loop -- sequential device approval required
        const approveResult = await sandbox.exec(
          `openclaw devices approve ${device.requestId} --url ws://localhost:18789${tokenArg}`,
          { timeout: CLI_TIMEOUT_MS },
        );
        const success =
          approveResult.stdout?.toLowerCase().includes('approved') || approveResult.exitCode === 0;

        results.push({ requestId: device.requestId, success });
      } catch (err) {
        results.push({
          requestId: device.requestId,
          success: false,
          error: err instanceof Error ? err.message : 'Unknown error',
        });
      }
    }

    const approvedCount = results.filter((r) => r.success).length;
    return c.json({
      approved: results.filter((r) => r.success).map((r) => r.requestId),
      failed: results.filter((r) => !r.success),
      message: `Approved ${approvedCount} of ${pending.length} device(s)`,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// GET /api/admin/storage - Get R2 storage status and last sync time
adminApi.get('/storage', async (c) => {
  const sandbox = c.get('sandbox');
  const hasCredentials = !!(
    c.env.R2_ACCESS_KEY_ID &&
    c.env.R2_SECRET_ACCESS_KEY &&
    c.env.CF_ACCOUNT_ID
  );

  // Check which credentials are missing
  const missing: string[] = [];
  if (!c.env.R2_ACCESS_KEY_ID) missing.push('R2_ACCESS_KEY_ID');
  if (!c.env.R2_SECRET_ACCESS_KEY) missing.push('R2_SECRET_ACCESS_KEY');
  if (!c.env.CF_ACCOUNT_ID) missing.push('CF_ACCOUNT_ID');

  let lastSync: string | null = null;

  // If R2 is configured, check for last sync timestamp
  if (hasCredentials) {
    try {
      // Mount R2 if not already mounted
      await mountR2Storage(sandbox, c.env);

      // Check for sync marker file
      const result = await sandbox.exec(
        `cat ${R2_MOUNT_PATH}/.last-sync 2>/dev/null || echo ""`,
        { timeout: 5000 },
      );
      const timestamp = result.stdout?.trim();
      if (timestamp && timestamp !== '') {
        lastSync = timestamp;
      }
    } catch {
      // Ignore errors checking sync status
    }
  }

  return c.json({
    configured: hasCredentials,
    missing: missing.length > 0 ? missing : undefined,
    lastSync,
    message: hasCredentials
      ? 'R2 storage is configured. Your data will persist across container restarts.'
      : 'R2 storage is not configured. Paired devices and conversations will be lost when the container restarts.',
  });
});

// POST /api/admin/storage/sync - Trigger a manual sync to R2
adminApi.post('/storage/sync', async (c) => {
  const sandbox = c.get('sandbox');

  const result = await syncToR2(sandbox, c.env);

  if (result.success) {
    return c.json({
      success: true,
      message: 'Sync completed successfully',
      lastSync: result.lastSync,
    });
  } else {
    const status = result.error?.includes('not configured') ? 400 : 500;
    return c.json(
      {
        success: false,
        error: result.error,
        details: result.details,
      },
      status,
    );
  }
});

// POST /api/admin/gateway/restart - Kill the current gateway and start a new one
adminApi.post('/gateway/restart', async (c) => {
  const sandbox = c.get('sandbox');

  try {
    // Find and kill the existing gateway process
    const existingProcess = await findExistingMoltbotProcess(sandbox);

    if (existingProcess) {
      console.log('Killing existing gateway process:', existingProcess.id);
      try {
        await existingProcess.kill();
      } catch (killErr) {
        console.error('Error killing process:', killErr);
      }
      // Wait a moment for the process to die
      await new Promise((r) => setTimeout(r, 2000));
    }

    // Start a new gateway in the background
    const bootPromise = ensureMoltbotGateway(sandbox, c.env).catch((err) => {
      console.error('Gateway restart failed:', err);
    });
    c.executionCtx.waitUntil(bootPromise);

    return c.json({
      success: true,
      message: existingProcess
        ? 'Gateway process killed, new instance starting...'
        : 'No existing process found, starting new instance...',
      previousProcessId: existingProcess?.id,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// DELETE /api/admin/devices/:deviceId - Remove a paired device
adminApi.delete('/devices/:deviceId', async (c) => {
  const sandbox = c.get('sandbox');
  const deviceId = c.req.param('deviceId');

  if (!deviceId) {
    return c.json({ error: 'deviceId is required' }, 400);
  }

  // Validate deviceId to prevent command injection (alphanumeric, hyphens, underscores only)
  if (!/^[\w-]+$/.test(deviceId)) {
    return c.json({ error: 'Invalid deviceId format' }, 400);
  }

  try {
    // Ensure moltbot is running first
    await ensureMoltbotGateway(sandbox, c.env);

    const token = c.env.MOLTBOT_GATEWAY_TOKEN;
    const tokenArg = token ? ` --token ${token}` : '';

    // Try CLI removal first (in case a future OpenClaw version adds it)
    const result = await sandbox.exec(
      `openclaw devices remove ${deviceId} --url ws://localhost:18789${tokenArg} 2>&1`,
      { timeout: CLI_TIMEOUT_MS },
    );
    const stdout = result.stdout || '';

    // If CLI command succeeded, return success
    if (result.exitCode === 0 && !stdout.includes('unknown command') && !stdout.includes('Unknown command')) {
      return c.json({
        success: true,
        deviceId,
        message: 'Device removed via CLI',
      });
    }

    // Fallback: find and edit pairing data files directly
    // OpenClaw stores device data in JSON files under its config directory
    const findResult = await sandbox.exec(
      `grep -rl "${deviceId}" /root/.openclaw/ /home/*/.openclaw/ 2>/dev/null | head -10`,
      { timeout: 10000 },
    );
    const matchingFiles = (findResult.stdout || '').trim().split('\n').filter(Boolean);

    if (matchingFiles.length === 0) {
      return c.json(
        {
          success: false,
          deviceId,
          error: 'Device not found in pairing data',
        },
        404,
      );
    }

    // Use Node.js to safely parse and modify JSON files
    for (const file of matchingFiles) {
      if (!file.endsWith('.json')) continue;

      // eslint-disable-next-line no-await-in-loop
      const editResult = await sandbox.exec(
        `node -e "
const fs = require('fs');
try {
  const data = JSON.parse(fs.readFileSync('${file}', 'utf8'));
  let modified = false;
  for (const key of Object.keys(data)) {
    if (Array.isArray(data[key])) {
      const before = data[key].length;
      data[key] = data[key].filter(d => d.deviceId !== '${deviceId}' && d.id !== '${deviceId}');
      if (data[key].length < before) modified = true;
    } else if (typeof data[key] === 'object' && data[key] !== null) {
      if ('${deviceId}' in data[key]) {
        delete data[key]['${deviceId}'];
        modified = true;
      }
    }
  }
  if (modified) {
    fs.writeFileSync('${file}', JSON.stringify(data, null, 2));
    console.log('REMOVED');
  } else {
    console.log('NOT_FOUND');
  }
} catch (e) {
  console.log('ERROR: ' + e.message);
}
"`,
        { timeout: 10000 },
      );

      if ((editResult.stdout || '').includes('REMOVED')) {
        return c.json({
          success: true,
          deviceId,
          message: 'Device pairing data removed',
        });
      }
    }

    return c.json(
      {
        success: false,
        deviceId,
        error: 'Could not remove device from pairing data',
      },
      500,
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// DELETE /api/admin/processes/all - Kill all running processes (emergency cleanup)
adminApi.delete('/processes/all', async (c) => {
  const sandbox = c.get('sandbox');
  try {
    const processes = await sandbox.listProcesses();
    const killed: string[] = [];
    const errors: string[] = [];

    for (const proc of processes) {
      if (proc.status === 'running' || proc.status === 'starting') {
        try {
          await proc.kill();
          killed.push(proc.id);
        } catch (e) {
          errors.push(`${proc.id}: ${String(e)}`);
        }
      }
    }

    return c.json({ killed: killed.length, killedIds: killed, errors });
  } catch (error) {
    return c.json({ error: String(error) }, 500);
  }
});

// GET /api/admin/processes - List all processes (for debugging)
adminApi.get('/processes', async (c) => {
  const sandbox = c.get('sandbox');
  try {
    const processes = await sandbox.listProcesses();
    const processInfo = processes.map((proc) => ({
      id: proc.id,
      command: proc.command.substring(0, 200),
      status: proc.status,
      exitCode: proc.exitCode,
    }));
    return c.json({ total: processes.length, processes: processInfo });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// Mount admin API routes under /admin
api.route('/admin', adminApi);

export { api };
