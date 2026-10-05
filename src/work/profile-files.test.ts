import { expect, test } from 'bun:test';
import { emptyWorkspace } from '../domain/live.ts';
import { workSettingsSchema } from '../../service/src/work-schema.ts';
import { createWorkProfile, switchWorkProfile } from './profiles.ts';
import { decodeProfileFile, encodeProfileFile, importWorkProfile, MAX_PROFILE_FILE_BYTES, profileFilename } from './profile-files.ts';

const at = '2026-10-05T15:00:00.000Z';

function configured() {
  const state = emptyWorkspace(at, 'UTC');
  state.activeWorkProfile.name = 'On call';
  state.work.settings.instructions = 'Incidents first';
  state.work.settings.model = 'collection-model';
  state.work.settings.agents = state.work.settings.agents!.map(agent => ({
    ...agent, instructions: `${agent.jobType} priorities`, model: 'task-model',
  }));
  state.work.settings.codeAgents = state.work.settings.codeAgents!.map(agent => ({
    ...agent, instructions: `${agent.jobType} guidance`, model: 'code-model',
  }));
  state.work.settings.workStyles = [{ id: 'quick', name: 'Quick wins', description: 'Small clear work' }];
  state.work.settings.schedule = { enabled: true, everyMinutes: 45 };
  state.tasks = [{ id: 'private-task', title: 'Private task', notes: 'Private notes', status: 'done', createdAt: at, completedAt: at }];
  state.work.ranking = { orderedIds: ['private-task'], reasons: [{ id: 'private-task', reason: 'Private ranking' }], rankedAt: at };
  state.work.collectionCursor = at;
  state.work.lastCompletedAt = at;
  state.work.lastStartedAt = at;
  state.work.lastError = 'Private run error';
  state.work.sourceFilter = { selectedSources: [], collapsedProviders: ['github'] };
  state.work.styleFilter = ['quick'];
  return state;
}

test('profile export contains only the active name and complete settings, not workspace state', () => {
  const source = configured();
  const state = switchWorkProfile(createWorkProfile(source, 'Other'), source.activeWorkProfile.id);
  const encoded = encodeProfileFile(state);
  expect(JSON.parse(encoded)).toEqual({
    format: 'github-projects-work-profile', version: 1, name: 'On call',
    settings: workSettingsSchema.parse(source.work.settings),
  });
  expect(encoded).not.toContain('Private');
  expect(encoded).not.toContain('Other');
  expect(decodeProfileFile(encoded).settings).toEqual(workSettingsSchema.parse(source.work.settings));
});

test('import creates a fresh selected profile without tasks, runtime state or filters and disables schedules', () => {
  const state = configured();
  const previous = structuredClone(state);
  const file = decodeProfileFile(encodeProfileFile(state));
  const imported = importWorkProfile(state, file, ' Shared on call ');
  expect(imported.activeWorkProfile).toEqual({ id: expect.any(String), name: 'Shared on call' });
  expect(imported.activeWorkProfile.id).not.toBe(state.activeWorkProfile.id);
  expect(imported.tasks).toEqual([]);
  expect(imported.undo).toEqual([]);
  expect(imported.work).toEqual({
    ...emptyWorkspace(at, 'UTC').work,
    settings: { ...file.settings, schedule: { enabled: false, everyMinutes: 45 } },
  });
  expect(imported.inactiveWorkProfiles).toEqual([{
    ...state.activeWorkProfile, tasks: state.tasks, work: state.work, undo: state.undo,
  }]);
  imported.work.settings.streams[0]!.query = 'Changed query';
  imported.work.settings.agents![0]!.instructions = 'Changed instructions';
  expect(file.settings).toEqual(workSettingsSchema.parse(previous.work.settings));
  expect(state).toEqual(previous);
  const repeated = importWorkProfile(imported, file, 'Another copy');
  expect(repeated.activeWorkProfile.id).not.toBe(imported.activeWorkProfile.id);
  expect(repeated.inactiveWorkProfiles).toHaveLength(2);
});

test('import validates names against both active and inactive profiles without replacing work', () => {
  const state = createWorkProfile(configured(), 'Current');
  const previous = structuredClone(state);
  const file = decodeProfileFile(encodeProfileFile(state));
  for (const name of ['', ' ', 'CURRENT', ' on CALL ', 'x'.repeat(81)]) {
    expect(() => importWorkProfile(state, file, name)).toThrow();
    expect(state).toEqual(previous);
  }
});

test('profile decoder rejects malformed, unsupported and invalid files instead of accepting backups or extra data', () => {
  const baseline = JSON.parse(encodeProfileFile(configured()));
  expect(() => decodeProfileFile('{')).toThrow('not valid JSON');
  for (const value of [null, [], {}, { workspace: configured() }, { ...baseline, version: 2 },
    { ...baseline, format: 'other-app' }, { ...baseline, tasks: [] }, { ...baseline, name: '' },
    { ...baseline, settings: { ...baseline.settings, schedule: { enabled: true, everyMinutes: 1 } } },
    { ...baseline, settings: { ...baseline.settings, workStyles: [{ id: 'style', name: '', description: '' }] } },
    { ...baseline, settings: { ...baseline.settings, streams: [{ ...baseline.settings.streams[0], kind: 'unsupported' }] } },
    { ...baseline, settings: { ...baseline.settings, agents: [] } },
    { ...baseline, settings: { ...baseline.settings, codeAgents: [] } },
    { ...baseline, settings: { ...baseline.settings, credentials: 'not allowed' } },
  ]) {
    expect(() => decodeProfileFile(JSON.stringify(value))).toThrow('not a supported work profile');
  }
});

test('profile decoder uses the UTF-8 byte limit and accepts the exact boundary', () => {
  const text = encodeProfileFile(configured());
  const padding = MAX_PROFILE_FILE_BYTES - new TextEncoder().encode(text).byteLength;
  expect(decodeProfileFile(text + ' '.repeat(padding)).name).toBe('On call');
  expect(() => decodeProfileFile(text + ' '.repeat(padding + 1))).toThrow('2 MiB');
  expect(() => decodeProfileFile('界'.repeat(Math.ceil(MAX_PROFILE_FILE_BYTES / 3)))).toThrow('2 MiB');
});

test('older supported settings initialize agents and filenames cannot contain path components', () => {
  const file = JSON.parse(encodeProfileFile(configured()));
  delete file.settings.agents;
  delete file.settings.codeAgents;
  expect(decodeProfileFile(JSON.stringify(file)).settings).toEqual(workSettingsSchema.parse(file.settings));
  expect(profileFilename('On call')).toBe('github-projects-profile-on-call.json');
  expect(profileFilename('../../ Review / work')).toBe('github-projects-profile-review-work.json');
  expect(profileFilename('工作')).toBe('github-projects-profile.json');
});
