import type { z } from 'zod';
import {
  defaultWorkState, workRankOutputSchema, workSettingsSchema,
  type workConnectionsSchema, type WorkCollection, type WorkRankInput, type WorkSettings,
} from '../../service/src/work-schema.ts';
import { ServiceClient } from '../platform/service.ts';
import type { DesktopWorkspace } from '../runtime/desktop-workspace.ts';
import type { AppState } from '../types.ts';
import { completeWorkTask, rankInput, reconcileWork, restoreWorkTask } from './engine.ts';

export type WorkConnections = z.infer<typeof workConnectionsSchema>;
export type WorkQueueSnapshot = {
  running: boolean; phase: string; error: string; warnings: string[]; connections?: WorkConnections;
};

const message = (error: unknown) => error instanceof Error ? error.message : 'The work run failed without usable results.';
function exactIds(expected: string[], actual: string[]): boolean {
  const ids = new Set(actual);
  return ids.size === actual.length && expected.length === actual.length && expected.every(id => ids.has(id));
}
function sourceSettings(settings: WorkSettings): string {
  return JSON.stringify({ streams: settings.streams, model: settings.model });
}

export class WorkQueue {
  private listeners = new Set<() => void>();
  private active?: Promise<void>;
  private status: WorkQueueSnapshot;

  constructor(private readonly controller: DesktopWorkspace, private readonly service = new ServiceClient()) {
    this.status = {
      running: false, phase: 'idle', error: controller.getSnapshot().workspace?.state.work?.lastError ?? '', warnings: [],
    };
  }

  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.status;
  private publish(patch: Partial<WorkQueueSnapshot>): void {
    this.status = { ...this.status, ...patch };
    for (const listener of this.listeners) listener();
  }
  private update(transform: (state: AppState) => AppState): void {
    this.controller.update(current => transform({ ...current, work: current.work ?? defaultWorkState() }));
  }

  saveSettings(settings: WorkSettings): void {
    const saved = workSettingsSchema.parse(settings);
    this.update(current => ({
      ...current, work: {
        ...current.work, settings: saved,
        ...(sourceSettings(current.work.settings) !== sourceSettings(saved) ? { collectionCursor: null } : {}),
      },
    }));
  }
  capture(title: string, notes = ''): void {
    this.validateText(title, notes);
    this.update(current => ({
      ...current,
      tasks: [...current.tasks, { id: crypto.randomUUID(), title: title.trim(), notes, status: 'open', createdAt: current.clock }],
    }));
  }
  complete(id: string): void {
    this.update(current => completeWorkTask(current, id, current.clock));
  }
  restore(id: string): void {
    this.update(current => restoreWorkTask(current, id));
  }
  edit(id: string, title: string, notes: string): void {
    this.validateText(title, notes);
    this.update(current => {
      if (!current.tasks.some(task => task.id === id)) throw new Error('This task no longer exists.');
      return { ...current, tasks: current.tasks.map(task => task.id === id ? { ...task, title: title.trim(), notes } : task) };
    });
  }
  private validateText(title: string, notes: string): void {
    if (!title.trim()) throw new Error('Write a task title first.');
    if (title.length > 2000 || notes.length > 16000) throw new Error('Use at most 2,000 characters for a title and 16,000 for task notes.');
  }

  async connections(): Promise<void> {
    try { this.publish({ connections: await this.service.call('work.connections', {}) }); }
    catch (error) { this.publish({ error: message(error) }); }
  }

  run(): Promise<void> { return this.start(new Date()); }
  async tick(now = new Date()): Promise<void> {
    if (this.status.running) return;
    const work = this.controller.state.work ?? defaultWorkState();
    if (!work.settings.schedule.enabled) return;
    const boundary = Math.max(
      work.lastStartedAt ? Date.parse(work.lastStartedAt) : 0,
      work.lastCompletedAt ? Date.parse(work.lastCompletedAt) : 0,
    );
    if (now.getTime() - boundary < work.settings.schedule.everyMinutes * 60_000) return;
    await this.start(now);
  }

  private start(now: Date): Promise<void> {
    if (this.status.running) return this.active ?? Promise.resolve();
    this.publish({ running: true, phase: 'saving', error: '', warnings: [] });
    const running = this.execute(now);
    this.active = running;
    return running;
  }

  private async persist(batch: WorkCollection): Promise<void> {
    this.update(current => reconcileWork(current, batch, new Date()));
    await this.controller.flush();
  }

  private async intake(): Promise<void> {
    const seen = new Set<string>();
    for (let page = 0; page < 20; page += 1) {
      const intake = await this.service.call('work.intake', {});
      const ids = [...new Set(intake.items.map(item => item.id))];
      if (intake.hasMore && (!ids.length || ids.every(id => seen.has(id)))) {
        throw new Error('Task intake did not advance. Saved tasks are retained; retry the remaining intake.');
      }
      if (intake.items.length) {
        await this.persist({
          candidates: intake.items.map(item => item.candidate), observations: [], warnings: [], collectedAt: new Date().toISOString(),
        });
        const ack = await this.service.call('work.ackIntake', { ids });
        if (!exactIds(ids, ack.ids)) throw new Error('Task intake acknowledgement did not match the saved items.');
        for (const id of ids) seen.add(id);
      }
      if (!intake.hasMore) return;
    }
    throw new Error('More task intake remains. Saved tasks are retained; run again to continue.');
  }

  private async rank(): Promise<string[]> {
    const input = rankInput(this.controller.state);
    const submitted = new Map(this.controller.state.tasks.map(task => [task.id, JSON.stringify(task)]));
    // Empty queues have nothing to order; every nonempty queue goes through the SDK.
    const result = input.tasks.length
      ? workRankOutputSchema.parse(await this.service.call('work.rank', input))
      : { orderedIds: [], reasons: [] };
    const ids = input.tasks.map(task => task.id);
    if (!exactIds(ids, result.orderedIds) || !exactIds(ids, result.reasons.map(reason => reason.id))
      || result.reasons.some(reason => !reason.reason.trim())) {
      throw new Error('Ranking must contain every submitted task ID and exactly one reason per task, without duplicates or invented IDs.');
    }
    const warnings: string[] = [];
    this.update(current => {
      if (current.work.settings.instructions !== input.instructions || current.work.settings.model !== input.model) {
        throw new Error('Ranking settings changed during the run. The previous order is retained; run again with the saved settings.');
      }
      const latest: WorkRankInput = rankInput(current);
      const eligible = new Set(latest.tasks.map(task => task.id));
      const matching = new Set(current.tasks.filter(task => eligible.has(task.id)
        && submitted.get(task.id) === JSON.stringify(task)).map(task => task.id));
      const unranked = latest.tasks.length - matching.size;
      if (unranked) warnings.push(`${unranked} new or edited task${unranked === 1 ? ' is' : 's are'} unranked. Run again to include ${unranked === 1 ? 'it' : 'them'}.`);
      return {
        ...current, work: {
          ...current.work, ranking: {
            orderedIds: result.orderedIds.filter(id => matching.has(id)),
            reasons: result.reasons.filter(reason => matching.has(reason.id)),
            rankedAt: new Date().toISOString(),
          },
        },
      };
    });
    await this.controller.flush();
    return warnings;
  }

  private async execute(now: Date): Promise<void> {
    const errors: string[] = [];
    const warnings: string[] = [];
    let previousCompletedAt: string | null | undefined;
    let previousCursor: string | null = null;
    let scannedSettings = '';
    let completionWritten = false;
    try {
      this.update(current => {
        previousCompletedAt = current.work.lastCompletedAt;
        return { ...current, work: { ...current.work, lastStartedAt: now.toISOString() } };
      });
      await this.controller.flush();
      const { settings, collectionCursor } = this.controller.state.work;
      scannedSettings = sourceSettings(settings);
      const streams = structuredClone(settings.streams.filter(stream => stream.enabled));
      this.publish({ phase: 'intake' });
      try { await this.intake(); }
      catch (error) {
        if (this.controller.getSnapshot().persistence.error) throw error;
        errors.push(`Task intake: ${message(error)}`);
      }
      for (const stream of streams) {
        this.publish({ phase: `collecting: ${stream.name}` });
        const knownUrls = [...new Set(this.controller.state.tasks
          .filter(task => task.status === 'open' && task.work && new URL(task.work.url).hostname === 'github.com')
          .map(task => task.work!.url))];
        for (let offset = 0; offset < Math.max(knownUrls.length, 1); offset += 100) {
          try {
            const result = await this.service.call('work.collect', {
              stream, model: settings.model, since: collectionCursor, knownUrls: knownUrls.slice(offset, offset + 100),
              observeOnly: offset > 0,
            });
            await this.persist(result);
            for (const warning of result.warnings) {
              warnings.push(`${stream.name}: ${warning}`);
              errors.push(`${stream.name}: ${warning}`);
            }
          } catch (error) {
            if (this.controller.getSnapshot().persistence.error) throw error;
            errors.push(`${stream.name}: ${message(error)}`);
          }
        }
      }
      this.publish({ phase: 'ranking', warnings: [...warnings] });
      try { warnings.push(...await this.rank()); }
      catch (error) { errors.push(`Ranking: ${message(error)}`); }
      this.update(current => {
        if (sourceSettings(current.work.settings) !== scannedSettings) {
          errors.push('Source settings changed during the run. Run again to collect the saved sources.');
        }
        previousCursor = current.work.collectionCursor;
        completionWritten = errors.length === 0;
        return {
          ...current, work: {
            ...current.work, lastError: errors.join('\n').slice(0, 4000),
            ...(completionWritten ? { lastCompletedAt: new Date().toISOString(), collectionCursor: now.toISOString() } : {}),
          },
        };
      });
      await this.controller.flush();
    } catch (error) {
      errors.push(message(error));
      try {
        this.update(current => ({
          ...current, work: {
            ...current.work, lastError: errors.join('\n').slice(0, 4000),
            ...(completionWritten ? { lastCompletedAt: previousCompletedAt ?? null } : {}),
            ...(completionWritten && sourceSettings(current.work.settings) === scannedSettings
              && current.work.collectionCursor === now.toISOString() ? { collectionCursor: previousCursor } : {}),
          },
        }));
        await this.controller.flush();
      } catch { /* The native persistence queue retains the latest state for explicit recovery. */ }
    } finally {
      this.active = undefined;
      this.publish({ running: false, phase: errors.length ? 'error' : 'idle', error: errors.join('\n'), warnings });
    }
  }
}
