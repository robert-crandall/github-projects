import assert from 'node:assert/strict';
import test from 'node:test';
import { createDesktopState } from './domain/live.ts';
import { applyCommand } from './domain/engine.ts';
import { timestamp } from './domain/clock.ts';
import { isAppState } from './storage.ts';
import { rankedItems, recommendationReason } from './domain/ranking.ts';
import type { GitHubSnapshot } from './desktop-contract.ts';

test('native RFC3339 timestamps with nanoseconds cross the Rust/renderer boundary', () => {
  const now = '2026-09-08T19:13:21.081123456+00:00';
  assert.equal(timestamp(now), Date.parse('2026-09-08T19:13:21.081Z'));
  const url = 'https://github.com/example/work/pull/42';
  const snapshot: GitHubSnapshot = {
    fetchedAt: now, login: 'example-user', warnings: [],
    items: [{
      id: `github:${url}:review`, title: 'Review a small fix', kind: 'review', status: 'available',
      createdAt: now, updatedAt: now, sources: [{ id: 'request', kind: 'github', label: 'Direct review request', reference: url }],
      notes: '', steps: [], nextStep: 'Review the requested pull request.',
      review: { identity: url, request: 'direct', lines: 15, files: 2 },
    }],
  };
  const state = applyCommand(createDesktopState(), { type: 'github-sync', snapshot });
  assert.equal(state.sync.status, 'ok');
  assert.equal(state.items.length, 1);
  assert.ok(isAppState(state));
  const partial = applyCommand(state, { type: 'github-sync', snapshot: { ...snapshot, items: [], warnings: ['Search reached its result limit.'] } });
  assert.equal(partial.items[0].signalCurrent, true);
  assert.equal(rankedItems(partial).length, 1);
  const complete = applyCommand(state, { type: 'github-sync', snapshot: { ...snapshot, items: [] } });
  assert.equal(complete.items[0].signalCurrent, false);
});

test('possible re-reviews remain weak signals even when their diff is small', () => {
  const state = createDesktopState();
  const clock = state.clock;
  const source = { id: 'github:https://github.com/example/work/pull/42:Reviewed', kind: 'github' as const, label: 'Reviewed PR - may need re-review', reference: 'https://github.com/example/work/pull/42' };
  state.items.push({
    id: 'possible', title: 'Recent PR activity', kind: 'review', status: 'available', createdAt: clock, updatedAt: clock,
    sources: [source], notes: '', steps: [], nextStep: 'Check whether another review is needed.',
    review: { identity: source.reference, request: 'manual', lines: 1, files: 1 },
  }, {
    id: 'actual', title: 'An actual commitment', kind: 'task', status: 'available', createdAt: clock, updatedAt: clock,
    sources: [{ id: 'capture', kind: 'capture', label: 'Your capture' }], notes: '', steps: [], nextStep: 'Write the plan.',
  });
  assert.equal(rankedItems(state)[0].id, 'actual');
  assert.match(recommendationReason(state.items[0], state), /not a review request/);
});
