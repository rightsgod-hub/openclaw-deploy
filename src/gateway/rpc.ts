import type { Sandbox } from '@cloudflare/sandbox';
import { MOLTBOT_PORT } from '../config';

/**
 * Call a Gateway WebSocket RPC method.
 *
 * Opens a WebSocket to the gateway running inside the sandbox,
 * performs the connect handshake, sends the RPC request, waits for
 * the response, then closes the connection.
 */
export async function callRpc(
  sandbox: Sandbox,
  token: string,
  method: string,
  params?: Record<string, unknown>,
  options?: { timeout?: number },
): Promise<unknown> {
  const timeout = options?.timeout ?? 15000;

  const request = new Request('http://localhost:18789/', {
    headers: { Upgrade: 'websocket' },
  });

  const response = await sandbox.wsConnect(request, MOLTBOT_PORT);
  const ws = response.webSocket;
  if (!ws) {
    throw new Error('callRpc: no WebSocket in sandbox response');
  }
  ws.accept();

  return new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`callRpc: timed out after ${timeout}ms calling ${method}`));
    }, timeout);

    type WsFrame = {
      type: string;
      id?: string;
      event?: string;
      ok?: boolean;
      payload?: unknown;
      error?: unknown;
      method?: string;
      params?: unknown;
    };

    let phase: 'wait-challenge' | 'wait-hello' | 'wait-response' = 'wait-challenge';
    let rpcId: string | undefined;

    ws.addEventListener('message', (event: MessageEvent) => {
      let frame: WsFrame;
      try {
        frame = JSON.parse(typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data as ArrayBuffer));
      } catch {
        // Ignore non-JSON frames
        return;
      }

      if (phase === 'wait-challenge') {
        // Expect: { type: "event", event: "connect.challenge", payload: { nonce: "..." } }
        if (frame.type === 'event' && frame.event === 'connect.challenge') {
          // Send connect request
          const connectFrame = {
            type: 'req',
            id: crypto.randomUUID(),
            method: 'connect',
            params: {
              minProtocol: 3,
              maxProtocol: 3,
              client: {
                id: 'worker-admin',
                version: '1.0.0',
                platform: 'cloudflare',
                mode: 'backend',
              },
              caps: [],
              auth: { token },
              role: 'operator',
              scopes: [
                'operator.admin',
                'operator.read',
                'operator.write',
                'operator.approvals',
                'operator.pairing',
              ],
            },
          };
          ws.send(JSON.stringify(connectFrame));
          phase = 'wait-hello';
        }
        return;
      }

      if (phase === 'wait-hello') {
        // Server responds to connect with: { type: "res", ok: true, payload: { type: "hello-ok", ... } }
        if (frame.type === 'res') {
          if (!frame.ok) {
            clearTimeout(timer);
            ws.close();
            reject(new Error(`callRpc: connect rejected: ${JSON.stringify(frame.error)}`));
            return;
          }
          // Connect succeeded — send the actual RPC request
          rpcId = crypto.randomUUID();
          const rpcFrame: Record<string, unknown> = {
            type: 'req',
            id: rpcId,
            method,
          };
          if (params !== undefined) {
            rpcFrame.params = params;
          }
          ws.send(JSON.stringify(rpcFrame));
          phase = 'wait-response';
          return;
        }
        // Ignore other events during handshake
        return;
      }

      if (phase === 'wait-response') {
        if (frame.type === 'res' && frame.id === rpcId) {
          clearTimeout(timer);
          ws.close();
          if (frame.ok) {
            resolve(frame.payload);
          } else {
            reject(new Error(`callRpc: ${method} failed: ${JSON.stringify(frame.error)}`));
          }
        }
        // Ignore other frames while waiting
      }
    });

    ws.addEventListener('close', () => {
      clearTimeout(timer);
      if (phase !== 'wait-response' || rpcId === undefined) {
        reject(new Error('callRpc: WebSocket closed before RPC completed'));
      }
    });

    ws.addEventListener('error', (event: Event) => {
      clearTimeout(timer);
      ws.close();
      reject(new Error(`callRpc: WebSocket error: ${String(event)}`));
    });
  });
}
