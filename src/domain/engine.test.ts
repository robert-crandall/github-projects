import { expect, test } from 'bun:test';
import { earlierThreads, getRow, getRows, initialState, transition } from './engine.ts';

test('Inbox contains one row per thread and selection never creates or selects a task', () => {
  let state = initialState();
  const tasks = structuredClone(state.tasks);
  expect(getRows(state).every(row => row.thread && !row.task)).toBe(true);
  for (const row of getRows(state)) {
    state = transition(state, { type: 'select', key: row.key });
    expect(state.selectedKey).toBe(row.key);
    expect(state.tasks).toEqual(tasks);
    expect(getRow(state, row.key)?.task).toBeUndefined();
  }
  expect(() => transition(state, { type: 'done', key: state.selectedKey! })).toThrow('Select a task');
  expect(() => transition(state, { type: 'edit', key: state.selectedKey!, notes: 'not a task' })).toThrow('Select a task');
});

test('notes belong to threads, remain separate and cannot be edited through another thread', () => {
  let state = initialState();
  const thread = state.threads[0]!;
  const taskCount = state.tasks.length;
  for (const text of ['First note', 'Second note']) state = transition(state, { type: 'note', threadId: thread.id, text });
  const entries = state.notes.filter(note => note.threadId === thread.id);
  state = transition(state, { type: 'note', threadId: thread.id, noteId: entries[0]!.id, text: 'Edited first' });
  expect(state.notes.filter(note => note.threadId === thread.id).map(note => note.text)).toEqual(['Edited first', 'Second note']);
  expect(state.tasks).toHaveLength(taskCount);
  expect(() => transition(state, { type: 'note', threadId: state.threads[1]!.id, noteId: entries[0]!.id, text: 'Wrong thread' })).toThrow('no longer exists on this thread');
});

test('capture from every main view saves exact text into Tasks without interpretation or linking', () => {
  for (const view of ['inbox', 'tasks'] as const) {
    let state = transition(initialState(), { type: 'view', view });
    const text = '  Review https://github.com/octo/project/pull/1\nEvery day at 10am, announce, then increase  ';
    const threads = structuredClone(state.threads);
    state = transition(state, { type: 'draft', text });
    state = transition(state, { type: 'capture' });
    expect(state.view).toBe('tasks');
    expect(state.draft).toBe('');
    expect(getRow(state, state.selectedKey!)?.task).toEqual({
      id: state.tasks.at(-1)!.id, title: text, notes: '', status: 'open', createdAt: state.clock,
    });
    expect(state.threads).toEqual(threads);
    expect(getRows(state, 'inbox').every(row => !row.task)).toBe(true);
  }
});

test('completed tasks stay done across comments, queue, new requests, refresh and clock', () => {
  let state = initialState();
  const key = `a:${state.tasks[0]!.id}`;
  state = transition(state, { type: 'done', key });
  const done = structuredClone(state.tasks);
  for (const scenario of ['comment', 'merge-queue', 're-request', 'closed'] as const) {
    state = transition(state, { type: 'stage', scenario });
    state = transition(state, { type: 'refresh' });
    state = transition(state, { type: 'advance', minutes: 1440 });
    expect(state.tasks).toEqual(done);
  }
  expect(getRows(state, 'tasks').find(row => row.key === key)?.task?.status).toBe('done');
});

test('refresh only applies staged activity explicitly and preserves edits, focus selection and row order', () => {
  let state = initialState();
  const keys = getRows(state).map(row => row.key);
  state = transition(state, { type: 'stage', scenario: 'new-review' });
  expect(getRows(state).map(row => row.key)).toEqual(keys);
  state = transition(state, { type: 'note', threadId: state.threads[0]!.id, text: 'Current edit' });
  const before = structuredClone(state);
  state = transition(state, { type: 'refresh' });
  expect(state.notes).toEqual(before.notes);
  expect(state.selectedKey).toBe(before.selectedKey);
  expect(getRows(state).map(row => row.key).slice(0, keys.length)).toEqual(keys);
  expect(state.staged).toEqual([]);
});

test('acknowledgement and unsubscribe preserve thread notes and all Tasks in Earlier threads', () => {
  for (const action of ['done', 'unsubscribe'] as const) {
    let state = initialState();
    const threadId = state.threads[0]!.id;
    state = transition(state, { type: 'note', threadId, text: 'Keep this thread context' });
    const before = structuredClone(state);
    state = transition(state, { type: 'notification', threadId, action });
    expect(state.notes).toEqual(before.notes);
    expect(state.tasks).toEqual(before.tasks);
    expect(getRows(state).some(row => row.thread?.id === threadId)).toBe(false);
    expect(earlierThreads(state).some(row => row.thread?.id === threadId)).toBe(true);
    state = transition(state, { type: 'select', key: `t:${threadId}` });
    expect(state.tasks).toEqual(before.tasks);
    expect(state.notes).toEqual(before.notes);
  }
});

test('task undo changes completion only, preserving edits and GitHub acknowledgements', () => {
  let state = initialState();
  const key = `a:${state.tasks[0]!.id}`;
  state = transition(state, { type: 'done', key });
  state = transition(state, { type: 'edit', key, notes: 'Written after Done' });
  state = transition(state, { type: 'notification', threadId: state.threads[0]!.id, action: 'done' });
  const handled = state.handled;
  state = transition(state, { type: 'undo' });
  expect(state.tasks[0]!.status).toBe('open');
  expect(state.tasks[0]!.notes).toBe('Written after Done');
  expect(state.handled).toEqual(handled);
});

test('sample reset retains all notes and tasks, including Done and original capture text', () => {
  let state = transition(initialState(), { type: 'draft', text: 'An original capture' });
  state = transition(state, { type: 'capture' });
  state = transition(state, { type: 'done', key: state.selectedKey! });
  state = transition(state, { type: 'note', threadId: state.threads[0]!.id, text: 'User notes' });
  const next = transition(state, { type: 'reset' });
  expect(next.tasks).toEqual(state.tasks);
  expect(next.notes).toEqual(state.notes);
});
