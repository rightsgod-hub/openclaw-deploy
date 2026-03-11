import type { Sandbox } from '@cloudflare/sandbox';

export class ExecTimeoutError extends Error {
  constructor(public readonly timeoutMs: number, public readonly command: string) {
    super(`exec timed out after ${timeoutMs}ms: ${command.substring(0, 80)}`);
    this.name = 'ExecTimeoutError';
  }
}

/**
 * Execute a command in the sandbox with a hard timeout enforced via Promise.race.
 *
 * sandbox.exec()'s built-in timeout parameter is unreliable during DO alarm cycles.
 * This wrapper adds a client-side timeout that always fires, preventing Worker hangs.
 */
export async function execWithTimeout(
  sandbox: Sandbox,
  command: string,
  options: { timeout?: number } = {},
): Promise<{ stdout?: string; stderr?: string; exitCode?: number }> {
  const timeout = options.timeout ?? 10000;

  return Promise.race([
    sandbox.exec(command, { timeout }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new ExecTimeoutError(timeout, command)), timeout)
    ),
  ]);
}
