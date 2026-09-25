import { CopilotClient, type CopilotClientOptions, type SessionEventHandler } from '@github/copilot-sdk';
import type { SdkClient } from './copilot.ts';
import { checkAbort, ServiceError } from './errors.ts';

/** SDK 1.0.13 sendAndWait keeps its idle timer alive after disconnect/forceStop. */
export async function waitForSdkResponse(session: {
  on(handler: SessionEventHandler): () => void; send(options: { prompt: string }): Promise<string>;
}, prompt: string, milliseconds: number, signal?: AbortSignal) {
  if (signal) checkAbort(signal);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe: (() => void) | undefined;
  let abort: (() => void) | undefined;
  let last: { data: { content: string } } | undefined;
  let sent = false;
  let idle = false;
  try {
    return await new Promise<typeof last>((resolve, reject) => {
      abort = () => reject(signal?.reason instanceof ServiceError ? signal.reason : new ServiceError('cancelled', true, 'read'));
      signal?.addEventListener('abort', abort, { once: true });
      unsubscribe = session.on(event => {
        if (event.type === 'assistant.message') last = event;
        else if (event.type === 'session.idle' && event.data.mode !== 'autopilot') {
          idle = true;
          if (sent) resolve(last);
        }
        else if (event.type === 'session.error') reject(new ServiceError('copilot_unavailable', true));
      });
      timer = setTimeout(() => reject(new ServiceError('deadline', true, 'read')), milliseconds);
      session.send({ prompt }).then(() => { sent = true; if (idle) resolve(last); }, reject);
    });
  } finally {
    clearTimeout(timer);
    unsubscribe?.();
    if (abort) signal?.removeEventListener('abort', abort);
  }
}

export function sdkClient(options: CopilotClientOptions): SdkClient {
  return wrapSdkClient(new CopilotClient(options));
}
export function wrapSdkClient(client: CopilotClient): SdkClient {
  return {
    start: () => client.start(),
    getAuthStatus: () => client.getAuthStatus(),
    deleteSession: id => client.deleteSession(id),
    forceStop: () => client.forceStop(),
    async createSession(config) {
      const session = await client.createSession(config);
      return {
        sessionId: session.sessionId,
        sendAndWait: ({ prompt }, milliseconds = 60_000, signal) => waitForSdkResponse(session, prompt, milliseconds, signal),
        abort: () => session.abort(),
        disconnect: () => session.disconnect(),
      };
    },
  };
}
