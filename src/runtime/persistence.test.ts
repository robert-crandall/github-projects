import { expect, test } from 'bun:test';
import { PersistenceQueue, type PersistenceStatus } from './persistence.ts';

test('CAS saves serialize latest edits and do not report Saved while a newer write is pending', async () => {
  const calls: { revision: string; value: string; resolve: (result: { revision: string }) => void }[] = [];
  const statuses: PersistenceStatus[] = [];
  const queue = new PersistenceQueue<string>('initial', (revision, value) =>
    new Promise(resolve => calls.push({ revision, value, resolve })), status => statuses.push(status));
  queue.enqueue('note 1');
  queue.enqueue('note 2');
  queue.enqueue('Done + latest note');
  let finished = false;
  const flush = queue.flush().then(() => { finished = true; });
  expect(calls).toHaveLength(1);
  calls[0]!.resolve({ revision: 'second' });
  await Promise.resolve();
  expect(calls).toHaveLength(2);
  expect(calls[1]!.revision).toBe('second');
  expect(calls[1]!.value).toBe('Done + latest note');
  expect(statuses.every(status => status.pending)).toBe(true);
  expect(finished).toBe(false);
  calls[1]!.resolve({ revision: 'third' });
  await flush;
  expect(queue.status).toEqual({ pending: false, saving: false, error: '' });
});

test('conflicts retain pending edits and never overwrite or retry until explicitly requested', async () => {
  let calls = 0;
  let seen = '';
  const queue = new PersistenceQueue<string>('old', async (revision, value) => {
    calls += 1;
    if (revision !== 'recovered') throw new Error('Conflict: saved work changed.');
    seen = value;
    return { revision: 'saved' };
  }, () => {});
  queue.enqueue('initial edit');
  await expect(queue.flush()).rejects.toThrow('Conflict');
  queue.enqueue('latest retained pending edit');
  await Promise.resolve();
  expect(calls).toBe(1);
  expect(queue.status.pending).toBe(true);
  await queue.recover('recovered');
  expect(seen).toBe('latest retained pending edit');
  expect(calls).toBe(2);
});
