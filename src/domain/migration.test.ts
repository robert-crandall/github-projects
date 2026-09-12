import { expect, test } from 'bun:test';
import { getRow, transition } from './engine.ts';
import { migrateWorkspace } from './migration.ts';
import { legacyFixture } from './test-fixtures.ts';

test('migration moves every linked annotation to its thread without overwriting distinct notes or creating generated Tasks', () => {
  const legacy = legacyFixture();
  const untouched = structuredClone(legacy);
  const state = migrateWorkspace(legacy);
  expect(legacy).toEqual(untouched);
  expect(state.version).toBe(3);
  expect(state.notes.map(note => note.text)).toEqual(legacy.actions.filter(action => action.threadId).map(action => action.notes));
  expect(state.notes.map(note => note.id)).toEqual(['generated-1', 'generated-2', 'captured']);
  expect(state.notes[0]!.sourceTitle).toBe('My earlier title');
  expect(state.tasks.map(task => task.id)).toEqual(['captured', 'routine']);
  expect(state).not.toHaveProperty('activeId');
  expect(state).not.toHaveProperty('actions');
  expect(state.view).toBe('inbox');
  expect(migrateWorkspace(state)).toEqual(state);
});

test('captured tasks retain authored title, exact capture, completion, progress and history even when linked', () => {
  const legacy = legacyFixture();
  const old = legacy.actions.find(action => action.id === 'captured')!;
  legacy.selectedKey = 'a:captured';
  const state = migrateWorkspace(legacy);
  const task = state.tasks.find(task => task.id === 'captured')!;
  expect(task.title).toBe(old.title);
  expect(task.history?.captures).toEqual(old.captures);
  expect(task.history?.steps).toEqual(old.steps);
  expect(task.status).toBe('done');
  expect(task.completedAt).toBe(old.completedAt);
  expect(task.notes).toBe('');
  expect(task.threadId).toBe(old.threadId);
  expect(state.notes.find(note => note.id === 'captured')?.text).toBe(old.notes);
  expect(state.selectedKey).toBe('a:captured');
  expect(state.view).toBe('tasks');
});

test('generated history keeps all authored fields and no old routine can advance after conversion', () => {
  const legacy = legacyFixture();
  const state = migrateWorkspace(legacy);
  const old = legacy.actions[0]!;
  const { title: _title, notes: _notes, ...history } = old;
  expect(state.notes[0]!.history).toEqual(history);
  const routine = state.tasks.find(task => task.id === 'routine')!;
  expect(routine.notes).toBe('Routine notes');
  expect(routine.history?.routine).toEqual(legacy.actions[3]!.routine);
  expect(transition(state, { type: 'advance', minutes: 10 * 1440 }).tasks).toEqual(state.tasks);
  expect(getRow(state, 't:demo-relay-101')?.title).toBe(state.threads[0]!.title);
});

test('legacy generated action selection opens its thread, not a task', () => {
  const legacy = legacyFixture();
  legacy.selectedKey = 'a:generated-2';
  const state = migrateWorkspace(legacy);
  expect(state.selectedKey).toBe(`t:${legacy.actions[1]!.threadId}`);
  expect(state.view).toBe('inbox');
  expect(getRow(state, state.selectedKey!)?.task).toBeUndefined();
});

test('invalid references or versions block migration instead of losing records', () => {
  for (const damage of [
    (legacy: ReturnType<typeof legacyFixture>) => { legacy.actions[0]!.threadId = 'missing'; },
    (legacy: ReturnType<typeof legacyFixture>) => { legacy.actions[1]!.id = legacy.actions[0]!.id; },
  ]) {
    const legacy = legacyFixture();
    damage(legacy);
    expect(() => migrateWorkspace(legacy)).toThrow('inconsistent');
  }
  expect(() => migrateWorkspace({ version: 99 })).toThrow();
});

test('desktop migration rejects evidence assigned to a different thread without weakening restore validation', () => {
  const legacy = legacyFixture(true);
  legacy.actions[0]!.eventIds = [legacy.threads[1]!.events[0]!.id];
  expect(() => migrateWorkspace(legacy)).toThrow('inconsistent references');
});
