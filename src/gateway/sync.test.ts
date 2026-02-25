import { describe, it, expect, beforeEach } from 'vitest';
import { syncToR2 } from './sync';
import { resetR2MountCache } from './r2';
import {
  createMockEnv,
  createMockEnvWithR2,
  createMockProcess,
  createMockSandbox,
  suppressConsole,
} from '../test-utils';

describe('syncToR2', () => {
  beforeEach(() => {
    suppressConsole();
    resetR2MountCache();
  });

  describe('configuration checks', () => {
    it('returns error when R2 is not configured', async () => {
      const { sandbox } = createMockSandbox();
      const env = createMockEnv();

      const result = await syncToR2(sandbox, env);

      expect(result.success).toBe(false);
      expect(result.error).toBe('R2 storage is not configured');
    });

    it('returns error when mount fails', async () => {
      const { sandbox, execMock, mountBucketMock } = createMockSandbox();
      execMock.mockResolvedValue({ exitCode: 1, stdout: '', stderr: '', command: '', durationMs: 0 });
      mountBucketMock.mockRejectedValue(new Error('Mount failed'));

      const env = createMockEnvWithR2();

      const result = await syncToR2(sandbox, env);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Failed to mount R2 storage');
    });
  });

  describe('sanity checks', () => {
    it('returns error when source has no config file', async () => {
      const { sandbox, execMock } = createMockSandbox();
      // Calls: check openclaw.json, check clawdbot.json
      execMock
        .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '', command: '', durationMs: 0 }) // No openclaw.json
        .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '', command: '', durationMs: 0 }); // No clawdbot.json either

      const env = createMockEnvWithR2();

      const result = await syncToR2(sandbox, env);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Sync aborted: no config file found');
    });
  });

  describe('sync execution', () => {
    it('returns success when sync completes', async () => {
      const { sandbox, execMock } = createMockSandbox();
      const timestamp = '2026-01-27T12:00:00+00:00';

      // Calls: check openclaw.json, rsync, cat timestamp
      execMock
        .mockResolvedValueOnce({ exitCode: 0, stdout: 'ok', stderr: '', command: '', durationMs: 0 })
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '', command: '', durationMs: 0 })
        .mockResolvedValueOnce({ exitCode: 0, stdout: timestamp, stderr: '', command: '', durationMs: 0 });

      const env = createMockEnvWithR2();

      const result = await syncToR2(sandbox, env);

      expect(result.success).toBe(true);
      expect(result.lastSync).toBe(timestamp);
    });

    it('returns error when rsync fails (no timestamp created)', async () => {
      const { sandbox, execMock } = createMockSandbox();

      // Calls: check openclaw.json, rsync (fails), cat timestamp (empty)
      execMock
        .mockResolvedValueOnce({ exitCode: 0, stdout: 'ok', stderr: '', command: '', durationMs: 0 })
        .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '', command: '', durationMs: 0 })
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '', command: '', durationMs: 0 });

      const env = createMockEnvWithR2();

      const result = await syncToR2(sandbox, env);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Sync failed');
    });

    it('verifies rsync command is called with correct flags', async () => {
      const { sandbox, execMock } = createMockSandbox();
      const timestamp = '2026-01-27T12:00:00+00:00';

      execMock
        .mockResolvedValueOnce({ exitCode: 0, stdout: 'ok', stderr: '', command: '', durationMs: 0 })
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '', command: '', durationMs: 0 })
        .mockResolvedValueOnce({ exitCode: 0, stdout: timestamp, stderr: '', command: '', durationMs: 0 });

      const env = createMockEnvWithR2();

      await syncToR2(sandbox, env);

      // Second call should be rsync to openclaw/ R2 prefix
      const rsyncCall = execMock.mock.calls[1][0];
      expect(rsyncCall).toContain('rsync');
      expect(rsyncCall).toContain('--no-times');
      expect(rsyncCall).toContain('--delete');
      expect(rsyncCall).toContain('/root/.openclaw/');
      expect(rsyncCall).toContain('/data/moltbot/openclaw/');
    });
  });
});
