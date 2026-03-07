// API client for admin endpoints
// Authentication is handled by Cloudflare Access (JWT in cookies)

const API_BASE = '/api/admin';

export interface PendingDevice {
  requestId: string;
  deviceId: string;
  displayName?: string;
  platform?: string;
  clientId?: string;
  clientMode?: string;
  role?: string;
  roles?: string[];
  scopes?: string[];
  remoteIp?: string;
  ts: number;
}

export interface PairedDevice {
  deviceId: string;
  displayName?: string;
  platform?: string;
  clientId?: string;
  clientMode?: string;
  role?: string;
  roles?: string[];
  scopes?: string[];
  createdAtMs: number;
  approvedAtMs: number;
}

export interface DeviceListResponse {
  pending: PendingDevice[];
  paired: PairedDevice[];
  raw?: string;
  stderr?: string;
  parseError?: string;
  error?: string;
}

export interface ApproveResponse {
  success: boolean;
  requestId: string;
  message?: string;
  stdout?: string;
  stderr?: string;
  error?: string;
}

export interface ApproveAllResponse {
  approved: string[];
  failed: Array<{ requestId: string; success: boolean; error?: string }>;
  message?: string;
  error?: string;
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

async function apiRequest<T>(path: string, options: globalThis.RequestInit = {}, timeoutMs = 30000): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${API_BASE}${path}`, {
      ...options,
      signal: controller.signal,
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
    } as globalThis.RequestInit);

    clearTimeout(timeoutId);

    if (response.status === 401) {
      throw new AuthError('Unauthorized - please log in via Cloudflare Access');
    }

    const data = (await response.json()) as T & { error?: string };

    if (!response.ok) {
      throw new Error(data.error || `API error: ${response.status}`);
    }

    return data;
  } catch (err) {
    clearTimeout(timeoutId);
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error('リクエストがタイムアウトしました（30秒）。サーバーに問題がある可能性があります。');
    }
    throw err;
  }
}

export async function listDevices(): Promise<DeviceListResponse> {
  return apiRequest<DeviceListResponse>('/devices');
}

export async function approveDevice(requestId: string): Promise<ApproveResponse> {
  return apiRequest<ApproveResponse>(`/devices/${requestId}/approve`, {
    method: 'POST',
  });
}

export async function approveAllDevices(): Promise<ApproveAllResponse> {
  return apiRequest<ApproveAllResponse>('/devices/approve-all', {
    method: 'POST',
  });
}

export interface RestartGatewayResponse {
  success: boolean;
  message?: string;
  error?: string;
}

export async function restartGateway(): Promise<RestartGatewayResponse> {
  return apiRequest<RestartGatewayResponse>('/gateway/restart', {
    method: 'POST',
  });
}

export interface StorageStatusResponse {
  configured: boolean;
  missing?: string[];
  lastSync: string | null;
  message: string;
}

export async function getStorageStatus(): Promise<StorageStatusResponse> {
  return apiRequest<StorageStatusResponse>('/storage');
}

export interface SyncResponse {
  success: boolean;
  message?: string;
  lastSync?: string;
  error?: string;
  details?: string;
}

export async function triggerSync(): Promise<SyncResponse> {
  return apiRequest<SyncResponse>('/storage/sync', {
    method: 'POST',
  });
}

export interface ProcessInfo {
  id: string;
  command: string;
  status: string;
  exitCode?: number;
}

export interface ListProcessesResponse {
  total: number;
  processes: ProcessInfo[];
  error?: string;
}

export async function listProcessesInfo(): Promise<ListProcessesResponse> {
  return apiRequest<ListProcessesResponse>('/processes');
}

export interface RemoveDeviceResponse {
  success: boolean;
  deviceId: string;
  message?: string;
  error?: string;
}

export async function removeDevice(deviceId: string): Promise<RemoveDeviceResponse> {
  return apiRequest<RemoveDeviceResponse>(`/devices/${deviceId}`, {
    method: 'DELETE',
  });
}

export interface DestroyContainerResponse {
  success: boolean;
  message?: string;
  error?: string;
  hint?: string;
  retryUrl?: string;
  syncError?: string;
  skipSync?: boolean;
}

export async function destroyContainer(skipSync = false): Promise<DestroyContainerResponse> {
  const query = skipSync ? '?skipSync=true' : '';
  const response = await fetch(`${API_BASE}/gateway/destroy${query}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
  });
  if (response.status === 401) {
    throw new AuthError('Unauthorized');
  }
  return response.json() as Promise<DestroyContainerResponse>;
}

export interface TokenRefreshResponse {
  success: boolean;
  message?: string;
  gatewayRestarted?: boolean;
  error?: string;
}

export async function refreshToken(): Promise<TokenRefreshResponse> {
  return apiRequest<TokenRefreshResponse>('/token-refresh', {
    method: 'POST',
  }, 60000);
}
