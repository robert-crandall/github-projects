import { expect, test } from 'bun:test';
import { codeAgents } from '../../service/src/code-agents.ts';
import { codeRunOutcomeSchema, codeRunSchema } from '../../service/src/code-runs.ts';
import { taskAgents } from '../../service/src/work-agents.ts';
import { workSettingsSchema } from '../../service/src/work-schema.ts';
import { emptyWorkspace } from '../domain/live.ts';
import { createNativePlatform, snapshotSchema, type NativeWorkspace } from '../platform/native.ts';
import { ServiceClient } from '../platform/service.ts';
import { DesktopWorkspace } from '../runtime/desktop-workspace.ts';
import { codeResult, CodeRunStoreFixture } from '../../tests/code-run-fixture.ts';
import { WorkQueue } from './controller.ts';
import { rankInput, reconcileWork } from './engine.ts';
import { codeJob, codeSource } from './code-sessions.ts';
import type { Request } from '../../service/src/schema.ts';

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}

function addCodeTask(f: Awaited<ReturnType<typeof setup>>, id: string, kind: 'pr' | 'issue' = 'issue') {
  f.controller.update(state => {
    const original = state.tasks[0]!;
    return { ...state, tasks: [...state.tasks, { ...structuredClone(original), id, title: id, work: {
      ...original.work!, url: `https://github.com/octo/project/issues/${state.tasks.length + 100}`,
      reference: { repo: 'octo/project', number: state.tasks.length + 100, kind }, evidence: [],
    } }] };
  });
  return id;
}

test('code batches freeze only explicit eligible source kinds and keep one reservation through terminal saves', async () => {
  const f = await setup('pr');
  const second = addCodeTask(f, 'second', 'pr'), issue = addCodeTask(f, 'issue');
  f.queue.capture('manual');
  const manual = f.controller.state.tasks.at(-1)!.id;
  const unknown = addCodeTask(f, 'unknown');
  f.controller.update(state => ({ ...state, tasks: state.tasks.map(task => task.id === unknown
    ? { ...task, work: { ...task.work!, reference: undefined } } : task) }));
  const held = f.holdResultSave();
  const ids = [f.id, second, issue, manual, unknown, 'missing'];
  const batch = f.queue.code.startBatch(ids, 'pr-review');
  ids.push(addCodeTask(f, 'not selected', 'pr'));
  try {
    await f.saving.promise;
    expect(f.queue.code.getSnapshot().active?.phase).toBe('saving');
    expect(f.queue.code.busy).toBe(true);
    expect(f.queue.code.getSnapshot().busy).toBe(true);
    await expect(f.queue.code.start(second)).rejects.toThrow('current Copilot');
    await expect(f.queue.code.startBatch([second], 'pr-review')).rejects.toThrow('current Copilot');
    for (const start of [() => f.queue.run(), () => f.queue.runAssessor([issue]), () => f.queue.runPrioritizer()]) {
      await expect(start()).rejects.toThrow('code job');
    }
    f.queue.saveSettings({ ...f.controller.state.work.settings, schedule: { enabled: true, everyMinutes: 5 } });
    await f.queue.tick(new Date('2030-01-01'));
    expect(f.requests.filter(request => request.op === 'work.reviewCode')).toHaveLength(1);
    f.queue.edit(f.id, 'Edited while saving', 'Notes preserved');
    f.queue.complete(f.id);
  } finally { held.resolve(); await batch; }
  expect(f.requests.map(request => request.op)).toEqual(['work.reviewCode', 'work.reviewCode']);
  expect(f.requests.map(request => request.op === 'work.reviewCode' && [request.input.taskId, request.input.job]))
    .toEqual([[f.id, 'pr-review'], [second, 'pr-review']]);
  expect(f.queue.code.getSnapshot().batch?.items.map(item => item.status)).toEqual(['completed', 'completed', 'skipped', 'skipped', 'skipped', 'skipped']);
  expect(f.queue.code.busy).toBe(false);
  expect(f.controller.state.tasks[0]).toMatchObject({ notes: 'Notes preserved', status: 'done' });
  expect(f.runs.entries).toHaveLength(2);
});

test('batch stop marks queued tasks immediately but cancel ACK retains reservation until actual target settles', async () => {
  for (const failure of [undefined, 'cancelled']) {
    const f = await setup(), held = f.hold(), second = addCodeTask(f, 'second');
    const running = f.queue.code.startBatch([f.id, second], 'implementation-assessment');
    try {
      await f.started.promise;
      await f.queue.code.stopBatch();
      expect(f.queue.code.getSnapshot().batch?.items.map(item => item.status)).toEqual(['running', 'not-started']);
      expect(f.queue.code.busy).toBe(true);
      await expect(f.queue.code.start(second)).rejects.toThrow('current Copilot');
      await expect(f.queue.run()).rejects.toThrow('code job');
      if (failure) f.fail(failure);
    } finally { held.resolve(); await running; }
    expect(f.requests.map(request => request.op)).toEqual(['work.reviewCode', 'cancel']);
    expect(f.queue.code.getSnapshot().batch?.items.map(item => item.status)).toEqual([failure ? 'cancelled' : 'completed', 'not-started']);
    expect(f.queue.code.busy).toBe(false);
    await f.queue.code.initialize();
    expect(f.requests).toHaveLength(2);
  }
});

test('batch revalidates queued tasks after Done, removal or changed source without affecting new tasks', async () => {
  const f = await setup(), held = f.hold();
  const done = addCodeTask(f, 'done'), removed = addCodeTask(f, 'removed'), changed = addCodeTask(f, 'changed'), last = addCodeTask(f, 'last');
  const running = f.queue.code.startBatch([f.id, done, removed, changed, last], 'implementation-assessment');
  await f.started.promise;
  f.queue.complete(done);
  f.controller.update(state => ({ ...state, tasks: state.tasks.filter(task => task.id !== removed).map(task => task.id === changed
    ? { ...task, work: { ...task.work!, reference: { ...task.work!.reference!, kind: 'pr' } } } : task) }));
  const added = addCodeTask(f, 'new');
  f.queue.edit(last, 'New title is fine', 'Preserved notes');
  held.resolve(); await running;
  expect(f.requests.map(request => request.op === 'work.reviewCode' && request.input.taskId)).toEqual([f.id, last]);
  expect(f.queue.code.getSnapshot().batch?.items.map(item => item.status)).toEqual(['completed', 'skipped', 'skipped', 'skipped', 'completed']);
  expect(f.controller.state.tasks.find(task => task.id === last)?.notes).toBe('Preserved notes');
  expect(f.controller.state.tasks.some(task => task.id === added)).toBe(true);
});

test('a saved task failure continues to the next independent task; interruptions stop the batch', async () => {
  for (const failure of ['source_changed', 'service-crashed', 'cancelled']) {
    const f = await setup(), second = addCodeTask(f, 'second');
    f.fail(failure);
    await f.queue.code.startBatch([f.id, second], 'implementation-assessment');
    expect(f.requests).toHaveLength(failure === 'source_changed' ? 2 : 1);
    expect(f.queue.code.getSnapshot().batch?.items.map(item => item.status)).toEqual(
      failure === 'source_changed' ? ['failed', 'failed'] : [failure === 'cancelled' ? 'cancelled' : 'failed', 'not-started']);
    expect(f.queue.code.busy).toBe(false);
  }
});

test('batch save failure stops dispatch and keeps the exact result retryable without another SDK call', async () => {
  const f = await setup(), second = addCodeTask(f, 'second');
  f.runs.failUpdate = true;
  await f.queue.code.startBatch([f.id, second], 'implementation-assessment');
  expect(f.queue.code.getSnapshot().batch?.items.map(item => item.status)).toEqual(['save-pending', 'not-started']);
  expect(f.queue.code.busy).toBe(false);
  const pending = f.controller.getSnapshot().codePending[0]!;
  expect(pending.outcome.status).toBe('partial');
  f.runs.failUpdate = false;
  await f.controller.retryCodeRun(pending.intent.runId);
  expect(f.requests.map(request => request.op)).toEqual(['work.reviewCode']);
  expect(f.runs.entries[0]!.outcome.status).toBe('partial');
  expect(f.queue.code.getSnapshot().batch?.items.map(item => item.status)).toEqual(['completed', 'not-started']);
});

test('zero-read batches preserve not-inspected outcomes distinctly, including after persistence retry', async () => {
  for (const saveFailure of [false, true]) {
    const f = await setup('pr'), second = addCodeTask(f, 'second', 'pr');
    f.notInspected(); f.runs.failUpdate = saveFailure;
    await f.queue.code.startBatch([f.id, second], 'pr-review');
    if (saveFailure) {
      expect(f.queue.code.getSnapshot().batch?.items.map(item => item.status)).toEqual(['save-pending', 'not-started']);
      const pending = f.controller.getSnapshot().codePending[0]!;
      expect(pending.outcome.status).toBe('not-inspected');
      f.runs.failUpdate = false;
      await f.controller.retryCodeRun(pending.intent.runId);
    }
    expect(f.queue.code.getSnapshot().batch?.items.map(item => item.status))
      .toEqual(['not-inspected', saveFailure ? 'not-started' : 'not-inspected']);
    expect(f.runs.entries.every(run => run.outcome.status === 'not-inspected')).toBe(true);
    expect(f.requests).toHaveLength(saveFailure ? 1 : 2);
    expect(f.queue.code.getSnapshot().batch?.items.some(item => item.status === 'completed')).toBe(false);
  }
});

test('a reentrant stop just before RPC dispatch sends no code request', async () => {
  const f = await setup(), second = addCodeTask(f, 'second');
  const unsubscribe = f.queue.code.subscribe(() => {
    if (f.queue.code.getSnapshot().active?.phase === 'inspecting') void f.queue.code.stopBatch();
  });
  try {
    await f.queue.code.startBatch([f.id, second], 'implementation-assessment');
    expect(f.requests).toHaveLength(0);
    expect(f.queue.code.getSnapshot().batch?.items.map(item => item.status)).toEqual(['cancelled', 'not-started']);
    expect(f.queue.code.busy).toBe(false);
  } finally { unsubscribe(); }
});

test('context change stops unstarted tasks without cancelling the valid current job; explicit stop still cancels it', async () => {
  const f = await setup(), held = f.hold(), second = addCodeTask(f, 'second');
  const running = f.queue.code.startBatch([f.id, second], 'implementation-assessment');
  await f.started.promise;
  f.queue.saveSourceFilter({ selectedSources: [], collapsedProviders: [] });
  expect(f.queue.code.getSnapshot().batch?.items[1]?.status).toBe('not-started');
  expect(f.requests.map(request => request.op)).toEqual(['work.reviewCode']);
  expect(f.queue.code.busy).toBe(true);
  await f.queue.code.stopBatch();
  expect(f.requests.map(request => request.op)).toEqual(['work.reviewCode', 'cancel']);
  held.resolve(); await running;
});

test('batch loses scope on profile, semantic settings and recovery but waits for the original target', async () => {
  for (const change of ['profile', 'settings', 'recovery'] as const) {
    const f = await setup(), held = f.hold(), second = addCodeTask(f, 'second');
    const running = f.queue.code.startBatch([f.id, second], 'implementation-assessment');
    try {
      await f.started.promise;
      if (change === 'profile') f.queue.createProfile('Other');
      if (change === 'settings') f.queue.saveSettings({ ...f.controller.state.work.settings,
        codeAgents: codeAgents(f.controller.state.work.settings).map(agent => ({ ...agent, instructions: 'Changed' })) });
      if (change === 'recovery') await f.controller.recoverBackup(crypto.randomUUID());
      await f.cancelAcknowledged.promise;
      expect(f.queue.code.busy).toBe(true);
      expect(f.queue.code.getSnapshot().batch?.items[1]?.status).toBe('not-started');
      await expect(f.queue.run()).rejects.toThrow('code job');
      if (change === 'recovery') expect(f.queue.code.getSnapshot().active).toBeNull();
    } finally { held.resolve(); await running; }
    expect(f.requests.map(request => request.op)).toEqual(['work.reviewCode', 'cancel']);
    expect(f.runs.entries.at(-1)?.quarantined).toBe(change === 'recovery');
    expect(f.queue.code.busy).toBe(false);
  }
});

test('batch changes during durable start do not dispatch a stale request and always release the reservation', async () => {
  for (const change of ['done', 'source', 'stop', 'start-failure'] as const) {
    const f = await setup(), held = f.holdStart(), second = addCodeTask(f, 'second');
    if (change === 'start-failure') f.runs.failStart = true;
    const running = f.queue.code.startBatch([f.id, second], 'implementation-assessment');
    if (change === 'done') f.queue.complete(f.id);
    if (change === 'source') f.controller.update(state => ({ ...state, tasks: state.tasks.map(task => task.id === f.id
      ? { ...task, work: { ...task.work!, reference: { ...task.work!.reference!, kind: 'pr' } } } : task) }));
    if (change === 'stop') await f.queue.code.stopBatch();
    held.resolve(); await running;
    expect(f.requests).toHaveLength(0);
    expect(f.queue.code.busy).toBe(false);
    expect(f.queue.code.getSnapshot().batch?.items[1]?.status).toBe('not-started');
  }
});

test('bulk code eligibility never guesses legacy kind and empty or wrong-kind actions dispatch nothing', async () => {
  const f = await setup('pr');
  expect(codeJob(f.controller.state.tasks[0]!, f.controller.state)).toBe('pr-review');
  await expect(f.queue.code.startBatch([f.id], 'implementation-assessment')).rejects.toThrow('No selected');
  await expect(f.queue.code.startBatch([], 'pr-review')).rejects.toThrow('No selected');
  expect(f.requests).toHaveLength(0);
  expect(f.queue.code.busy).toBe(false);
});
async function setup(kind: 'issue' | 'pr' = 'issue') {
  const at = new Date().toISOString(), url = `https://github.com/octo/project/${kind === 'pr' ? 'pull' : 'issues'}/47`;
  let state = reconcileWork(emptyWorkspace(at, 'UTC'), { collectedAt: at, warnings: [], observations: [
    { url, state: 'open', observedAt: at, reason: '', reference: { repo: 'octo/project', kind, number: 47 } },
  ], candidates: [{
    title: 'Inspect task', action: kind === 'pr' ? 'review' : 'implement', url,
    evidence: [{ id: 'request', source: 'github', streamId: 'github-assigned', at, url, summary: 'Inspect this source.' }],
  }] }, new Date());
  state.work.settings = workSettingsSchema.parse({ ...state.work.settings, streams: [] });
  let saved: NativeWorkspace = {
    revision: crypto.randomUUID(), savedAt: at, snapshot: snapshotSchema.parse(JSON.parse(JSON.stringify({ formatVersion: 1, reminders: [], workspace: { version: 1, state, scroll: {} } }))),
  };
  const runs = new CodeRunStoreFixture();
  const log: string[] = [], requests: Request[] = [];
  let hold: ReturnType<typeof gate> | undefined;
  let holdStart: ReturnType<typeof gate> | undefined;
  let holdResultSave: ReturnType<typeof gate> | undefined;
  let failure: string | undefined;
  let inspected = true;
  const started = gate();
  const secondStarted = gate(), cancelAcknowledged = gate(), saving = gate();
  const platform = createNativePlatform(async (command, args = {}) => {
    log.push(command);
    if (command.startsWith('code_run_')) {
      if (command === 'code_run_start' && holdStart) await holdStart.promise;
      if (command === 'code_run_update' && holdResultSave && codeRunOutcomeSchema.parse(args.outcome).status !== 'cancelling') {
        saving.resolve();
        await holdResultSave.promise;
      }
      return runs.handle(command, args);
    }
    if (command === 'workspace_read') return structuredClone(saved);
    if (command === 'clock_now') return { now: at, timeZone: 'UTC', error: null };
    if (command === 'workspace_save') {
      expect(args.expectedRevision).toBe(saved.revision);
      saved = { revision: crypto.randomUUID(), savedAt: at, snapshot: snapshotSchema.parse(args.snapshot) };
      return structuredClone(saved);
    }
    if (command === 'workspace_read_backup') return structuredClone(saved);
    if (command === 'workspace_storage_status') return { recoveryToken: crypto.randomUUID(), revision: saved.revision, error: null };
    if (command === 'workspace_recover') { runs.replace(); saved.revision = crypto.randomUUID(); return structuredClone(saved); }
    if (command === 'workspace_export_json') return JSON.stringify({ ...saved, assessments: [], codeRuns: runs.entries });
    throw new Error(`Unexpected ${command}`);
  });
  const controller = new DesktopWorkspace(platform);
  await controller.load(); await controller.flush();
  const service = new ServiceClient(async request => {
    requests.push(request); log.push(request.op);
    if (request.op === 'cancel') {
      cancelAcknowledged.resolve();
      return { v: 1, id: request.id, ok: true, result: { requestId: request.input.requestId, cancelled: true } };
    }
    expect(request.op).toBe('work.reviewCode');
    if (request.op !== 'work.reviewCode') throw new Error('Unexpected network operation');
    expect(runs.entries.some(run => run.intent.runId === request.id && run.outcome.status === 'running')).toBe(true);
    started.resolve();
    if (requests.filter(request => request.op === 'work.reviewCode').length === 2) secondStarted.resolve();
    if (hold) await hold.promise;
    if (failure?.startsWith('service-')) throw { code: failure, message: `Explicit ${failure}`, retryable: true };
    return failure ? { v: 1, id: request.id, ok: false, error: { code: failure, message: `Explicit ${failure}`, retryable: true } }
      : { v: 1, id: request.id, ok: true, result: codeResult(request.input, inspected) };
  });
  const queue = new WorkQueue(controller, service);
  return {
    controller, queue, runs, requests, log, started, secondStarted, cancelAcknowledged, saving, id: state.tasks[0]!.id,
    hold() { hold = gate(); return hold; }, holdStart() { holdStart = gate(); return holdStart; },
    holdResultSave() { holdResultSave = gate(); return holdResultSave; },
    fail(code: string) { failure = code; }, notInspected() { inspected = false; },
  };
}

test('four roles preserve old two-role customization verbatim and never enter ranking DTOs', () => {
  const legacy = { instructions: 'original', model: 'old-model', streams: [], schedule: { enabled: false, everyMinutes: 30 } };
  const agents = taskAgents(legacy).map(agent => ({ ...agent, name: `${agent.name} custom`, instructions: `private ${agent.id}`, model: `model-${agent.id}` }));
  const configured = workSettingsSchema.parse({ ...legacy, agents });
  expect(configured.agents).toEqual(agents);
  expect(configured.instructions).toBe(legacy.instructions);
  expect(configured.model).toBe(legacy.model);
  expect(codeAgents(configured).map(agent => agent.jobType)).toEqual(['implementation-assessment', 'pr-review']);
  expect(workSettingsSchema.parse(configured)).toEqual(configured);
  const state = emptyWorkspace(new Date().toISOString(), 'UTC');
  state.work.settings = configured;
  expect(rankInput(state).agents).toEqual(agents);
  expect('codeAgents' in rankInput(state)).toBe(false);
  expect(workSettingsSchema.safeParse({ ...configured, codeAgents: [codeAgents(configured)[0], codeAgents(configured)[0]] }).success).toBe(false);
});

test('canonical issue-form legacy links stay unknown; only matching pull evidence or observed identity resolves kind', async () => {
  const f = await setup('pr');
  const state = structuredClone(f.controller.state), task = state.tasks[0]!;
  expect(task.work!.url).toContain('/issues/');
  task.work!.reference = undefined;
  task.work!.evidence = [];
  task.work!.action = 'review';
  expect(codeSource(task, state)).toBeNull();
  task.work!.evidence = [
    { id: 'other', source: 'github', streamId: 's', at: new Date().toISOString(), url: 'https://github.com/other/project/pull/47', summary: 'unrelated' },
    { id: 'other-number', source: 'github', streamId: 's', at: new Date().toISOString(), url: 'https://github.com/octo/project/pull/48', summary: 'unrelated' },
  ];
  expect(codeSource(task, state)).toBeNull();
  task.work!.evidence.push({ ...task.work!.evidence[0]!, id: 'match', url: 'https://github.com/octo/project/pull/47/files' });
  expect(codeSource(task, state)?.kind).toBe('pr');
  task.work!.reference = { repo: 'octo/project', kind: 'issue', number: 47 };
  expect(codeSource(task, state)?.kind).toBe('issue');
  task.work!.reference = { repo: 'other/repo', kind: 'pr', number: 47 };
  expect(codeSource(task, state)).toBeNull();
});

test('start is durable before network; no selection/initialize replay; notes and Done survive', async () => {
  const f = await setup();
  await f.queue.code.initialize();
  await f.queue.code.history('default', f.id);
  expect(f.requests).toHaveLength(0);
  const held = f.hold();
  const running = f.queue.code.start(f.id);
  await f.started.promise;
  expect(f.log.indexOf('code_run_start')).toBeLessThan(f.log.indexOf('work.reviewCode'));
  await expect(f.queue.code.start(f.id)).rejects.toThrow('current Copilot');
  await expect(f.queue.runAssessor()).rejects.toThrow('code job');
  f.queue.edit(f.id, 'edited', 'private notes');
  f.queue.complete(f.id);
  await f.controller.flush();
  expect(JSON.stringify(f.requests)).not.toContain('private notes');
  held.resolve();
  const result = await running;
  expect(result.outcome.status).toBe('partial');
  expect(f.controller.state.tasks[0]!.notes).toBe('private notes');
  expect(f.controller.state.tasks[0]!.status).toBe('done');
  expect(f.requests.map(r => r.op)).toEqual(['work.reviewCode']);
});

test('start write failure dispatches nothing and leaves ordinary edits usable', async () => {
  const f = await setup();
  f.runs.failStart = true;
  await expect(f.queue.code.start(f.id)).rejects.toThrow('Start not saved');
  expect(f.requests).toHaveLength(0);
  f.queue.capture('offline'); await f.controller.flush();
  expect(f.controller.state.tasks).toHaveLength(2);
});

test('cancel ACK never implies cancelled: target success is saved; actual cancelled error is saved separately', async () => {
  for (const cancelled of [false, true]) {
    const f = await setup('pr'), held = f.hold();
    const running = f.queue.code.start(f.id);
    await f.started.promise;
    await f.queue.code.cancel();
    expect(f.queue.code.getSnapshot().active?.phase).toBe('cancelling');
    expect(f.runs.entries[0]!.outcome.status).toBe('cancelling');
    if (cancelled) f.fail('cancelled');
    held.resolve();
    expect((await running).outcome.status).toBe(cancelled ? 'cancelled' : 'partial');
  }
});

test('cancel during durable start never sends model; relaunch interrupts without replay', async () => {
  const f = await setup(), held = f.holdStart();
  const running = f.queue.code.start(f.id);
  await f.queue.code.cancel();
  held.resolve();
  expect((await running).outcome.status).toBe('cancelled');
  expect(f.requests).toHaveLength(0);
  const saved = f.runs.entries[0]!;
  f.runs.entries.push({ ...saved, intent: { ...saved.intent, runId: crypto.randomUUID() }, sequence: 2, outcome: { status: 'running' } });
  f.runs.replace(f.runs.entries);
  await f.queue.code.initialize();
  expect(f.runs.entries[1]!.outcome.status).toBe('interrupted');
  expect(f.requests).toHaveLength(0);
});

test('failed terminal write keeps result for paid-call-free retry and allows notes, Done and fresh runs', async () => {
  const f = await setup();
  f.runs.failUpdate = true;
  await expect(f.queue.code.start(f.id)).rejects.toThrow('disk');
  const pending = f.controller.getSnapshot().codePending[0]!;
  expect(pending.outcome.status).toBe('partial');
  f.queue.edit(f.id, 'edited', 'retained'); f.queue.complete(f.id); await f.controller.flush();
  f.runs.failUpdate = false;
  await f.queue.code.start(f.id);
  const calls = f.requests.length;
  await f.controller.retryCodeRun(pending.intent.runId);
  expect(f.requests).toHaveLength(calls);
  expect(f.controller.getSnapshot().codePending).toHaveLength(0);
  expect(f.runs.entries).toHaveLength(2);
  const exportValue = JSON.parse(await f.controller.fullPendingJson());
  expect(exportValue.codeRuns).toHaveLength(2);
  expect(f.controller.state.tasks[0]!.status).toBe('done');
});

test('restore hides the old run but blocks every Copilot start until its target settles after cancel ACK', async () => {
  const f = await setup(), held = f.hold();
  const old = f.queue.code.start(f.id);
  await f.started.promise;
  const generation = f.runs.generation;
  try {
    await f.controller.recoverBackup(crypto.randomUUID());
    await f.cancelAcknowledged.promise;
    expect(f.queue.code.getSnapshot().active).toBeNull();
    expect(f.queue.code.busy).toBe(true);
    expect(f.queue.code.getSnapshot().busy).toBe(true);
    const starts = f.log.filter(command => command === 'code_run_start').length;
    const requests = f.requests.length;
    await expect(f.queue.code.start(f.id)).rejects.toThrow('current Copilot');
    for (const start of [() => f.queue.run(), () => f.queue.runAssessor(), () => f.queue.runPrioritizer()]) {
      await expect(start()).rejects.toThrow('code job');
    }
    expect(f.log.filter(command => command === 'code_run_start')).toHaveLength(starts);
    expect(f.requests).toHaveLength(requests);
  } finally {
    held.resolve();
    await old;
  }
  const result = await old;
  expect(result.generation).toBe(generation);
  expect(result.quarantined).toBe(true);
  expect(f.queue.code.busy).toBe(false);
  expect((await f.queue.code.history('default', f.id)).runs).toHaveLength(0);
  expect((await f.queue.code.start(f.id)).quarantined).toBe(false);
  expect((await f.queue.code.history('default', f.id)).runs).toHaveLength(1);
});

test('settled target releases the SDK guard while terminal persistence is pending', async () => {
  const f = await setup(), held = f.holdResultSave();
  const first = f.queue.code.start(f.id);
  let second: ReturnType<typeof f.queue.code.start> | undefined;
  try {
    await f.saving.promise;
    expect(f.queue.code.getSnapshot().active?.phase).toBe('saving');
    expect(f.queue.code.busy).toBe(false);
    expect(f.queue.code.getSnapshot().busy).toBe(false);
    f.queue.edit(f.id, 'Edited while saving', 'Private notes');
    f.queue.complete(f.id);
    await f.controller.flush();
    second = f.queue.code.start(f.id);
    await f.secondStarted.promise;
    expect(f.requests.filter(request => request.op === 'work.reviewCode')).toHaveLength(2);
  } finally {
    held.resolve();
    await Promise.all([first, second]);
  }
  expect(f.runs.entries).toHaveLength(2);
  expect(f.controller.state.tasks[0]!.status).toBe('done');
  expect(f.controller.state.tasks[0]!.notes).toBe('Private notes');
});

test('profile switching preserves origin and settings while result is in flight', async () => {
  const f = await setup(), held = f.hold();
  const running = f.queue.code.start(f.id);
  await f.started.promise;
  f.queue.createProfile('Other');
  held.resolve();
  const result = await running;
  expect(result.intent.profileId).toBe('default');
  expect(f.controller.state.activeWorkProfile.id).not.toBe('default');
  expect(f.controller.state.tasks).toHaveLength(0);
});

test('reruns create immutable versions and page in sequence order, not timestamps', async () => {
  const f = await setup();
  const ids = new Set<string>();
  for (let n = 0; n < 13; n++) ids.add((await f.queue.code.start(f.id)).intent.runId);
  expect(ids.size).toBe(13);
  const first = await f.queue.code.history('default', f.id);
  expect(first.runs.map(r => r.sequence)).toEqual([13,12,11,10,9,8,7,6,5,4]);
  const second = await f.queue.code.history('default', f.id, first.before);
  expect(second.runs.map(r => r.sequence)).toEqual([3,2,1]);
  const run = first.runs[0]!;
  await expect(f.controller.platform.codeRunUpdate(run.generation, run.intent,
    { status: 'failed', finishedAt: new Date().toISOString(), error: { code: 'changed', message: 'overwrite' } })).rejects.toThrow();
});

test('not-inspected stays distinct and source/auth/busy/deadline errors never imply Done or GitHub writes', async () => {
  const f = await setup('pr'); f.notInspected();
  const noCode = await f.queue.code.start(f.id);
  expect(noCode.outcome.status).toBe('not-inspected');
  for (const error of ['source_changed', 'authentication', 'busy', 'deadline']) {
    f.fail(error);
    const run = await f.queue.code.start(f.id);
    expect(run.outcome.status).toBe('failed');
    expect('error' in run.outcome && run.outcome.error.code).toBe(error);
  }
  expect(f.controller.state.tasks[0]!.status).toBe('open');
  expect(f.requests.every(r => r.op === 'work.reviewCode')).toBe(true);
  if (!('result' in noCode.outcome)) throw new Error('Expected result');
  expect(codeRunSchema.safeParse({ ...noCode, outcome: { ...noCode.outcome, result: {
    ...noCode.outcome.result, answer: { job: 'pr-review', findings: [], conclusion: { status: 'not-inspected', summary: 'Safe to merge' } },
  } } }).success).toBe(false);
});
