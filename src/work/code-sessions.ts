import { codeAgents, type CodeAgentJob } from '../../service/src/code-agents.ts';
import { codeReviewInputSchema } from '../../service/src/code-review-schema.ts';
import { codeRunIntentSchema, codeRunSchema, type CodeRun, type CodeRunOutcome } from '../../service/src/code-runs.ts';
import { referenceSchema, type Reference } from '../../service/src/schema.ts';
import { githubReference } from '../../service/src/references.ts';
import { ServiceCallError, ServiceClient } from '../platform/service.ts';
import type { DesktopWorkspace } from '../runtime/desktop-workspace.ts';
import type { AppState, Task } from '../types.ts';
import { rankedTasks } from './engine.ts';

export function codeSource(task: Task, state: AppState): Reference | null {
  const thread = state.threads.find(thread => thread.id === task.threadId);
  const canonical = task.work ? githubReference(task.work.url) : null;
  const fallback = task.work ? [task.work.url, ...task.work.evidence.map(item => item.url)].map(githubReference)
    .find(ref => ref?.kind === 'pr' && ref.repo === canonical?.repo && ref.number === canonical?.number) : null;
  const parsed = referenceSchema.safeParse(task.work?.reference ?? task.work?.notification?.reference ?? (thread && {
    repo: thread.repo, kind: thread.kind, number: thread.number,
  }) ?? fallback);
  return parsed.success && (!canonical || (parsed.data.repo.toLowerCase() === canonical.repo && parsed.data.number === canonical.number))
    ? { ...parsed.data, repo: parsed.data.repo.toLowerCase() } : null;
}
type Active = {
  id: string; taskId: string; profileId: string; workspaceGeneration: number;
  phase: 'preparing' | 'inspecting' | 'cancelling' | 'saving'; cancelRequested: boolean; dispatched: boolean;
  saved?: { generation: string; intent: CodeRun['intent'] };
  progressSave?: Promise<void>;
};
export type CodeBatchItem = {
  taskId: string; title: string; source: Reference | null;
  status: 'queued' | 'running' | 'completed' | 'not-inspected' | 'failed' | 'cancelled' | 'skipped' | 'not-started' | 'save-pending';
  detail: string; runId?: string; outcome?: CodeRunOutcome;
};
export type CodeBatch = {
  profileId: string; profileName: string; workspaceGeneration: number; job: CodeAgentJob; policy: string; filter: string;
  running: boolean; stopping: boolean; reason: string; items: CodeBatchItem[];
};
export type CodeSessionsStatus = { active: Active | null; batch: CodeBatch | null; busy: boolean; error: string; revision: number };
const message = (error: unknown) => error instanceof Error ? error.message : 'The code job failed without a recognized response.';
const policy = (state: AppState, job: CodeAgentJob) => {
  const agent = codeAgents(state.work.settings).find(agent => agent.jobType === job)!;
  return JSON.stringify([agent.id, agent.instructions, agent.model, agent.jobType]);
};
const filter = (state: AppState) => JSON.stringify(state.work.sourceFilter?.selectedSources ?? null);
export function codeJob(task: Task, state: AppState): CodeAgentJob | null {
  if (task.status !== 'open' || task.work?.availability === 'waiting') return null;
  const source = codeSource(task, state);
  return source ? source.kind === 'pr' ? 'pr-review' : 'implementation-assessment' : null;
}

/** Explicit single-task and serial batch entry points share one Copilot reservation. */
export class CodeSessions {
  private listeners = new Set<() => void>();
  private status: CodeSessionsStatus = { active: null, batch: null, busy: false, error: '', revision: 0 };
  private active?: Active;
  private inFlight?: Active;
  private batch?: CodeBatch;
  constructor(private readonly controller: DesktopWorkspace, private readonly service: ServiceClient, private readonly workBusy: () => boolean) {
    controller.subscribe(() => {
      const active = this.active;
      if (active && active.workspaceGeneration !== controller.assessmentGeneration) {
        this.active = undefined;
        this.publish({ active: null });
        const alreadyRequested = active.cancelRequested;
        active.cancelRequested = true;
        if (active.dispatched && !alreadyRequested) void this.requestCancel(active).catch(error => controller.report(error));
      }
      const batch = this.batch;
      if (batch) {
        const reason = this.scopeError(batch);
        if (reason) void this.stopBatch(reason, reason !== 'Source filters changed. The batch stopped.').catch(error => controller.report(error));
      }
      const summary = batch ?? this.status.batch;
      const saved = controller.getSnapshot();
      const retried = summary?.items.filter(item => item.status === 'save-pending' && item.runId && item.outcome
        && saved.codeSaving.includes(item.runId) && !saved.codePending.some(run => run.intent.runId === item.runId)) ?? [];
      for (const item of retried) this.recordOutcome(item, item.outcome!, summary!.workspaceGeneration !== controller.assessmentGeneration);
      if (summary && retried.length) this.publishBatch(summary);
    });
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.status;
  get busy(): boolean { return !!this.inFlight || !!this.batch; }
  private publish(patch: Partial<CodeSessionsStatus>): void {
    this.status = { ...this.status, ...patch };
    for (const listener of this.listeners) listener();
  }
  private phase(active: Active, phase: Active['phase']): void {
    active.phase = phase;
    if (this.active === active) this.publish({ active: { ...active } });
  }
  private release(active: Active): void {
    if (this.inFlight === active) {
      this.inFlight = undefined;
      this.publish({ busy: this.busy });
    }
  }
  async initialize(): Promise<void> { await this.controller.platform.codeRunContext(); }
  history(profileId: string, taskId: string, before: number | null = null) {
    return this.controller.platform.codeRunRead(profileId, taskId, before);
  }
  start(taskId: string): Promise<CodeRun> {
    return this.startTask(taskId);
  }
  private startTask(taskId: string, batch?: CodeBatch): Promise<CodeRun> {
    if (this.inFlight || (this.batch && this.batch !== batch) || this.workBusy()) return Promise.reject(new Error('Wait for the current Copilot run before starting a code job.'));
    if (this.controller.isRecovering) return Promise.reject(new Error('Wait for workspace recovery before starting a code job.'));
    const state = this.controller.state;
    const task = state.tasks.find(task => task.id === taskId);
    const source = task && codeSource(task, state);
    if (!task || !source) return Promise.reject(new Error('Select a saved GitHub issue or PR to inspect code.'));
    const job = source.kind === 'pr' ? 'pr-review' : 'implementation-assessment';
    const agent = codeAgents(state.work.settings).find(agent => agent.jobType === job)!;
    const active: Active = {
      id: crypto.randomUUID(), taskId, profileId: state.activeWorkProfile.id,
      workspaceGeneration: this.controller.assessmentGeneration, phase: 'preparing', cancelRequested: false, dispatched: false,
    };
    const intent = codeRunIntentSchema.parse({
      runId: active.id, profileId: active.profileId, agentName: agent.name, startedAt: new Date().toISOString(),
      input: codeReviewInputSchema.parse({ taskId, source, job, agent: { id: agent.id, instructions: agent.instructions, model: agent.model } }),
    });
    this.active = active;
    this.inFlight = active;
    this.publish({ active: { ...active }, busy: true, error: '' });
    return this.execute(active, intent, batch);
  }
  private publishBatch(batch: CodeBatch): void {
    this.publish({ batch: { ...batch, items: batch.items.map(item => ({ ...item })) }, busy: this.busy });
  }
  private scopeError(batch: CodeBatch): string {
    if (batch.workspaceGeneration !== this.controller.assessmentGeneration || this.controller.isRecovering) return 'Workspace recovery stopped the batch.';
    const state = this.controller.state;
    if (state.activeWorkProfile.id !== batch.profileId) return 'Work profile changed. The batch stopped.';
    if (policy(state, batch.job) !== batch.policy) return 'Code agent settings changed. The batch stopped.';
    if (filter(state) !== batch.filter) return 'Source filters changed. The batch stopped.';
    return '';
  }
  private eligible(item: CodeBatchItem, batch: CodeBatch): boolean {
    const state = this.controller.state;
    const task = state.tasks.find(task => task.id === item.taskId);
    return !!task && codeJob(task, state) === batch.job && JSON.stringify(codeSource(task, state)) === JSON.stringify(item.source);
  }
  private recordOutcome(item: CodeBatchItem, outcome: CodeRunOutcome, quarantined: boolean): void {
    item.outcome = outcome;
    item.status = outcome.status === 'partial' ? 'completed' : outcome.status === 'not-inspected' ? 'not-inspected'
      : outcome.status === 'cancelled' ? 'cancelled' : 'failed';
    item.detail = quarantined ? 'Saved separately for the previous workspace; inspect or export in Backups & recovery.'
      : 'error' in outcome ? outcome.error.message
      : outcome.status === 'not-inspected' ? 'Saved: no code inspected; not approval.' : 'Saved: partial inspection only; not approval or implementation.';
  }
  startBatch(taskIds: readonly string[], job: CodeAgentJob): Promise<void> {
    if (this.busy || this.workBusy()) return Promise.reject(new Error('Wait for the current Copilot run before starting a code batch.'));
    if (this.controller.isRecovering) return Promise.reject(new Error('Wait for workspace recovery before starting a code batch.'));
    const state = this.controller.state;
    const tasks = new Map(rankedTasks(state).map(task => [task.id, task]));
    const items: CodeBatchItem[] = [...new Set(taskIds)].map(taskId => {
      const task = tasks.get(taskId);
      const eligible = task && codeJob(task, state) === job;
      return { taskId, title: task?.title ?? taskId, source: task ? codeSource(task, state) : null,
        status: eligible ? 'queued' : 'skipped', detail: eligible ? '' : 'Not an eligible selected task for this action.' };
    });
    if (!items.some(item => item.status === 'queued')) return Promise.reject(new Error('No selected tasks are eligible for this code action.'));
    const batch: CodeBatch = {
      profileId: state.activeWorkProfile.id, profileName: state.activeWorkProfile.name, workspaceGeneration: this.controller.assessmentGeneration,
      job, policy: policy(state, job), filter: filter(state), running: true, stopping: false, reason: '', items,
    };
    this.batch = batch;
    this.publishBatch(batch);
    return this.executeBatch(batch);
  }
  async stopBatch(reason = 'Stopped by you. Remaining tasks were not started.', cancelCurrent = true): Promise<void> {
    const batch = this.batch;
    if (!batch) return;
    if (!batch.stopping) {
      batch.stopping = true;
      batch.reason = reason;
      for (const item of batch.items) if (item.status === 'queued') { item.status = 'not-started'; item.detail = reason; }
      this.publishBatch(batch);
    }
    if (cancelCurrent) await this.cancelActive();
  }
  private async executeBatch(batch: CodeBatch): Promise<void> {
    try {
      for (const item of batch.items) {
        const reason = this.scopeError(batch);
        if (reason) await this.stopBatch(reason);
        if (batch.stopping) break;
        if (item.status !== 'queued') continue;
        if (!this.eligible(item, batch)) {
          item.status = 'skipped'; item.detail = 'Task completed, removed, or its source changed before dispatch.';
          this.publishBatch(batch);
          continue;
        }
        item.status = 'running';
        this.publishBatch(batch);
        try {
          const running = this.startTask(item.taskId, batch);
          item.runId = this.active?.id;
          this.publishBatch(batch);
          const run = await running;
          const outcome = run.outcome;
          this.recordOutcome(item, outcome, run.quarantined);
          if (run.quarantined || outcome.status === 'interrupted' || outcome.status === 'cancelled') {
            await this.stopBatch(run.quarantined ? 'Result belongs to the previous workspace. The batch stopped.' : 'Code job cancelled or interrupted. The batch stopped.');
          }
        } catch (error) {
          const pending = this.controller.getSnapshot().codePending.find(run => run.intent.runId === item.runId);
          item.status = pending ? 'save-pending' : 'failed';
          item.outcome = pending?.outcome;
          item.detail = message(error);
          await this.stopBatch(pending ? 'Stopped after a result-save failure. Inspect the task to retry saving or export; remaining tasks were not started.'
            : 'A code job could not start or save. Remaining tasks were not started.');
        }
        this.publishBatch(batch);
      }
    } finally {
      batch.running = false;
      this.batch = undefined;
      this.publishBatch(batch);
    }
  }
  private async execute(active: Active, intent: CodeRun['intent'], batch?: CodeBatch): Promise<CodeRun> {
    try {
      await this.controller.flush();
      const { generation } = await this.controller.platform.codeRunContext();
      if (active.workspaceGeneration !== this.controller.assessmentGeneration || this.controller.isRecovering) {
        throw new Error('The workspace changed before start. No code job was sent.');
      }
      const started = await this.controller.platform.codeRunStart(generation, intent);
      if (started.generation !== generation || JSON.stringify(started.intent) !== JSON.stringify(intent) || started.outcome.status !== 'running' || started.quarantined) {
        throw new Error('The saved start did not match this request. No code job was sent.');
      }
      active.saved = { generation, intent };
      let outcome: CodeRunOutcome;
      try {
        this.phase(active, 'inspecting');
        const item = batch?.items.find(item => item.taskId === active.taskId);
        if (active.cancelRequested || (batch && (batch.stopping || this.scopeError(batch) || !item || !this.eligible(item, batch)))) {
          outcome = { status: 'cancelled', finishedAt: new Date().toISOString(), error: { code: 'cancelled', message: 'Cancelled before any code request was sent.' } };
        } else if (active.workspaceGeneration !== this.controller.assessmentGeneration || this.controller.isRecovering) {
          outcome = { status: 'interrupted', finishedAt: new Date().toISOString(), error: { code: 'workspace-replaced', message: 'The workspace changed after the start was saved. No code request was sent.' } };
        } else {
          active.dispatched = true;
          const result = await this.service.call('work.reviewCode', intent.input, active.id);
          outcome = {
            status: result.answer.job === 'pr-review' && result.answer.conclusion.status === 'not-inspected' ? 'not-inspected' : 'partial',
            finishedAt: new Date().toISOString(), result,
          };
          codeRunSchema.parse({ generation, sequence: started.sequence, quarantined: false, intent, outcome });
        }
      } catch (error) {
        const code = error instanceof ServiceCallError ? error.code : 'code-job-failed';
        outcome = {
          status: code === 'cancelled' ? 'cancelled' : code.startsWith('service-') || code === 'native-unavailable' ? 'interrupted' : 'failed',
          finishedAt: new Date().toISOString(), error: { code, message: message(error).slice(0, 2000) },
        };
      }
      active.dispatched = false;
      this.phase(active, 'saving');
      this.release(active);
      await active.progressSave;
      const saved = await this.controller.saveCodeRun({ generation, workspaceGeneration: active.workspaceGeneration, intent, outcome });
      this.publish({ revision: this.status.revision + 1 });
      return saved;
    } catch (error) {
      this.publish({ error: message(error) });
      throw error;
    } finally {
      this.release(active);
      if (this.active === active) { this.active = undefined; this.publish({ active: null }); }
    }
  }
  async cancel(): Promise<void> {
    if (this.batch) return this.stopBatch();
    return this.cancelActive();
  }
  private async cancelActive(): Promise<void> {
    const active = this.active;
    if (!active || active.phase === 'saving' || active.cancelRequested) return;
    active.cancelRequested = true;
    this.phase(active, 'cancelling');
    if (active.saved && active.dispatched) {
      const { generation, intent } = active.saved;
      active.progressSave = this.controller.platform.codeRunUpdate(generation, intent, { status: 'cancelling' })
        .then(() => undefined).catch(error => {
          this.controller.report(new Error(`Cancellation progress could not be saved. ${message(error)} The actual outcome will still be saved separately.`));
        });
    }
    if (active.dispatched) await this.requestCancel(active);
  }
  private async requestCancel(active: Active): Promise<void> {
    try {
      const ack = await this.service.call('cancel', { requestId: active.id });
      if (ack.requestId !== active.id) throw new Error('Cancellation did not acknowledge the matching request. Waiting for its actual outcome.');
      // ACK only requests abort. execute() waits for the target's result and cleanup.
    } catch (error) {
      this.publish({ error: `Cancellation is not confirmed. ${message(error)} Waiting for the code job's outcome.` });
      throw error;
    }
  }
}
