import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAppState } from './storage.ts';
import type { AppState } from './domain/types.ts';
import { createDesktopState } from './domain/live.ts';
import { applyCommand } from './domain/engine.ts';
import { createInitialState } from './domain/fixtures.ts';

const base: AppState = {
  version: 1, clock: '2026-09-08T09:40:00.000Z', items: [], captures: [], projects: [],
  draft: '', undo: [], sync: { status: 'ok', lastSuccessAt: '2026-09-08T09:40:00.000Z' },
  interpretationError: false,
};

test('storage accepts the complete local envelope, not just a matching version', () => {
  assert.equal(isAppState(base), true);
  assert.equal(isAppState({ version: 1 }), false);
  assert.equal(isAppState({ ...base, version: 2 }), false);
  assert.equal(isAppState({ ...base, clock: 'broken' }), false);
  assert.equal(isAppState({ ...base, sync: { status: 'error' } }), false);
  assert.equal(isAppState({ ...base, items: [null] }), false);
  assert.equal(isAppState({ ...base, undo: [{ label: 'Complete' }] }), false);
});

test('storage rejects dangling captured originals and missing active work', () => {
  assert.equal(isAppState({ ...base, activeId: 'missing' }), false);
  assert.equal(isAppState({
    ...base,
    captures: [{ id: 'raw', original: 'Keep this', itemId: 'missing', createdAt: base.clock, interpretation: 'unsupported' }],
  }), false);
});

test('storage retains the browser format and accepts a complete desktop workspace', () => {
  assert.equal(isAppState(createInitialState()), true);
  let state = applyCommand(createDesktopState(base.clock), { type: 'capture', id: 'raw', text: 'Daily at 10am, read notes' });
  state = applyCommand(state, { type: 'ai-interpret', captureId: 'raw', proposal: {
    kind: 'routine', title: 'Read notes', nextStep: 'Open notes', explanation: 'Daily time is explicit.',
    dailyTime: '10:00', steps: ['Open notes', 'Read notes'],
  } });
  assert.equal(isAppState(JSON.parse(JSON.stringify(state))), true);
  assert.equal(state.items[0].routine!.timeZone, state.captures[0].timeZone);
  state.items[0].signalCurrent = false;
  state.sync = { status: 'error', lastSuccessAt: state.clock, login: 'octo', error: 'Offline', warnings: ['Partial result'] };
  assert.equal(isAppState(state), true);
});

test('storage rejects corrupt live fields, timezone definitions, and source freshness', () => {
  const state = createDesktopState(base.clock);
  for (const change of [
    { runtime: 'browser' }, { runtime: true },
    { sync: { ...state.sync, status: 'connected' } },
    { sync: { ...state.sync, warnings: 'Warning' } },
    { sync: { ...state.sync, warnings: [null] } },
    { sync: { ...state.sync, warnings: ['x'.repeat(2001)] } },
    { sync: { ...state.sync, login: '' } }, { sync: { ...state.sync, error: {} } },
  ]) assert.equal(isAppState({ ...state, ...change }), false, JSON.stringify(change));
  const captured = applyCommand(state, { type: 'capture', id: 'one', text: 'Keep this' });
  assert.equal(isAppState({ ...captured, items: [{ ...captured.items[0], signalCurrent: 'false' }] }), false);
  assert.equal(isAppState({ ...captured, captures: [{ ...captured.captures[0], timeZone: 'Mars/Olympus' }] }), false);
  assert.equal(isAppState({ ...captured, captures: [{ ...captured.captures[0], actionEdited: 'true' }] }), false);
  for (const zone of ['Mars/Olympus', '+05:00', '', false]) {
    assert.equal(isAppState({ ...captured, items: [{
      ...captured.items[0], kind: 'routine',
      routine: { time: '10:00', timeZone: zone, nextDueAt: base.clock, occurrences: [] },
    }] }), false);
  }
  assert.equal(isAppState({ ...captured, captures: [{ ...captured.captures[0], interpretation: 'task' }] }), true);
  assert.equal(isAppState({ ...captured, captures: [captured.captures[0], captured.captures[0]] }), false);
});

test('persisted AI rankings require bounded, unique known IDs and matching reasons', () => {
  const state = applyCommand(createDesktopState(base.clock), { type: 'capture', id: 'one', text: 'Keep this' });
  const ranking = {
    orderedIds: ['capture-one'], reasons: [{ id: 'capture-one', reason: 'A useful next step.' }],
    summary: 'One action.', generatedAt: base.clock,
  };
  assert.equal(isAppState({ ...state, aiRanking: ranking }), true);
  for (const change of [
    { orderedIds: ['missing'], reasons: [{ id: 'missing', reason: 'Reason' }] },
    { orderedIds: ['capture-one', 'capture-one'] }, { reasons: [] },
    { reasons: [{ id: 'capture-one', reason: 'x'.repeat(501) }] },
    { reasons: [{ id: 'other', reason: 'Reason' }] },
    { summary: '' }, { generatedAt: '2026-02-30T10:00:00Z' },
    { orderedIds: Array(41).fill('capture-one') },
  ]) assert.equal(isAppState({ ...state, aiRanking: { ...ranking, ...change } }), false);
});
