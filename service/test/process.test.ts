import { expect, test } from 'bun:test';
import { run } from '../src/process.ts';
import { ServiceError } from '../src/errors.ts';

test('process runner bounds output and never returns stderr content', async () => {
  const result = await run(process.execPath, ['-e', 'process.stderr.write("synthetic-secret"); process.stdout.write("ok")'], new AbortController().signal);
  expect(result).toEqual({ code: 0, stdout: 'ok' });
  await expect(run(process.execPath, ['-e', 'process.stdout.write("x".repeat(5_000_000))'], new AbortController().signal))
    .rejects.toMatchObject({ dto: { code: 'limit' } });
});
test('process runner kills its specific child on cancellation', async () => {
  const controller = new AbortController();
  const pending = run(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], controller.signal);
  setTimeout(() => controller.abort(new ServiceError('cancelled')), 30);
  await expect(pending).rejects.toMatchObject({ dto: { code: 'cancelled' } });
});
