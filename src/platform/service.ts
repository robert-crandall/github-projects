import { invoke } from '@tauri-apps/api/core';
import type { z } from 'zod';
import { errorSchema, requestSchema, resultSchemas, type Request } from '../../service/src/schema.ts';
import { isDesktop, nativeErrorSchema } from './native.ts';

export type ServiceOperation = Request['op'];
export type ServiceInput<O extends ServiceOperation> = Extract<Request, { op: O }>['input'];
export type ServiceOutput<O extends ServiceOperation> = z.infer<(typeof resultSchemas)[O]>;
export type ServiceTransport = (request: Request) => Promise<unknown>;

export class ServiceCallError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'ServiceCallError'; }
}

export class ServiceClient {
  constructor(private readonly transport: ServiceTransport = async request => {
    if (!isDesktop()) throw new Error('Live GitHub and Copilot operations require the desktop app.');
    return invoke('service_request', { request });
  }) {}

  async call<O extends ServiceOperation>(op: O, input: ServiceInput<O>, id: string = crypto.randomUUID()): Promise<ServiceOutput<O>> {
    const request = requestSchema.safeParse({ v: 1, id, op, input });
    if (!request.success) throw new Error('The selected input exceeds the supported service format or limits. No request was sent.');
    let reply: unknown;
    try { reply = await this.transport(request.data); }
    catch (error) {
      if (error instanceof Error) throw error;
      const native = nativeErrorSchema.safeParse(error);
      throw new ServiceCallError(native.success ? native.data.code : 'native-unavailable',
        native.success ? native.data.message : 'The native service failed without confirming an outcome.');
    }
    if (typeof reply !== 'object' || reply === null || Array.isArray(reply)) throw new Error('The service returned an invalid response.');
    const envelope = reply as Record<string, unknown>;
    if (Object.keys(envelope).length !== 4 || envelope.v !== 1 || envelope.id !== id || typeof envelope.ok !== 'boolean') {
      throw new Error('The service returned a mismatched response. No operation was confirmed.');
    }
    if (!envelope.ok) {
      const error = errorSchema.safeParse(envelope.error);
      if (!error.success || 'result' in envelope) throw new Error('The service returned an unsupported error response.');
      throw new ServiceCallError(error.data.code, error.data.message);
    }
    if ('error' in envelope) throw new Error('The service returned an unsupported result.');
    const result = resultSchemas[op].safeParse(envelope.result);
    if (!result.success) throw new Error('The service returned an invalid result. Nothing was applied.');
    return result.data as ServiceOutput<O>;
  }
}
