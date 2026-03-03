import { describe, it, expect, vi, beforeEach } from 'vitest';
import { findExistingMoltbotProcess, ensureMoltbotGateway, isGatewayPortResponding } from './process';
import type { Sandbox, Process } from '@cloudflare/sandbox';
import { createMockSandbox, suppressConsole } from '../test-utils';

vi.mock('./r2', () => ({
  mountR2Storage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./env', () => ({
  buildEnvVars: vi.fn().mockReturnValue({}),
}));

function createFullMockProcess(overrides: Partial<Process> = {}): Process {
  return {
    id: 'test-id',
    command: 'openclaw gateway',
    status: 'running',
    startTime: new Date(),
    endTime: undefined,
    exitCode: undefined,
    waitForPort: vi.fn(),
    kill: vi.fn(),
    getLogs: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
    ...overrides,
  } as Process;
}

describe('isGatewayPortResponding', () => {
  beforeEach(() => {
    suppressConsole();
  });

  it('returns true when port is responding', async () => {
    const sandbox = {
      exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: 'yes\n', stderr: '', command: '', durationMs: 0 }),
    } as unknown as Sandbox;

    const result = await isGatewayPortResponding(sandbox);
    expect(result).toBe(true);
  });

  it('returns false when port is not responding', async () => {
    const sandbox = {
      exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: 'no\n', stderr: '', command: '', durationMs: 0 }),
    } as unknown as Sandbox;

    const result = await isGatewayPortResponding(sandbox);
    expect(result).toBe(false);
  });

  it('returns false when exec throws', async () => {
    const sandbox = {
      exec: vi.fn().mockRejectedValue(new Error('timeout')),
    } as unknown as Sandbox;

    const result = await isGatewayPortResponding(sandbox);
    expect(result).toBe(false);
  });
});

describe('findExistingMoltbotProcess', () => {
  it('returns null when no processes exist', async () => {
    const { sandbox } = createMockSandbox({ processes: [] });
    const result = await findExistingMoltbotProcess(sandbox);
    expect(result).toBeNull();
  });

  it('returns null when only CLI commands are running', async () => {
    const processes = [
      createFullMockProcess({ command: 'openclaw devices list --json', status: 'running' }),
      createFullMockProcess({ command: 'openclaw --version', status: 'completed' }),
    ];
    const { sandbox, listProcessesMock } = createMockSandbox();
    listProcessesMock.mockResolvedValue(processes);

    const result = await findExistingMoltbotProcess(sandbox);
    expect(result).toBeNull();
  });

  it('returns gateway process when running (openclaw)', async () => {
    const gatewayProcess = createFullMockProcess({
      id: 'gateway-1',
      command: 'openclaw gateway --port 18789',
      status: 'running',
    });
    const processes = [
      createFullMockProcess({ command: 'openclaw devices list', status: 'completed' }),
      gatewayProcess,
    ];
    const { sandbox, listProcessesMock } = createMockSandbox();
    listProcessesMock.mockResolvedValue(processes);

    const result = await findExistingMoltbotProcess(sandbox);
    expect(result).toBe(gatewayProcess);
  });

  it('returns gateway process when starting via startup script', async () => {
    const gatewayProcess = createFullMockProcess({
      id: 'gateway-1',
      command: '/usr/local/bin/start-openclaw.sh',
      status: 'starting',
    });
    const { sandbox, listProcessesMock } = createMockSandbox();
    listProcessesMock.mockResolvedValue([gatewayProcess]);

    const result = await findExistingMoltbotProcess(sandbox);
    expect(result).toBe(gatewayProcess);
  });

  it('matches legacy clawdbot gateway command (transition compat)', async () => {
    const gatewayProcess = createFullMockProcess({
      id: 'gateway-1',
      command: 'clawdbot gateway --port 18789',
      status: 'running',
    });
    const { sandbox, listProcessesMock } = createMockSandbox();
    listProcessesMock.mockResolvedValue([gatewayProcess]);

    const result = await findExistingMoltbotProcess(sandbox);
    expect(result).toBe(gatewayProcess);
  });

  it('matches legacy start-moltbot.sh command (transition compat)', async () => {
    const gatewayProcess = createFullMockProcess({
      id: 'gateway-1',
      command: '/usr/local/bin/start-moltbot.sh',
      status: 'running',
    });
    const { sandbox, listProcessesMock } = createMockSandbox();
    listProcessesMock.mockResolvedValue([gatewayProcess]);

    const result = await findExistingMoltbotProcess(sandbox);
    expect(result).toBe(gatewayProcess);
  });

  it('ignores completed gateway processes', async () => {
    const processes = [
      createFullMockProcess({ command: 'openclaw gateway', status: 'completed' }),
      createFullMockProcess({ command: 'start-openclaw.sh', status: 'failed' }),
    ];
    const { sandbox, listProcessesMock } = createMockSandbox();
    listProcessesMock.mockResolvedValue(processes);

    const result = await findExistingMoltbotProcess(sandbox);
    expect(result).toBeNull();
  });

  it('handles listProcesses errors gracefully', async () => {
    const sandbox = {
      listProcesses: vi.fn().mockRejectedValue(new Error('Network error')),
    } as unknown as Sandbox;

    const result = await findExistingMoltbotProcess(sandbox);
    expect(result).toBeNull();
  });

  it('returns first matching gateway process', async () => {
    const firstGateway = createFullMockProcess({
      id: 'gateway-1',
      command: 'openclaw gateway',
      status: 'running',
    });
    const secondGateway = createFullMockProcess({
      id: 'gateway-2',
      command: 'start-openclaw.sh',
      status: 'starting',
    });
    const { sandbox, listProcessesMock } = createMockSandbox();
    listProcessesMock.mockResolvedValue([firstGateway, secondGateway]);

    const result = await findExistingMoltbotProcess(sandbox);
    expect(result?.id).toBe('gateway-1');
  });

  it('does not match openclaw onboard as a gateway process', async () => {
    const processes = [
      createFullMockProcess({ command: 'openclaw onboard --non-interactive', status: 'running' }),
    ];
    const { sandbox, listProcessesMock } = createMockSandbox();
    listProcessesMock.mockResolvedValue(processes);

    const result = await findExistingMoltbotProcess(sandbox);
    expect(result).toBeNull();
  });
});

describe('ensureMoltbotGateway', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    suppressConsole();
  });

  function createRunningMockProcess(overrides: Partial<Process> = {}): Process {
    return {
      id: 'new-proc',
      command: 'start-openclaw.sh',
      status: 'running',
      startTime: new Date(),
      endTime: undefined,
      exitCode: undefined,
      waitForPort: vi.fn().mockResolvedValue(undefined),
      kill: vi.fn(),
      getLogs: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
      ...overrides,
    } as Process;
  }

  it('does not kill gateway when port is responding (even without SDK process)', async () => {
    const execMock = vi.fn()
      // 1st call: port check -> yes (port is responding)
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'yes\n', stderr: '', command: '', durationMs: 0 })
      // Any subsequent exec calls
      .mockResolvedValue({ exitCode: 0, stdout: '', stderr: '', command: '', durationMs: 0 });

    const sandbox = {
      mountBucket: vi.fn().mockResolvedValue(undefined),
      listProcesses: vi.fn().mockResolvedValue([]),
      exec: execMock,
      startProcess: vi.fn(),
    } as unknown as Sandbox;

    const env = { Sandbox: {}, ASSETS: {}, MOLTBOT_BUCKET: {} } as any;

    const result = await ensureMoltbotGateway(sandbox, env);

    // Port responding + no SDK process -> should NOT kill, NOT start any process
    const pkillCalls = execMock.mock.calls.filter(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('pkill'),
    );
    expect(pkillCalls).toHaveLength(0);

    // Should NOT have started any process
    expect(sandbox.startProcess).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it('returns existing process when port is responding and SDK process found', async () => {
    const gatewayProc = createRunningMockProcess({ id: 'gateway-1', command: 'start-openclaw.sh' });

    const execMock = vi.fn()
      // 1st call: port check -> yes (port is responding)
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'yes\n', stderr: '', command: '', durationMs: 0 })
      .mockResolvedValue({ exitCode: 0, stdout: '', stderr: '', command: '', durationMs: 0 });

    const sandbox = {
      mountBucket: vi.fn().mockResolvedValue(undefined),
      listProcesses: vi.fn().mockResolvedValue([gatewayProc]),
      exec: execMock,
      startProcess: vi.fn(),
    } as unknown as Sandbox;

    const env = { Sandbox: {}, ASSETS: {}, MOLTBOT_BUCKET: {} } as any;

    const result = await ensureMoltbotGateway(sandbox, env);

    // Should return the existing process directly
    expect(result).toBe(gatewayProc);
    // Should NOT start a new process
    expect(sandbox.startProcess).not.toHaveBeenCalled();
  });

  it('runs cleanup and starts new gateway when port is not responding', async () => {
    const mockProcess = createRunningMockProcess();

    const execMock = vi.fn()
      // 1st call: port check -> no (port not responding)
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'no\n', stderr: '', command: '', durationMs: 0 })
      // 2nd call: pkill cleanup
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '', command: '', durationMs: 0 })
      // Any subsequent exec calls
      .mockResolvedValue({ exitCode: 0, stdout: '', stderr: '', command: '', durationMs: 0 });

    const sandbox = {
      mountBucket: vi.fn().mockResolvedValue(undefined),
      listProcesses: vi.fn().mockResolvedValue([]),
      exec: execMock,
      startProcess: vi.fn().mockResolvedValue(mockProcess),
    } as unknown as Sandbox;

    const env = { Sandbox: {}, ASSETS: {}, MOLTBOT_BUCKET: {} } as any;

    await ensureMoltbotGateway(sandbox, env);

    // pkill should be called (port is free, so cleanup runs before starting new gateway)
    const pkillCalls = execMock.mock.calls.filter(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('pkill'),
    );
    expect(pkillCalls).toHaveLength(1);

    // Should have started a new gateway process
    expect(sandbox.startProcess).toHaveBeenCalledWith(
      '/usr/local/bin/start-openclaw.sh',
      expect.any(Object),
    );
  });
});
