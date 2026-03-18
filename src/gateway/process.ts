import type { Sandbox, Process } from '@cloudflare/sandbox';
import type { MoltbotEnv } from '../types';
import { MOLTBOT_PORT, STARTUP_TIMEOUT_MS } from '../config';
import { buildEnvVars } from './env';
import { ensureRcloneConfig } from './r2';

// Singleton promise to prevent concurrent gateway startups.
// When ensureMoltbotGateway is called while another call is in-flight,
// the second call returns the same promise instead of starting a new process.
let ensureInFlight: Promise<Process> | null = null;

/**
 * Find an existing OpenClaw gateway process
 *
 * @param sandbox - The sandbox instance
 * @returns The process if found and running/starting, null otherwise
 */
export async function findExistingMoltbotProcess(sandbox: Sandbox): Promise<Process | null> {
  try {
    // Clean up dead process records (killed/failed/completed/error) from the list
    try {
      const cleaned = await sandbox.cleanupCompletedProcesses();
      if (cleaned > 0) {
        console.log(`[Gateway] Cleaned up ${cleaned} completed process records`);
      }
    } catch (e) {
      console.error('[Gateway] Failed to cleanup completed processes:', e);
    }

    const processes = await sandbox.listProcesses();
    for (const proc of processes) {
      // Match gateway process (openclaw gateway or legacy clawdbot gateway)
      // Don't match CLI commands like "openclaw devices list"
      const isGatewayProcess =
        proc.command.includes('start-openclaw.sh') ||
        proc.command.includes('openclaw gateway') ||
        // Legacy: match old startup script during transition
        proc.command.includes('start-moltbot.sh') ||
        proc.command.includes('clawdbot gateway');
      const isCliCommand =
        proc.command.includes('openclaw devices') ||
        proc.command.includes('openclaw --version') ||
        proc.command.includes('openclaw onboard') ||
        proc.command.includes('clawdbot devices') ||
        proc.command.includes('clawdbot --version');

      if (isGatewayProcess && !isCliCommand) {
        if (proc.status === 'starting' || proc.status === 'running') {
          return proc;
        }
      }
    }
  } catch (e) {
    // Re-throw DO infrastructure errors - these indicate the sandbox is unhealthy
    // and callers should not attempt to start new processes
    const msg = e instanceof Error ? e.message : String(e);
    if (
      msg.includes('internal error') ||
      msg.includes('The Durable Object') ||
      msg.includes('sandbox') ||
      msg.includes('Network connection lost')
    ) {
      throw e;
    }
    console.log('Could not list processes:', e);
  }
  return null;
}

/**
 * Ensure the OpenClaw gateway is running
 *
 * This will:
 * 1. Mount R2 storage if configured
 * 2. Check for an existing gateway process
 * 3. Wait for it to be ready, or start a new one
 *
 * Concurrent calls are deduplicated via a singleton promise:
 * if a startup is already in-flight, subsequent callers receive
 * the same promise instead of starting a new process.
 *
 * @param sandbox - The sandbox instance
 * @param env - Worker environment bindings
 * @returns The running gateway process
 */
export async function ensureMoltbotGateway(sandbox: Sandbox, env: MoltbotEnv): Promise<Process> {
  if (ensureInFlight) {
    console.log('[Gateway] Concurrent call detected, reusing in-flight startup promise');
    return ensureInFlight;
  }
  ensureInFlight = ensureMoltbotGatewayImpl(sandbox, env).finally(() => {
    ensureInFlight = null;
  });
  return ensureInFlight;
}

async function ensureMoltbotGatewayImpl(sandbox: Sandbox, env: MoltbotEnv): Promise<Process> {
  // Fast path: if gateway is already running and reachable, return immediately
  // without any sandbox.exec calls (ensureRcloneConfig) to minimize DO load
  const existingProcess = await findExistingMoltbotProcess(sandbox);
  if (existingProcess) {
    console.log(
      'Found existing gateway process:',
      existingProcess.id,
      'status:',
      existingProcess.status,
    );

    console.log(`[Gateway] Waiting for port ${MOLTBOT_PORT} (status: ${existingProcess.status})`);

    try {
      await existingProcess.waitForPort(MOLTBOT_PORT, { mode: 'tcp' });
      console.log('[Gateway] Gateway is reachable');
      return existingProcess;
    } catch (_e) {
      console.log('[Gateway] Existing process not reachable, killing and restarting...');
      try {
        await existingProcess.kill();
      } catch (killError) {
        console.log('Failed to kill process:', killError);
      }
    }
  }

  // Full startup path: configure rclone and start new process
  // Configure rclone for R2 persistence (non-blocking if not configured).
  // The startup script uses rclone to restore data from R2 on boot.
  await ensureRcloneConfig(sandbox, env);

  // Start a new OpenClaw gateway
  console.log('Starting new OpenClaw gateway...');
  const envVars = buildEnvVars(env);
  const command = '/usr/local/bin/start-openclaw.sh';

  console.log('Starting process with command:', command);
  console.log('Environment vars being passed:', Object.keys(envVars));

  let process: Process;
  try {
    process = await sandbox.startProcess(command, {
      env: Object.keys(envVars).length > 0 ? envVars : undefined,
    });
    console.log('Process started with id:', process.id, 'status:', process.status);
  } catch (startErr) {
    console.error('Failed to start process:', startErr);
    throw startErr;
  }

  // Kill duplicate gateway processes that may have been started by concurrent requests
  try {
    const allProcesses = await sandbox.listProcesses();
    for (const proc of allProcesses) {
      if (proc.id === process.id) continue;

      const isGatewayProcess =
        proc.command.includes('start-openclaw.sh') ||
        proc.command.includes('openclaw gateway') ||
        proc.command.includes('start-moltbot.sh') ||
        proc.command.includes('clawdbot gateway');
      const isCliCommand =
        proc.command.includes('openclaw devices') ||
        proc.command.includes('openclaw --version') ||
        proc.command.includes('openclaw onboard') ||
        proc.command.includes('clawdbot devices') ||
        proc.command.includes('clawdbot --version');

      if (isGatewayProcess && !isCliCommand) {
        if (proc.status === 'starting' || proc.status === 'running') {
          try {
            await proc.kill();
            console.log('Killed duplicate gateway process:', proc.id);
          } catch (_killErr) {
            // Process may have already exited
            console.log('Failed to kill duplicate process (may have already exited):', proc.id);
          }
        }
      }
    }
  } catch (listErr) {
    // Non-fatal: if we can't list processes, proceed with startup
    console.log('Could not list processes for duplicate cleanup:', listErr);
  }

  // Wait for the gateway to be ready
  try {
    console.log('[Gateway] Waiting for OpenClaw gateway to be ready on port', MOLTBOT_PORT);
    await process.waitForPort(MOLTBOT_PORT, { mode: 'tcp', timeout: STARTUP_TIMEOUT_MS });
    console.log('[Gateway] OpenClaw gateway is ready!');

    const logs = await process.getLogs();
    if (logs.stdout) console.log('[Gateway] stdout:', logs.stdout);
    if (logs.stderr) console.log('[Gateway] stderr:', logs.stderr);
  } catch (e) {
    console.error('[Gateway] waitForPort failed:', e);
    try {
      const logs = await process.getLogs();
      console.error('[Gateway] startup failed. Stderr:', logs.stderr);
      console.error('[Gateway] startup failed. Stdout:', logs.stdout);
      throw new Error(`OpenClaw gateway failed to start. Stderr: ${logs.stderr || '(empty)'}`, {
        cause: e,
      });
    } catch (logErr) {
      console.error('[Gateway] Failed to get logs:', logErr);
      throw e;
    }
  }

  // Verify gateway is actually responding
  console.log('[Gateway] Verifying gateway health...');

  return process;
}
