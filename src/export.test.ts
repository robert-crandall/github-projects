import assert from 'node:assert/strict';
import test from 'node:test';
import { applyCommand } from './domain/engine.ts';
import { createInitialState } from './domain/fixtures.ts';
import { capturesBackup, prepareWorkspaceImport } from './export.ts';
import { createDesktopState } from './domain/live.ts';
import { isAppState } from './storage.ts';

test('desktop migration keeps captured originals and notes without simulated obligations', () => {
  let state = createInitialState();
  state = applyCommand(state, { type: 'capture', id: 'migration', text: 'Review demo://github/harbor/pull/42' });
  state = applyCommand(state, { type: 'interpret', captureId: 'migration' });
  state = applyCommand(state, { type: 'notes', id: state.captures[0].itemId, text: 'Keep my context.' });
  const exported = capturesBackup(state);
  assert.ok(isAppState(exported));
  assert.equal(exported.runtime, 'desktop');
  assert.equal(exported.items.length, 1);
  assert.equal(exported.items[0].notes, 'Keep my context.');
  assert.equal(exported.items[0].sources[0].reference, undefined);
  assert.equal(exported.captures[0].original, 'Review demo://github/harbor/pull/42');
  assert.equal(exported.captures[0].interpretation, 'pending');
  assert.equal(exported.undo.length, 0);
});

test('multiple captures of the same demo review remain attached to one imported task', () => {
  let state = createInitialState();
  for (const id of ['one', 'two']) {
    state = applyCommand(state, { type: 'capture', id, text: 'Review demo://github/harbor/pull/42' });
    state = applyCommand(state, { type: 'interpret', captureId: id });
  }
  const exported = capturesBackup(state);
  assert.equal(exported.items.length, 1);
  assert.equal(exported.captures.length, 2);
  assert.equal(exported.items[0].sources.length, 2);
  assert.ok(exported.captures.every(capture => capture.itemId === exported.items[0].id));
});

test('startup GitHub discovery does not block importing captures or discard discovered work', () => {
  const current = createDesktopState();
  const reference = 'https://github.com/example/work/issues/42';
  current.items.push({
    id: `github:${reference}:task`, title: 'Assigned issue', kind: 'task', status: 'available',
    createdAt: current.clock, updatedAt: current.clock, notes: '', steps: [], nextStep: 'Read the issue.',
    sources: [{ id: 'assigned', kind: 'github', label: 'Assigned issue', reference }],
  });
  current.sync = { status: 'ok', lastSuccessAt: current.clock, login: 'example-user' };
  const backup = capturesBackup(applyCommand(createInitialState(), { type: 'capture', id: 'imported', text: 'Write the release plan' }));
  const before = JSON.stringify(current);
  const imported = prepareWorkspaceImport(current, backup);
  assert.ok(isAppState(imported));
  assert.equal(imported.items.length, 2);
  assert.equal(imported.captures[0].original, 'Write the release plan');
  assert.ok(imported.items.some(item => item.id === current.items[0].id));
  assert.equal(JSON.stringify(current), before);
  assert.equal(backup.items.length, 1);
  for (const changed of [
    { ...current, draft: 'Unfinished capture' },
    { ...current, items: [{ ...current.items[0], notes: 'My context' }] },
    { ...current, items: [{ ...current.items[0], status: 'completed' as const }] },
  ]) assert.throws(() => prepareWorkspaceImport(changed, backup), /Existing work was not changed/);
});
