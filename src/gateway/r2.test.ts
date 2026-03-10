import { describe, it, expect, beforeEach } from 'vitest';
import { mountR2Storage, resetR2MountCache } from './r2';
import {
  createMockEnv,
  createMockEnvWithR2,
  createMockProcess,
  createMockSandbox,
  suppressConsole,
} from '../test-utils';

describe('mountR2Storage', () => {
  beforeEach(() => {
    suppressConsole();
    resetR2MountCache();
  });

  describe('credential validation', () => {
    it('returns false when R2_ACCESS_KEY_ID is missing', async () => {
      const { sandbox } = createMockSandbox();
      const env = createMockEnv({
        R2_SECRET_ACCESS_KEY: 'secret',
        CF_ACCOUNT_ID: 'account123',
      });

      const result = await mountR2Storage(sandbox, env);

      expect(result).toBe(false);
    });

    it('returns false when R2_SECRET_ACCESS_KEY is missing', async () => {
      const { sandbox } = createMockSandbox();
      const env = createMockEnv({
        R2_ACCESS_KEY_ID: 'key123',
        CF_ACCOUNT_ID: 'account123',
      });

      const result = await mountR2Storage(sandbox, env);

      expect(result).toBe(false);
    });

    it('returns false when CF_ACCOUNT_ID is missing', async () => {
      const { sandbox } = createMockSandbox();
      const env = createMockEnv({
        R2_ACCESS_KEY_ID: 'key123',
        R2_SECRET_ACCESS_KEY: 'secret',
      });

      const result = await mountR2Storage(sandbox, env);

      expect(result).toBe(false);
    });

    it('returns false when all R2 credentials are missing', async () => {
      const { sandbox } = createMockSandbox();
      const env = createMockEnv();

      const result = await mountR2Storage(sandbox, env);

      expect(result).toBe(false);
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('R2 storage not configured'),
      );
    });
  });

  describe('rclone configuration', () => {
    it('configures rclone when credentials provided', async () => {
      const { sandbox, execMock } = createMockSandbox();
      execMock.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '', command: '', durationMs: 0 });
      const env = createMockEnvWithR2({
        R2_ACCESS_KEY_ID: 'key123',
        R2_SECRET_ACCESS_KEY: 'secret',
        CF_ACCOUNT_ID: 'account123',
      });

      const result = await mountR2Storage(sandbox, env);

      expect(result).toBe(true);
      expect(execMock).toHaveBeenCalledTimes(2);
      // Verify mkdir and heredoc write calls
      const mkdirCall = execMock.mock.calls[0][0];
      expect(mkdirCall).toContain('mkdir -p /root/.config/rclone');
      const writeCall = execMock.mock.calls[1][0];
      expect(writeCall).toContain('rclone.conf');
      expect(writeCall).toContain('key123');
    });

    it('uses custom bucket name from R2_BUCKET_NAME env var', async () => {
      const { sandbox, execMock } = createMockSandbox();
      execMock.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '', command: '', durationMs: 0 });
      const env = createMockEnvWithR2({
        R2_ACCESS_KEY_ID: 'key123',
        R2_SECRET_ACCESS_KEY: 'secret',
        CF_ACCOUNT_ID: 'account123',
        R2_BUCKET_NAME: 'moltbot-e2e-test123',
      });

      const result = await mountR2Storage(sandbox, env);

      expect(result).toBe(true);
      expect(console.log).toHaveBeenCalledWith(
        'rclone configured for R2 bucket:',
        'moltbot-e2e-test123',
        'at',
        'https://account123.r2.cloudflarestorage.com',
      );
    });

    it('logs success message when configured successfully', async () => {
      const { sandbox, execMock } = createMockSandbox();
      execMock.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '', command: '', durationMs: 0 });
      const env = createMockEnvWithR2();

      await mountR2Storage(sandbox, env);

      expect(console.log).toHaveBeenCalledWith(
        'rclone configured for R2 bucket:',
        'moltbot-data',
        'at',
        'https://test-account-id.r2.cloudflarestorage.com',
      );
    });
  });

  describe('error handling', () => {
    it('returns false when exec throws', async () => {
      const { sandbox, execMock } = createMockSandbox();
      execMock.mockRejectedValue(new Error('exec failed'));

      const env = createMockEnvWithR2();

      const result = await mountR2Storage(sandbox, env);

      expect(result).toBe(false);
      expect(console.error).toHaveBeenCalledWith('Failed to configure rclone:', 'exec failed');
    });
  });

  describe('config cache', () => {
    it('skips exec on second call after successful config', async () => {
      const { sandbox, execMock } = createMockSandbox();
      execMock.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '', command: '', durationMs: 0 });
      const env = createMockEnvWithR2();

      // First call - configures rclone (mkdir + write = 2 calls)
      const result1 = await mountR2Storage(sandbox, env);
      expect(result1).toBe(true);
      expect(execMock).toHaveBeenCalledTimes(2);

      // Second call - should return immediately without calling exec
      const result2 = await mountR2Storage(sandbox, env);
      expect(result2).toBe(true);
      expect(execMock).toHaveBeenCalledTimes(2); // not called again
    });

    it('resets cache with resetR2MountCache', async () => {
      const { sandbox, execMock } = createMockSandbox();
      execMock.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '', command: '', durationMs: 0 });
      const env = createMockEnvWithR2();

      // First call (mkdir + write = 2 calls)
      await mountR2Storage(sandbox, env);
      expect(execMock).toHaveBeenCalledTimes(2);

      // Reset cache
      resetR2MountCache();

      // Second call - should configure again (2 more calls)
      await mountR2Storage(sandbox, env);
      expect(execMock).toHaveBeenCalledTimes(4);
    });
  });
});
