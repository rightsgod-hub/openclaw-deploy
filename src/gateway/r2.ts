import type { Sandbox } from '@cloudflare/sandbox';
import type { MoltbotEnv } from '../types';
import { R2_MOUNT_PATH, getR2BucketName } from '../config';

/**
 * Mount R2 bucket for persistent storage
 * Skip redundant mount checks - just attempt mount and handle "already mounted" errors
 *
 * @param sandbox - The sandbox instance
 * @param env - Worker environment bindings
 * @returns true if mounted successfully, false otherwise
 */
export async function mountR2Storage(sandbox: Sandbox, env: MoltbotEnv): Promise<boolean> {
  // Skip if R2 credentials are not configured
  if (!env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY || !env.CF_ACCOUNT_ID) {
    console.log(
      'R2 storage not configured (missing R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, or CF_ACCOUNT_ID)',
    );
    return false;
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
    return true;
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    // "already mounted" is success
    if (errorMessage.includes('already mounted') || errorMessage.includes('EEXIST')) {
      console.log('R2 bucket already mounted at', R2_MOUNT_PATH);
      return true;
    }

    // Don't fail if mounting fails - moltbot can still run without persistent storage
    console.error('Failed to mount R2 bucket:', err);
    return false;
  }
}
