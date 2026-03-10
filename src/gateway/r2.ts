import type { Sandbox } from '@cloudflare/sandbox';
import type { MoltbotEnv } from '../types';
import { getR2BucketName } from '../config';

// Module-level cache: once rclone is configured, skip on subsequent calls.
// This flag resets naturally when the Durable Object resets (module reloads).
let rcloneConfigured = false;

/**
 * Reset the rclone config cache (for testing only)
 */
export function resetR2MountCache(): void {
  rcloneConfigured = false;
}

/**
 * Configure rclone for Cloudflare R2 access.
 *
 * Replaces the old s3fs FUSE mount approach (sandbox.mountBucket) with
 * direct rclone operations. No FUSE kernel dependency, no lazy listing,
 * no mount hangs.
 *
 * @param sandbox - The sandbox instance
 * @param env - Worker environment bindings
 * @returns true if configured successfully, false otherwise
 */
export async function mountR2Storage(sandbox: Sandbox, env: MoltbotEnv): Promise<boolean> {
  if (rcloneConfigured) {
    return true;
  }

  if (!env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY || !env.CF_ACCOUNT_ID) {
    console.log(
      'R2 storage not configured (missing R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, or CF_ACCOUNT_ID)',
    );
    return false;
  }

  const bucketName = getR2BucketName(env);
  const endpoint = `https://${env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com`;

  const configContent = [
    '[r2]',
    'type = s3',
    'provider = Cloudflare',
    `access_key_id = ${env.R2_ACCESS_KEY_ID}`,
    `secret_access_key = ${env.R2_SECRET_ACCESS_KEY}`,
    `endpoint = ${endpoint}`,
    'region = auto',
    'no_check_bucket = true',
    '',
  ].join('\n');

  try {
    // Write rclone config using shell heredoc (no node dependency, INI stays INI)
    const mkdirCmd = `mkdir -p /root/.config/rclone`;
    const writeCmd = `cat > /root/.config/rclone/rclone.conf << 'RCLONEEOF'\n${configContent}RCLONEEOF`;
    await sandbox.exec(mkdirCmd, { timeout: 5000 });
    await sandbox.exec(writeCmd, { timeout: 5000 });
    rcloneConfigured = true;
    console.log('rclone configured for R2 bucket:', bucketName, 'at', endpoint);
    return true;
  } catch (err) {
    console.error('Failed to configure rclone:', err instanceof Error ? err.message : String(err));
    return false;
  }
}
