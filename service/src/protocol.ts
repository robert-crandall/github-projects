import { ServiceError, sanitized, checkAbort } from './errors.ts';
import { LIMITS, requestSchema, resultSchemas, type Request } from './schema.ts';

export type Handler = (request: Exclude<Request, { op: 'cancel' }>, signal: AbortSignal) => Promise<unknown>;
type Writer = (line: string) => Promise<void>;
export async function serve(
  input: AsyncIterable<Uint8Array>, output: Writer, handler: Handler,
  options: { deadlineMs?: number; onDiagnostic?: (code: string) => void } = {},
): Promise<void> {
  const active = new Map<string, { controller: AbortController; finished: Promise<void> }>();
  const seen = new Set<string>();
  let outputTail = Promise.resolve();
  const emit = (value: unknown) => {
    const line = `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(line) > LIMITS.responseBytes) throw new ServiceError('limit');
    const written = outputTail.then(() => output(line));
    outputTail = written;
    return written;
  };
  const fail = (id: string | null, error: unknown) =>
    emit({ v: 1, id, ok: false, error: sanitized(error) });
  const accept = async (line: Buffer) => {
    let raw: unknown;
    try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line)); }
    catch { await fail(null, new ServiceError('protocol')); return; }
    const parsed = requestSchema.safeParse(raw);
    if (!parsed.success) {
      await fail(null, new ServiceError('invalid_input'));
      return;
    }
    const request = parsed.data;
    if (seen.has(request.id)) { await fail(request.id, new ServiceError('protocol')); return; }
    if (seen.size >= 4096) { await fail(request.id, new ServiceError('limit')); return; }
    seen.add(request.id);
    if (request.op === 'cancel') {
      const target = active.get(request.input.requestId);
      target?.controller.abort(new ServiceError('cancelled'));
      await emit({ v: 1, id: request.id, ok: true, result: { requestId: request.input.requestId, cancelled: !!target } });
      return;
    }
    if (active.size >= LIMITS.concurrent) { await fail(request.id, new ServiceError('busy', true)); return; }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new ServiceError('deadline', true)), options.deadlineMs ?? LIMITS.deadlineMs);
    const finished = (async () => {
      try {
        // Handlers must honor abort and finish resource cleanup before releasing their slot.
        const value = await handler(request, controller.signal);
        checkAbort(controller.signal);
        const result = resultSchemas[request.op].safeParse(value);
        if (!result.success) throw new ServiceError('invalid_output');
        await emit({ v: 1, id: request.id, ok: true, result: result.data });
      } catch (error) {
        options.onDiagnostic?.(sanitized(error).code);
        await fail(request.id, error);
      } finally {
        clearTimeout(timer);
        active.delete(request.id);
      }
    })();
    active.set(request.id, { controller, finished });
  };
  let parts: Buffer[] = [];
  let length = 0;
  let discarding = false;
  try {
    for await (const chunk of input) {
      const data = Buffer.from(chunk);
      let start = 0;
      while (start < data.length) {
        const newline = data.indexOf(10, start);
        const end = newline === -1 ? data.length : newline;
        const piece = data.subarray(start, end);
        if (!discarding) {
          length += piece.length;
          if (length > LIMITS.frameBytes) {
            parts = [];
            length = 0;
            discarding = true;
            await fail(null, new ServiceError('limit'));
          } else if (piece.length) parts.push(piece);
        }
        if (newline !== -1) {
          if (!discarding) await accept(Buffer.concat(parts, length));
          parts = [];
          length = 0;
          discarding = false;
        }
        start = newline === -1 ? data.length : newline + 1;
      }
    }
    if (length) await fail(null, new ServiceError('protocol'));
  } finally {
    // Native closes stdin on shutdown; never leave GitHub/SDK work running after the host disappears.
    for (const entry of active.values()) entry.controller.abort(new ServiceError('cancelled'));
    await Promise.all([...active.values()].map(entry => entry.finished));
    await outputTail;
  }
}
