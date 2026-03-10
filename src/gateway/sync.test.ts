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

    it('returns error when rclone config fails', async () => {
      const { sandbox, execMock } = createMockSandbox();
      execMock.mockRejectedValue(new Error('exec failed'));

      const env = createMockEnvWithR2();

      const result = await syncToR2(sandbox, env);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Failed to configure rclone for R2');
    });
  });

  describe('sanity checks', () => {
    it('returns error when source has no config file', async () => {
      const { sandbox, execMock } = createMockSandbox();
      // Calls: rclone mkdir (OK), rclone config write (OK), check openclaw.json (FAIL), check clawdbot.json (FAIL)
      execMock
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '', command: '', durationMs: 0 }) // mkdir
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '', command: '', durationMs: 0 }) // rclone config write
        .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '', command: '', durationMs: 0 }) // No openclaw.json
        .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '', command: '', durationMs: 0 }); // No clawdbot.json either

      const env = createMockEnvWithR2();

      const result = await syncToR2(sandbox, env);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Sync aborted: no config file found');
    });

    it('returns error when workspace IDENTITY.md is missing or template', async () => {
      const { sandbox, execMock } = createMockSandbox();
      // Calls: mkdir (OK), rclone config (OK), check openclaw.json (OK), check IDENTITY.md (FAIL)
      execMock
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '', command: '', durationMs: 0 }) // mkdir
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '', command: '', durationMs: 0 }) // rclone config write
        .mockResolvedValueOnce({ exitCode: 0, stdout: 'ok', stderr: '', command: '', durationMs: 0 }) // openclaw.json exists
        .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '', command: '', durationMs: 0 }); // IDENTITY.md missing

      const env = createMockEnvWithR2();

      const result = await syncToR2(sandbox, env);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Sync aborted: workspace not initialized');
    });
  });

  describe('sync execution', () => {
    it('returns success when sync completes', async () => {
      const { sandbox, execMock } = createMockSandbox();
      const timestamp = '2026-01-27T12:00:00+00:00';

      // Calls: mkdir, rclone config, check openclaw.json, check IDENTITY.md, rclone copy, read timestamp
      execMock
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '', command: '', durationMs: 0 }) // mkdir
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '', command: '', durationMs: 0 }) // rclone config
        .mockResolvedValueOnce({ exitCode: 0, stdout: 'ok', stderr: '', command: '', durationMs: 0 }) // openclaw.json
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '', command: '', durationMs: 0 }) // IDENTITY.md
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '', command: '', durationMs: 0 }) // rclone copy
        .mockResolvedValueOnce({ exitCode: 0, stdout: timestamp, stderr: '', command: '', durationMs: 0 }); // timestamp

      const env = createMockEnvWithR2();

      const result = await syncToR2(sandbox, env);

      expect(result.success).toBe(true);
      expect(result.lastSync).toBe(timestamp);
    });

    it('returns error when rclone copy exits non-zero', async () => {
      const { sandbox, execMock } = createMockSandbox();

      // Calls: mkdir, rclone config, check openclaw.json, check IDENTITY.md, rclone copy (fails)
      execMock
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '', command: '', durationMs: 0 }) // mkdir
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '', command: '', durationMs: 0 }) // rclone config
        .mockResolvedValueOnce({ exitCode: 0, stdout: 'ok', stderr: '', command: '', durationMs: 0 }) // openclaw.json
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '', command: '', durationMs: 0 }) // IDENTITY.md
        .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'rclone error', command: '', durationMs: 0 }); // rclone copy fails

      const env = createMockEnvWithR2();

      const result = await syncToR2(sandbox, env);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Sync failed');
    });

    it('verifies rclone copy command is called with correct flags', async () => {
      const { sandbox, execMock } = createMockSandbox();
      const timestamp = '2026-01-27T12:00:00+00:00';

      // Calls: mkdir, rclone config, check openclaw.json, check IDENTITY.md, rclone copy, timestamp
      execMock
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '', command: '', durationMs: 0 }) // mkdir
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '', command: '', durationMs: 0 }) // rclone config
        .mockResolvedValueOnce({ exitCode: 0, stdout: 'ok', stderr: '', command: '', durationMs: 0 }) // openclaw.json
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '', command: '', durationMs: 0 }) // IDENTITY.md
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '', command: '', durationMs: 0 }) // rclone copy
        .mockResolvedValueOnce({ exitCode: 0, stdout: timestamp, stderr: '', command: '', durationMs: 0 }); // timestamp

      const env = createMockEnvWithR2();

      await syncToR2(sandbox, env);

      // Fifth call (index 4) should be rclone copy
      const syncCall = execMock.mock.calls[4][0];
      expect(syncCall).toContain('rclone copy');
      expect(syncCall).toContain('--no-update-modtime');
      expect(syncCall).toContain('/root/.openclaw/');
      expect(syncCall).toContain('r2:moltbot-data/openclaw/');
    });
  });
});
