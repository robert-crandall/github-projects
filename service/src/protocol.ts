import { ServiceError, sanitized, checkAbort } from './errors.ts';
import { LIMITS, requestSchema, resultSchemas, type Request } from './schema.ts';

export type Handler = (request: Exclude<Request, { op: 'cancel' }>, signal: AbortSignal) => Promise<unknown>;
type Writer = (line: string) => Promise<void>;
export async function serve(
  input: AsyncIterable<Uint8Array>, output: Writer, handler: Handler,
  options: {
    deadlineMs?: number; outputTimeoutMs?: number;
    onDiagnostic?: (code: string) => void; closeInput?: () => void;
  } = {},
): Promise<void> {
  const active = new Map<string, { controller: AbortController; finished: Promise<void> }>();
  const seen = new Set<string>();
  const queue: string[] = [];
  let queuedBytes = 0;
  let draining = false;
  let outputTask = Promise.resolve();
  let terminalError: ServiceError | undefined;
  let stopped!: () => void;
  const terminal = new Promise<null>(resolve => { stopped = () => resolve(null); });
  const abortActive = () => {
    for (const entry of active.values()) entry.controller.abort(new ServiceError('cancelled'));
  };
  const terminate = (error: ServiceError) => {
    if (terminalError) return;
    terminalError = error;
    abortActive();
    stopped();
    options.closeInput?.();
  };
  const drain = async () => {
    draining = true;
    try {
      while (queue.length && !terminalError) {
        const line = queue[0]!;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([output(line), new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new ServiceError('deadline')), options.outputTimeoutMs ?? 2_000);
          })]);
        } finally { clearTimeout(timer); }
        queue.shift();
        queuedBytes -= Buffer.byteLength(line);
      }
    } catch {
      // A dead output pipe is terminal. Never send another error through it.
      terminate(new ServiceError('protocol'));
    } finally { draining = false; }
  };
  const emit = (value: unknown) => {
    if (terminalError) return;
    const line = `${JSON.stringify(value)}\n`;
    const bytes = Buffer.byteLength(line);
    if (bytes > LIMITS.responseBytes) throw new ServiceError('limit');
    if (queue.length >= 64 || queuedBytes + bytes > LIMITS.responseBytes * LIMITS.concurrent) {
      terminate(new ServiceError('limit'));
      return;
    }
    queue.push(line);
    queuedBytes += bytes;
    if (!draining) outputTask = drain();
  };
  const fail = (id: string | null, error: unknown) => {
    emit({ v: 1, id, ok: false, error: sanitized(error) });
  };
  const accept = (line: Buffer) => {
    let raw: unknown;
    try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line)); }
    catch { fail(null, new ServiceError('protocol')); return; }
    const parsed = requestSchema.safeParse(raw);
    if (!parsed.success) { fail(null, new ServiceError('invalid_input')); return; }
    const request = parsed.data;
    if (seen.has(request.id)) { fail(request.id, new ServiceError('protocol')); return; }
    if (seen.size >= 4096) { fail(request.id, new ServiceError('limit')); return; }
    seen.add(request.id);
    if (request.op === 'cancel') {
      const target = active.get(request.input.requestId);
      target?.controller.abort(new ServiceError('cancelled'));
      emit({ v: 1, id: request.id, ok: true, result: { requestId: request.input.requestId, cancelled: !!target } });
      return;
    }
    if (active.size >= LIMITS.concurrent) { fail(request.id, new ServiceError('busy', true)); return; }
    const controller = new AbortController();
    const workRead = request.op === 'work.collect' || request.op === 'work.rank';
    const timer = setTimeout(() => controller.abort(new ServiceError('deadline', true, workRead ? 'read' : 'general')),
      options.deadlineMs ?? (workRead ? LIMITS.workDeadlineMs : LIMITS.deadlineMs));
    const finished = (async () => {
      try {
        const value = await handler(request, controller.signal);
        checkAbort(controller.signal);
        const result = resultSchemas[request.op].safeParse(value);
        if (!result.success) throw new ServiceError('invalid_output');
        emit({ v: 1, id: request.id, ok: true, result: result.data });
      } catch (error) {
        if (workRead && error instanceof ServiceError && ['deadline', 'cancelled'].includes(error.dto.code)) {
          error = new ServiceError(error.dto.code, error.dto.retryable, 'read');
        }
        options.onDiagnostic?.(sanitized(error).code);
        fail(request.id, error);
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
  const iterator = input[Symbol.asyncIterator]();
  try {
    while (!terminalError) {
      const next = await Promise.race([iterator.next(), terminal]);
      if (!next || next.done) break;
      const data = Buffer.from(next.value);
      let start = 0;
      while (start < data.length && !terminalError) {
        const newline = data.indexOf(10, start);
        const end = newline === -1 ? data.length : newline;
        const piece = data.subarray(start, end);
        if (!discarding) {
          length += piece.length;
          if (length > LIMITS.frameBytes) {
            parts = [];
            length = 0;
            discarding = true;
            fail(null, new ServiceError('limit'));
          } else if (piece.length) parts.push(piece);
        }
        if (newline !== -1) {
          if (!discarding) accept(Buffer.concat(parts, length));
          parts = [];
          length = 0;
          discarding = false;
        }
        start = newline === -1 ? data.length : newline + 1;
      }
    }
    if (length && !terminalError) fail(null, new ServiceError('protocol'));
  } finally {
    abortActive();
    await Promise.all([...active.values()].map(entry => entry.finished));
    await outputTask;
  }
  if (terminalError) throw terminalError;
}
