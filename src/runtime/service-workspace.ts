import {
  evidenceSchema, triageInputSchema, reconsiderInputSchema, LIMITS,
  type Evidence, type Thread as SourceThread,
} from '../../service/src/schema.ts';
import { getRow, getRows, isRequest, priorityRank } from '../domain/engine.ts';
import { beginOperation, captureFingerprint, finishOperation, mergeRefresh, orderFingerprint, type RefreshBatch } from '../domain/live.ts';
import type { Activity, AppState, Row, Thread } from '../types.ts';
import { ServiceClient, type ServiceOutput } from '../platform/service.ts';
import type { DesktopWorkspace } from './desktop-workspace.ts';
import type { CapturePreview, OrderPreview, RemoteStatus, RemoteWorkspace } from './remote-view.ts';
import type { Destination } from './view.ts';

function activity(threadId: string, evidence: Evidence): Activity {
  const kinds: Record<Evidence['kind'], Activity['kind']> = {
    'review-request': evidence.recipient.kind === 'team' ? 'team-request' : 'review-request',
    'review-request-removed': 'unknown', review: 'comment', comment: 'comment', mention: 'mention',
    'merge-queue': 'merge-queue', commit: 'commit', closed: 'merged', reopened: 'unknown', other: 'unknown',
  };
  const recipient = evidence.recipient.kind === 'team'
    ? { kind: 'team' as const, name: evidence.recipient.team, viewerIsMember: evidence.recipient.viewerMembership === 'member' }
    : evidence.recipient.kind === 'user' ? { kind: 'user' as const, name: evidence.recipient.login, viewerIsMember: evidence.recipient.isViewer } : undefined;
  const current = evidence.requestState === 'current' && evidence.recipient.kind === 'user' && !evidence.recipient.isViewer
    ? 'uncertain' : evidence.requestState;
  return { id: evidence.id, threadId, kind: kinds[evidence.kind], rawKind: evidence.kind, at: evidence.at,
    actor: evidence.actor ?? 'Unknown actor', summary: evidence.text, requestState: current, recipient, provenance: evidence };
}

export function sourceThread(thread: SourceThread, diagnostics: ServiceOutput<'github.refresh'>['diagnostics']): Thread {
  const { evidence, ...metadata } = thread;
  const events = evidence.map(event => activity(thread.id, event));
  if (!events.length) events.push({
    id: `github:notification:${thread.id}:${thread.updatedAt}`, threadId: thread.id, kind: 'unknown', rawKind: 'notification-update',
    at: thread.updatedAt, actor: 'GitHub', summary: 'Notification activity is available, but source event evidence is incomplete. Inspect the source before deciding.',
    requestState: 'uncertain',
  });
  const queued = thread.state === 'open' && evidence.at(-1)?.kind === 'merge-queue';
  return {
    id: thread.id, ...thread.reference, source: 'github', title: thread.title,
    reason: thread.reason === 'review_requested' ? 'review_requested' : thread.reason.includes('mention') ? 'mention' : 'subscribed',
    rawReason: thread.reason, notification: thread.notification, state: queued ? 'queued' : thread.state === 'open' ? 'open' : 'closed',
    subscribed: thread.subscription === 'subscribed', subscription: thread.subscription,
    lines: thread.size ? thread.size.additions + thread.size.deletions : undefined,
    events, sourceMetadata: metadata,
    coverage: { timeline: thread.coverage.timeline, newestPage: thread.coverage.fetchedPages.includes(thread.coverage.newestPage),
      fetchedPages: thread.coverage.fetchedPages.length, observedAt: thread.coverage.observedAt },
    diagnostics: diagnostics.filter(diagnostic => diagnostic.threadId === thread.id).map(diagnostic => diagnostic.message),
  };
}

function modelEvidence(row: Row, state: AppState): Evidence[] {
  return [...row.events].sort((a, b) => Number(isRequest(b) && !state.handled.includes(b.id)) - Number(isRequest(a) && !state.handled.includes(a.id))
    || Date.parse(b.at) - Date.parse(a.at)).flatMap(event => {
      const parsed = evidenceSchema.safeParse(event.provenance);
      return parsed.success ? [{ ...parsed.data, requestState: event.requestState ?? 'uncertain' }] : [];
    }).slice(0, 20);
}

export function triagePayload(state: AppState) {
  const candidates = getRows(state, 'attention').filter(row => !!row.thread && row.kind !== 'routine')
    .sort((a, b) => priorityRank(a) - priorityRank(b));
  const items = [];
  let shortened = 0;
  for (const row of candidates) {
    if (items.length === 10) break;
    const evidence = modelEvidence(row, state);
    if (!evidence.length) continue;
    if (row.events.length > evidence.length) shortened += 1;
    const thread = row.thread!;
    const rawSize = thread.sourceMetadata?.size;
    const size = rawSize && typeof rawSize === 'object' && !Array.isArray(rawSize)
      && typeof rawSize.additions === 'number' && typeof rawSize.deletions === 'number' && typeof rawSize.changedFiles === 'number'
      ? { additions: rawSize.additions, deletions: rawSize.deletions, changedFiles: rawSize.changedFiles } : null;
    const item = { itemId: row.key, title: thread.title, reference: { repo: thread.repo, number: thread.number, kind: thread.kind },
      evidence, handledEvidenceIds: evidence.filter(event => state.handled.includes(event.id)).map(event => event.id),
      coverage: thread.coverage?.timeline ?? 'unavailable', size };
    if (new TextEncoder().encode(JSON.stringify({ items: [...items, item] })).length > LIMITS.modelBytes - 2000) break;
    items.push(item);
  }
  const parsed = triageInputSchema.safeParse({ items });
  if (!parsed.success) throw new Error('No bounded GitHub event evidence is available for Copilot. Refresh or inspect the source; local controls still work.');
  return { input: parsed.data, shortened };
}

export function reconsiderPayload(state: AppState) {
  const items = getRows(state, 'attention').sort((a, b) => priorityRank(a) - priorityRank(b)).slice(0, 30).map(row => ({
    itemId: row.key, title: row.thread?.title ?? row.title.slice(0, 500),
    category: row.kind === 'routine' || row.reason.startsWith('Local reminder due') ? 'due' as const
      : row.events.some(event => isRequest(event) && !state.handled.includes(event.id) && event.kind === 'review-request') ? 'direct-review' as const
      : row.events.some(event => isRequest(event) && !state.handled.includes(event.id) && event.kind === 'team-request') ? 'team-review' as const
      : row.action ? 'capture' as const : 'informational' as const,
    changedLines: row.thread?.lines ?? null,
    evidenceIds: row.events.filter(event => !state.handled.includes(event.id)).slice(-20).map(event => event.id),
  }));
  const parsed = reconsiderInputSchema.safeParse({ items });
  if (!parsed.success) throw new Error('No available work can be reconsidered. Capture something or refresh GitHub first.');
  return parsed.data;
}

function permutation(expected: string[], actual: string[]): void {
  if (new Set(actual).size !== actual.length || expected.length !== actual.length || actual.some(id => !expected.includes(id))) {
    throw new Error('Copilot returned an incomplete or invented ordering. No suggestion was applied.');
  }
}

export class ServiceWorkspace implements RemoteWorkspace {
  private status: RemoteStatus = { refreshing: false, checking: false, diagnostics: [] };
  private listeners = new Set<() => void>();
  private previewId?: string;
  private previewGeneration = 0;
  constructor(private readonly workspace: DesktopWorkspace, private readonly client = new ServiceClient()) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.status;
  private publish(patch: Partial<RemoteStatus>) { this.status = { ...this.status, ...patch }; for (const listener of this.listeners) listener(); }
  async refresh(): Promise<void> {
    if (this.status.refreshing) return;
    this.publish({ refreshing: true });
    const startedAt = new Date().toISOString();
    try {
      const result = await this.client.call('github.refresh', {});
      const batch: RefreshBatch = { startedAt, fetchedAt: result.fetchedAt, status: result.status,
        threads: result.threads.map(thread => sourceThread(thread, result.diagnostics)),
        diagnostics: result.diagnostics.map(diagnostic => diagnostic.message) };
      this.workspace.update(current => mergeRefresh(current, batch));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Refresh failed without usable results.';
      this.workspace.update(current => {
        const next = mergeRefresh(current, { threads: [], startedAt, fetchedAt: new Date().toISOString(), status: 'partial', diagnostics: [message] });
        return { ...next, refresh: { ...next.refresh, status: 'error' } };
      });
    } finally { this.publish({ refreshing: false }); }
  }
  async check(): Promise<void> {
    if (this.status.checking) return;
    this.publish({ checking: true });
    try {
      const result = await this.client.call('connection.check', {});
      this.publish({ diagnostics: [
        result.github.available ? `GitHub connected${result.github.viewer ? ` as ${result.github.viewer}` : ''}.` : result.github.error?.message ?? 'GitHub is unavailable.',
        result.copilot.available ? 'Copilot SDK is available.' : result.copilot.error?.message ?? 'Copilot SDK is unavailable.',
      ] });
    } catch (error) {
      this.publish({ diagnostics: [error instanceof Error ? error.message : 'Connections could not be checked.'] });
    } finally { this.publish({ checking: false }); }
  }
  async triage(mode: 'triage' | 'reconsider'): Promise<OrderPreview> {
    const generation = ++this.previewGeneration;
    await this.cancelActivePreview();
    this.requirePreview(generation);
    const state = this.workspace.state;
    const fingerprint = orderFingerprint(state);
    const id = crypto.randomUUID();
    this.previewId = id;
    try {
      if (mode === 'reconsider') {
        const input = reconsiderPayload(state);
        const result = await this.client.call('copilot.reconsider', input, id);
        const keys = input.items.map(item => item.itemId);
        permutation(keys, result.suggestedOrder);
        permutation(keys, result.reasons.map(reason => reason.itemId));
        return { fingerprint, keys, order: result.suggestedOrder,
          scope: `Copilot considered ${keys.length} of ${getRows(state, 'attention').length} available items using titles and evidence IDs, not notes. Local rules keep due work and requests first.`,
          suggestions: result.reasons.map(reason => ({ key: reason.itemId, summary: reason.reason, uncertainty: 'Suggested order only; local state is authoritative.', nextStep: 'Choose work explicitly.', evidence: [] })) };
      }
      const { input, shortened } = triagePayload(state);
      const result = await this.client.call('copilot.triage', input, id);
      const keys = input.items.map(item => item.itemId);
      permutation(keys, result.suggestedOrder);
      permutation(keys, result.suggestions.map(suggestion => suggestion.itemId));
      const suggestions = result.suggestions.map(suggestion => {
        const item = input.items.find(item => item.itemId === suggestion.itemId)!;
        if (suggestion.evidenceIds.some(id => !item.evidence.some(event => event.id === id))
          || (suggestion.nextAction === 'review' && !item.evidence.some(event => suggestion.evidenceIds.includes(event.id)
            && event.kind === 'review-request' && event.requestState === 'current' && !item.handledEvidenceIds.includes(event.id)))) {
          throw new Error('Copilot suggested a request without current unhandled evidence. No suggestion was applied.');
        }
        return { key: suggestion.itemId, summary: suggestion.summary, uncertainty: suggestion.uncertainty,
          nextStep: suggestion.nextAction, evidence: item.evidence.filter(event => suggestion.evidenceIds.includes(event.id)).map(event => `${event.actor ?? 'Unknown actor'} · ${event.at}: ${event.text}`) };
      });
      return { fingerprint, keys, order: result.suggestedOrder, suggestions,
        scope: `Copilot considered ${keys.length} notifications, at most 20 events each${shortened ? ` (${shortened} histories shortened)` : ''}. Other rows were not sent. Local rules keep due work and requests first.` };
    } finally { if (this.previewId === id) this.previewId = undefined; }
  }
  async interpret(row: Row): Promise<CapturePreview> {
    const generation = ++this.previewGeneration;
    await this.cancelActivePreview();
    this.requirePreview(generation);
    await this.workspace.flush();
    this.requirePreview(generation);
    const state = this.workspace.state;
    const item = getRow(state, row.key)?.action;
    if (!item?.captures.length) throw new Error('Save the original capture before interpretation.');
    const fingerprint = captureFingerprint(state, row.key);
    const id = crypto.randomUUID();
    this.previewId = id;
    try {
      const result = await this.client.call('copilot.interpretCapture', { captureId: item.id, text: item.captures.at(-1)!, timeZone: state.timeZone }, id);
      if (result.captureId !== item.id) throw new Error('Copilot returned a proposal for a different capture.');
      return { key: row.key, fingerprint, proposal: result.proposal };
    } finally { if (this.previewId === id) this.previewId = undefined; }
  }
  private requirePreview(generation: number): void {
    if (generation !== this.previewGeneration) throw new Error('Copilot preview was cancelled. Nothing was applied.');
  }
  cancelPreview(): Promise<void> {
    this.previewGeneration += 1;
    return this.cancelActivePreview();
  }
  private async cancelActivePreview(): Promise<void> {
    const requestId = this.previewId;
    this.previewId = undefined;
    if (requestId) await this.client.call('cancel', { requestId });
  }
  async write(destination: Destination): Promise<void> {
    const thread = destination.row.thread;
    if (!thread || !destination.action || thread.source !== 'github') throw new Error('Open a real GitHub notification before confirming this operation.');
    const previous = destination.retryId ? this.workspace.state.operations.find(operation => operation.id === destination.retryId) : undefined;
    if (destination.retryId && (!previous || previous.status === 'confirmed' || previous.status === 'pending')) throw new Error('This operation cannot be retried.');
    const operationId = previous?.id ?? crypto.randomUUID();
    const eventIds = previous?.eventIds ?? destination.row.events.slice(-LIMITS.events).map(event => event.id);
    if (previous) {
      this.workspace.update(current => {
        if (current.operations.some(operation => operation.threadId === thread.id && operation.status === 'pending')) throw new Error('A GitHub operation is already pending.');
        return { ...current, operations: current.operations.map(operation => operation.id === previous.id
          ? { ...operation, status: 'pending', message: 'Retry intent awaits local persistence; GitHub has not confirmed success.' } : operation) };
      });
    } else this.workspace.update(current => beginOperation(current, { id: operationId, threadId: thread.id, action: destination.action!, eventIds }));
    try {
      await this.workspace.flush();
      const input = { operationId, threadId: thread.id, reference: { repo: thread.repo, number: thread.number, kind: thread.kind }, displayedEvidenceIds: eventIds };
      const action = destination.action === 'done' ? 'acknowledge' : 'unsubscribe';
      const result = await this.client.call(action === 'acknowledge' ? 'github.acknowledge' : 'github.unsubscribe', input);
      if (result.operationId !== operationId || result.threadId !== thread.id || result.action !== action
        || JSON.stringify(result.reference) !== JSON.stringify(input.reference)
        || JSON.stringify(result.displayedEvidenceIds) !== JSON.stringify(eventIds)) throw new Error('GitHub confirmation did not match the saved operation context.');
      this.workspace.update(current => finishOperation(current, operationId, { confirmedAt: result.confirmedAt }));
      await this.workspace.flush();
    } catch (error) {
      if (this.workspace.state.operations.find(operation => operation.id === operationId)?.status === 'pending') {
        this.workspace.update(current => finishOperation(current, operationId, { error: error instanceof Error ? error.message : 'No confirmation was saved.' }));
        try { await this.workspace.flush(); }
        catch (saveError) { this.workspace.report(saveError); }
      }
      throw error;
    }
  }
}
