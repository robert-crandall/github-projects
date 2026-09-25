import { codeAgents } from '../../service/src/code-agents.ts';
import { codeReviewInputSchema } from '../../service/src/code-review-schema.ts';
import { codeRunIntentSchema, codeRunSchema, type CodeRun, type CodeRunOutcome } from '../../service/src/code-runs.ts';
import { referenceSchema, type Reference } from '../../service/src/schema.ts';
import { githubReference } from '../../service/src/references.ts';
import { ServiceCallError, ServiceClient } from '../platform/service.ts';
import type { DesktopWorkspace } from '../runtime/desktop-workspace.ts';
import type { AppState, Task } from '../types.ts';

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
export type CodeSessionsStatus = { active: Active | null; error: string; revision: number };
const message = (error: unknown) => error instanceof Error ? error.message : 'The code job failed without a recognized response.';

/** Single-task entry point. Selection never dispatches; a future queue must await start(). */
export class CodeSessions {
  private listeners = new Set<() => void>();
  private status: CodeSessionsStatus = { active: null, error: '', revision: 0 };
  private active?: Active;
  constructor(private readonly controller: DesktopWorkspace, private readonly service: ServiceClient, private readonly workBusy: () => boolean) {
    controller.subscribe(() => {
      const active = this.active;
      if (active && active.workspaceGeneration !== controller.assessmentGeneration) {
        this.active = undefined;
        this.publish({ active: null });
        active.cancelRequested = true;
        if (active.dispatched) void this.requestCancel(active).catch(error => controller.report(error));
      }
    });
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.status;
  get busy(): boolean { return !!this.active; }
  private publish(patch: Partial<CodeSessionsStatus>): void {
    this.status = { ...this.status, ...patch };
    for (const listener of this.listeners) listener();
  }
  private phase(active: Active, phase: Active['phase']): void {
    active.phase = phase;
    if (this.active === active) this.publish({ active: { ...active } });
  }
  async initialize(): Promise<void> { await this.controller.platform.codeRunContext(); }
  history(profileId: string, taskId: string, before: number | null = null) {
    return this.controller.platform.codeRunRead(profileId, taskId, before);
  }
  start(taskId: string): Promise<CodeRun> {
    if (this.active || this.workBusy()) return Promise.reject(new Error('Wait for the current Copilot run before starting a code job.'));
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
    this.publish({ active: { ...active }, error: '' });
    return this.execute(active, intent);
  }
  private async execute(active: Active, intent: CodeRun['intent']): Promise<CodeRun> {
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
        if (active.cancelRequested) {
          outcome = { status: 'cancelled', finishedAt: new Date().toISOString(), error: { code: 'cancelled', message: 'Cancelled before any code request was sent.' } };
        } else if (active.workspaceGeneration !== this.controller.assessmentGeneration || this.controller.isRecovering) {
          outcome = { status: 'interrupted', finishedAt: new Date().toISOString(), error: { code: 'workspace-replaced', message: 'The workspace changed after the start was saved. No code request was sent.' } };
        } else {
          this.phase(active, 'inspecting');
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
      await active.progressSave;
      const saved = await this.controller.saveCodeRun({ generation, workspaceGeneration: active.workspaceGeneration, intent, outcome });
      this.publish({ revision: this.status.revision + 1 });
      return saved;
    } catch (error) {
      this.publish({ error: message(error) });
      throw error;
    } finally {
      if (this.active === active) { this.active = undefined; this.publish({ active: null }); }
    }
  }
  async cancel(): Promise<void> {
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
