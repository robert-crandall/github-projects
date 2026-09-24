import { describe, expect, test } from 'bun:test';
import { defaultWorkState, type WorkEvidence } from '../../service/src/work-schema.ts';
import { emptyWorkspace } from '../domain/live.ts';
import { stateSchema, type Task } from '../types.ts';
import { rankInput, rankedTasks } from './engine.ts';
import { matchesSources, sourceCounts, taskSourceIds, taskSources } from './filters.ts';
import { createWorkProfile, switchWorkProfile } from './profiles.ts';

const at = '2026-09-15T10:00:00.000Z';
function task(id: string, evidence?: [WorkEvidence['source'], string][]): Task {
  return {
    id, title: id, notes: '', status: 'open', createdAt: at,
    ...(evidence ? { work: {
      identity: `https://github.com/test/repo/issues/${id}`, url: `https://github.com/test/repo/issues/${id}`,
      action: 'review' as const, availability: 'actionable' as const, availabilityReason: '', handledEvidenceIds: [],
      evidence: evidence.map(([source, streamId]) => ({ id: 'event', source, streamId, at,
        url: 'https://github.com/test/repo/issues/1', summary: 'Request' })),
    } } : {}),
  };
}

describe('task source filters', () => {
  test('matches any evidence source once, without using the destination URL or action', () => {
    const merged = task('1', [['github', 'github-reviews'], ['slack', 'team'], ['slack', 'team']]);
    const ids = taskSourceIds(merged);
    expect(ids).toHaveLength(2);
    for (const id of ids) expect(matchesSources(merged, [id])).toBe(true);
    expect([merged].filter(item => matchesSources(item, ids))).toEqual([merged]);
    expect(sourceCounts([merged]).get(ids[1]!)).toBe(1);
    expect(matchesSources(merged, [])).toBe(false);
    expect(matchesSources(merged, null)).toBe(true);
    expect(matchesSources(merged, ['manual'])).toBe(false);
  });

  test('configured, disabled, removed, intake and unattributed sources remain reachable', () => {
    const settings = defaultWorkState().settings;
    settings.streams[0]!.enabled = false;
    const tasks = [task('1', [['github', 'github-reviews']]), task('2', [['slack', 'removed']]),
      task('3', [['mcp', 'push:mcp']]), task('4', [['copilot', 'push:copilot']]), task('5'), task('6', [])];
    const sources = taskSources(settings, tasks);
    expect(sources.find(item => item.name === 'PRs awaiting my review')?.detail).toBe('Collection disabled');
    expect(sources.find(item => item.name === 'removed')).toMatchObject({ provider: 'slack', detail: 'Source no longer configured' });
    expect(taskSourceIds(tasks[2]!)).toEqual(['intake']);
    expect(taskSourceIds(tasks[3]!)).toEqual(['intake']);
    expect(taskSourceIds(tasks[4]!)).toEqual(['manual']);
    expect(taskSourceIds(tasks[5]!)).toEqual(['unattributed']);
    const ids = sources.map(item => item.id);
    expect(tasks.every(item => matchesSources(item, ids))).toBe(true);
    expect(sourceCounts(tasks).get('intake')).toBe(2);
  });

  test('stable source identities survive renames and distinguish providers and built-ins', () => {
    const settings = defaultWorkState().settings;
    const before = taskSources(settings, []);
    settings.streams[0]!.name = 'Renamed reviews';
    expect(taskSources(settings, [])[0]!.id).toBe(before[0]!.id);
    expect(taskSourceIds(task('1', [['mcp', 'manual']]))).not.toEqual(['manual']);
    expect(taskSourceIds(task('1', [['github', 'same']]))).not.toEqual(taskSourceIds(task('2', [['slack', 'same']])));
    settings.streams[0]!.kind = 'github-notifications';
    expect(taskSources(settings, [])[0]!.provider).toBe('github');
    expect(taskSources(settings, [])[0]!.id).toBe(before[0]!.id);
  });

  test('filtering preserves rank, ranking input, tasks and settings', () => {
    const state = emptyWorkspace(at, 'UTC');
    state.tasks = [task('1'), task('2', [['github', 'github-reviews']]), task('3')];
    state.work.ranking = { orderedIds: ['3', '2', '1'], reasons: [], rankedAt: at };
    const before = structuredClone(state);
    const input = rankInput(state);
    state.work.sourceFilter = { selectedSources: ['manual'], collapsedProviders: ['github'] };
    expect(rankedTasks(state).filter(item => matchesSources(item, ['manual'])).map(item => item.id)).toEqual(['3', '1']);
    expect(rankInput(state)).toEqual(input);
    expect(state.tasks).toEqual(before.tasks);
    expect(state.work.settings).toEqual(before.work.settings);
  });

  test('all and empty selections round-trip per profile; new profiles start unfiltered', () => {
    let state = emptyWorkspace(at, 'UTC');
    expect(stateSchema.parse(state).work.sourceFilter).toBeUndefined();
    state.work.sourceFilter = { selectedSources: [], collapsedProviders: ['github'] };
    state = createWorkProfile(state, 'On call', true);
    expect(state.work.sourceFilter).toBeUndefined();
    state.work.sourceFilter = { selectedSources: null, collapsedProviders: ['mcp'] };
    const secondId = state.activeWorkProfile.id;
    state = switchWorkProfile(stateSchema.parse(JSON.parse(JSON.stringify(state))), 'default');
    expect(state.work.sourceFilter).toEqual({ selectedSources: [], collapsedProviders: ['github'] });
    state = switchWorkProfile(state, secondId);
    expect(state.work.sourceFilter).toEqual({ selectedSources: null, collapsedProviders: ['mcp'] });
  });
});
