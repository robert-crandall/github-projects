import type { Readable } from 'node:stream';
import { z } from 'zod';
import { sanitized, ServiceError } from './errors.ts';
import { addTaskSchema, WorkIntake } from './work-intake.ts';

const versions = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;
const requestSchema = z.object({
  jsonrpc: z.literal('2.0'), id: z.union([z.string().max(200), z.number().int().safe()]).optional(),
  method: z.string().max(200), params: z.record(z.string(), z.unknown()).optional(),
});
const initializeSchema = z.object({
  protocolVersion: z.string().max(100),
  capabilities: z.record(z.string(), z.unknown()),
  clientInfo: z.object({ name: z.string().max(200), version: z.string().max(100) }),
});
const callSchema = z.object({ name: z.string(), arguments: z.unknown().optional() });
const jsonError = (id: string | number | null, code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });

export class IntakeMcpProtocol {
  private initialized = false;
  private ready = false;
  constructor(private readonly intake: WorkIntake) {}
  handle(raw: unknown): object | undefined {
    const request = requestSchema.safeParse(raw);
    if (!request.success) return jsonError(null, -32600, 'Invalid Request');
    const { id, method, params } = request.data;
    if (id === undefined) {
      if (method === 'notifications/initialized' && this.initialized) this.ready = true;
      return undefined;
    }
    const response = (result: unknown) => ({ jsonrpc: '2.0', id, result });
    if (method === 'initialize') {
      const input = initializeSchema.safeParse(params);
      if (!input.success) return jsonError(id, -32602, 'Invalid initialize parameters');
      if (this.initialized) return jsonError(id, -32600, 'Already initialized');
      this.initialized = true;
      return response({
        protocolVersion: versions.find(version => version === input.data.protocolVersion) ?? versions[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'github-projects-work-intake', version: '1.0.0' },
        instructions: 'add_task durably queues an external event. It never marks a user task done. AI review completion uses action review-result.',
      });
    }
    if (method === 'ping') return response({});
    if (!this.ready) return jsonError(id, -32002, 'Initialize and send notifications/initialized first');
    if (method === 'tools/list') return response({ tools: [{
      name: 'add_task',
      description: 'Durably queue an actual external request with immutable producer/event identity and occurrence time. Use review-result for completed AI review; user Done remains separate.',
      inputSchema: z.toJSONSchema(addTaskSchema),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }] });
    if (method === 'tools/call') {
      const input = callSchema.safeParse(params);
      if (!input.success) return jsonError(id, -32602, 'Invalid tool call parameters');
      if (input.data.name !== 'add_task') return jsonError(id, -32602, 'Unknown tool');
      try {
        const result = this.intake.add(input.data.arguments);
        return response({ content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: false });
      } catch (error) {
        const failure = sanitized(error);
        return response({ content: [{ type: 'text', text: failure.message }], isError: true });
      }
    }
    return jsonError(id, -32601, 'Method not found');
  }
}

export async function serveIntakeMcp(
  input: Readable,
  write: (frame: string) => Promise<void>,
  intake = new WorkIntake(),
): Promise<void> {
  const protocol = new IntakeMcpProtocol(intake);
  let buffered = Buffer.alloc(0);
  const send = async (value: object) => {
    const frame = `${JSON.stringify(value)}\n`;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([write(frame), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ServiceError('deadline')), 2000);
      })]);
    } finally { clearTimeout(timer); }
  };
  try {
    for await (const raw of input) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      let start = 0;
      for (let i = 0; i < chunk.length; i++) {
        if (chunk[i] !== 10) continue;
        const line = Buffer.concat([buffered, chunk.subarray(start, i)]);
        if (line.length > 32_768) throw new ServiceError('limit');
        buffered = Buffer.alloc(0);
        start = i + 1;
        let value: unknown;
        try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line)); }
        catch { await send(jsonError(null, -32700, 'Parse error')); continue; }
        const response = protocol.handle(value);
        if (response) await send(response);
      }
      buffered = Buffer.concat([buffered, chunk.subarray(start)]);
      if (buffered.length > 32_768) throw new ServiceError('limit');
    }
    if (buffered.length) await send(jsonError(null, -32700, 'Expected newline-delimited JSON'));
  } finally { intake.close(); }
}
