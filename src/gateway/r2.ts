import type { Sandbox } from '@cloudflare/sandbox';
import type { MoltbotEnv } from '../types';
import { R2_MOUNT_PATH, getR2BucketName } from '../config';

// Module-level cache: once R2 mount is confirmed, skip process spawning on subsequent calls.
// This flag resets naturally when the Durable Object resets (module reloads).
let r2MountConfirmed = false;

/**
 * Reset the R2 mount cache (for testing only)
 */
export function resetR2MountCache(): void {
  r2MountConfirmed = false;
}

/**
 * Check if R2 is already mounted by looking at the mount table
 */
async function isR2Mounted(sandbox: Sandbox): Promise<boolean> {
  try {
    const result = await sandbox.exec(`mount | grep "s3fs on ${R2_MOUNT_PATH}"`, { timeout: 5000 });
    const mounted = !!(result.stdout && result.stdout.includes('s3fs'));
    console.log('isR2Mounted check:', mounted, 'stdout:', result.stdout?.slice(0, 100));
    return mounted;
  } catch (err) {
    console.log('isR2Mounted error:', err);
    return false;
  }
}

/**
 * Mount R2 bucket for persistent storage
 *
 * @param sandbox - The sandbox instance
 * @param env - Worker environment bindings
 * @returns true if mounted successfully, false otherwise
 */
export async function mountR2Storage(sandbox: Sandbox, env: MoltbotEnv): Promise<boolean> {
  // Return immediately if mount was already confirmed - no process spawning needed
  if (r2MountConfirmed) {
    return true;
  }

  // Skip if R2 credentials are not configured
  if (!env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY || !env.CF_ACCOUNT_ID) {
    console.log(
      'R2 storage not configured (missing R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, or CF_ACCOUNT_ID)',
    );
    return false;
  }

  // Check if already mounted first - this avoids errors and is faster
  if (await isR2Mounted(sandbox)) {
    console.log('R2 bucket already mounted at', R2_MOUNT_PATH);
    r2MountConfirmed = true;
    return true;
  }

  const bucketName = getR2BucketName(env);
  try {
    console.log('Mounting R2 bucket', bucketName, 'at', R2_MOUNT_PATH);
    await sandbox.mountBucket(bucketName, R2_MOUNT_PATH, {
      endpoint: `https://${env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      // Pass credentials explicitly since we use R2_* naming instead of AWS_*
      credentials: {
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      },
    });
    console.log('R2 bucket mounted successfully - moltbot data will persist across sessions');
    r2MountConfirmed = true;
    return true;
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.log('R2 mount error:', errorMessage);

    // Check again if it's mounted - the error might be misleading
    if (await isR2Mounted(sandbox)) {
      console.log('R2 bucket is mounted despite error');
      r2MountConfirmed = true;
      return true;
    }

    // Don't fail if mounting fails - moltbot can still run without persistent storage
    console.error('Failed to mount R2 bucket:', err);
    return false;
  }
}
