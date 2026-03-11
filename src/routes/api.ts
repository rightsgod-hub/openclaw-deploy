import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { createAccessMiddleware } from '../auth';
import {
  callRpc,
  ensureMoltbotGateway,
  execWithTimeout,
  killAllGatewayProcesses,
  mountR2Storage,
  syncToR2,
} from '../gateway';
import { getR2BucketName } from '../config';

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

    const token = c.env.MOLTBOT_GATEWAY_TOKEN || '';
    const data = await callRpc(sandbox, token, 'device.pair.list');
    return c.json(data as Record<string, unknown>);
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

    const token = c.env.MOLTBOT_GATEWAY_TOKEN || '';
    await callRpc(sandbox, token, 'device.pair.approve', { requestId });

    return c.json({
      success: true,
      requestId,
      message: 'Device approved',
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

    const token = c.env.MOLTBOT_GATEWAY_TOKEN || '';

    // Get list of pending devices via RPC
    const listData = await callRpc(sandbox, token, 'device.pair.list') as { pending?: Array<{ requestId: string }> };
    const pending = listData?.pending || [];

    if (pending.length === 0) {
      return c.json({ approved: [], message: 'No pending devices to approve' });
    }

    // Approve each pending device
    const results: Array<{ requestId: string; success: boolean; error?: string }> = [];

    for (const device of pending) {
      try {
        // eslint-disable-next-line no-await-in-loop -- sequential device approval required
        await callRpc(sandbox, token, 'device.pair.approve', { requestId: device.requestId });
        results.push({ requestId: device.requestId, success: true });
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

      // Check for sync marker file via rclone
      const bucket = getR2BucketName(c.env);
      const result = await execWithTimeout(sandbox,
        `rclone cat r2:${bucket}/.last-sync 2>/dev/null || echo ""`,
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

// POST /api/admin/gateway/restart - Kill ALL processes and start a new gateway
adminApi.post('/gateway/restart', async (c) => {
  const sandbox = c.get('sandbox');

  try {
    console.log('Restart Gateway: killing all processes and cleaning up...');
    await killAllGatewayProcesses(sandbox);

    console.log('Restart Gateway: starting new gateway...');
    const bootPromise = ensureMoltbotGateway(sandbox, c.env).catch((err) => {
      console.error('Gateway restart failed:', err);
    });
    c.executionCtx.waitUntil(bootPromise);

    return c.json({
      success: true,
      message: '全プロセス停止完了。ゲートウェイを再起動中です。',
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// Stage 2: Destroy the entire container (with optional skipSync for sync failure scenarios)
adminApi.post('/gateway/destroy', async (c) => {
  const sandbox = c.get('sandbox');
  const skipSync = c.req.query('skipSync') === 'true';

  try {
    if (skipSync) {
      // User explicitly chose to skip sync (e.g., sync is failing)
      console.log('Container destroy: skipSync=true, skipping R2 sync...');
    } else {
      // Attempt R2 sync before destruction
      console.log('Container destroy: syncing data to R2 before destroy...');
      try {
        const syncResult = await syncToR2(sandbox, c.env);
        if (!syncResult.success) {
          console.error('Container destroy: R2 sync failed:', syncResult.error);
          const baseUrl = new URL(c.req.url);
          const retryUrl = `${baseUrl.origin}/api/admin/gateway/destroy?skipSync=true`;
          return c.json({
            success: false,
            error: 'R2 sync failed. Container NOT destroyed to prevent data loss.',
            syncError: syncResult.error,
            hint: 'If sync is failing and will never succeed, retry with skipSync=true to force destroy.',
            retryUrl,
          }, 500);
        }
        console.log('Container destroy: R2 sync OK');
      } catch (syncError) {
        console.error('Container destroy: R2 sync threw:', syncError);
        const baseUrl = new URL(c.req.url);
        const retryUrl = `${baseUrl.origin}/api/admin/gateway/destroy?skipSync=true`;
        return c.json({
          success: false,
          error: `R2 sync error: ${String(syncError)}`,
          hint: 'If sync is failing and will never succeed, retry with skipSync=true to force destroy.',
          retryUrl,
        }, 500);
      }
    }

    console.log('Container destroy: destroying container...');
    await sandbox.destroy();
    return c.json({
      success: true,
      message: skipSync
        ? 'Container destroyed WITHOUT R2 sync. Data since last successful sync may be lost.'
        : 'Container destroyed after successful R2 sync. Gateway will restart on next request.',
      skipSync,
    });
  } catch (error) {
    console.error('Error during container destroy:', error);
    return c.json({ success: false, error: String(error) }, 500);
  }
});

// DELETE /api/admin/devices/:deviceId - Remove a paired device
adminApi.delete('/devices/:deviceId', async (c) => {
  const sandbox = c.get('sandbox');
  const deviceId = c.req.param('deviceId');

  if (!deviceId) {
    return c.json({ error: 'deviceId is required' }, 400);
  }

  // Validate deviceId format (alphanumeric, hyphens, underscores only)
  if (!/^[\w-]+$/.test(deviceId)) {
    return c.json({ error: 'Invalid deviceId format' }, 400);
  }

  try {
    // Ensure moltbot is running first
    await ensureMoltbotGateway(sandbox, c.env);

    const token = c.env.MOLTBOT_GATEWAY_TOKEN || '';
    await callRpc(sandbox, token, 'device.pair.remove', { deviceId });

    return c.json({
      success: true,
      deviceId,
      message: 'Device removed',
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// POST /api/admin/token-refresh - Refresh GCP token + restart gateway to apply
adminApi.post('/token-refresh', async (c) => {
  const sandbox = c.get('sandbox');

  if (!c.env.GCP_SERVICE_ACCOUNT_KEY) {
    return c.json({ success: false, error: 'GCP/Vertex AI is not configured' }, 400);
  }

  try {
    console.log('Token refresh triggered from Admin UI');
    const gatewayToken = c.env.MOLTBOT_GATEWAY_TOKEN || '';
    const refreshCmd = `OPENCLAW_GATEWAY_TOKEN="${gatewayToken}" bash /usr/local/bin/refresh-gcp-token.sh`;
    const refreshResult = await execWithTimeout(sandbox,refreshCmd, { timeout: 20000 });
    const output = refreshResult.stdout?.trim() || '';
    const exitCode = refreshResult.exitCode ?? 0;
    console.log('Token refresh result (exit=' + exitCode + '):', output);

    if (exitCode === 1) {
      return c.json({ success: false, error: 'トークン取得に失敗: ' + output }, 500);
    }

    // exit 2 = config.apply failed, need gateway restart
    if (exitCode === 2) {
      console.log('config.apply failed, killing all + restarting gateway...');
      // Clear refresh timestamp so start-openclaw.sh's refresh won't skip
      // (R2 restore overwrites the fresh token in config file)
      await execWithTimeout(sandbox,'rm -f /tmp/gcp-token-last-refresh', { timeout: 5000 }).catch(() => {});
      await killAllGatewayProcesses(sandbox);
      const bootPromise = ensureMoltbotGateway(sandbox, c.env).catch((err) => {
        console.error('Gateway restart after token refresh failed:', err);
      });
      c.executionCtx.waitUntil(bootPromise);

      return c.json({
        success: true,
        message: 'トークン更新完了。ゲートウェイを再起動中です（30〜60秒で復旧）。',
        gatewayRestarted: true,
      });
    }

    return c.json({
      success: true,
      message: 'トークン更新・反映完了。',
      gatewayRestarted: false,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ success: false, error: errorMessage }, 500);
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

// GET /api/admin/token-status - Get GCP token status
adminApi.get('/token-status', async (c) => {
  const sandbox = c.get('sandbox');
  const hasGcp = !!c.env.GCP_SERVICE_ACCOUNT_KEY;

  if (!hasGcp) {
    return c.json({ configured: false, message: 'GCP/Vertex AI is not configured' });
  }

  try {
    const result = await execWithTimeout(sandbox,
      'cat /tmp/gcp-token-last-refresh 2>/dev/null || echo "0"',
      { timeout: 5000 },
    );
    const lastRefreshEpoch = parseInt(result.stdout?.trim() || '0', 10);
    const nowEpoch = Math.floor(Date.now() / 1000);
    const elapsed = nowEpoch - lastRefreshEpoch;
    // GCP tokens are valid for 3600 seconds (1 hour)
    const tokenLifetime = 3600;
    const remaining = Math.max(0, tokenLifetime - elapsed);

    return c.json({
      configured: true,
      lastRefreshEpoch,
      lastRefreshTime: lastRefreshEpoch > 0 ? new Date(lastRefreshEpoch * 1000).toISOString() : null,
      elapsedSeconds: elapsed,
      remainingSeconds: remaining,
      expired: remaining === 0,
      status: remaining === 0 ? 'expired' : remaining < 600 ? 'expiring_soon' : 'valid',
    });
  } catch {
    return c.json({ configured: true, error: 'Failed to check token status' }, 500);
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
