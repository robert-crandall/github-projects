import { LIMITS, type Evidence, type Thread as SourceThread } from '../../service/src/schema.ts';
import { beginOperation, finishOperation, mergeRefresh, type RefreshBatch } from '../domain/live.ts';
import type { Activity, Thread } from '../types.ts';
import { ServiceClient, type ServiceOutput } from '../platform/service.ts';
import type { DesktopWorkspace } from './desktop-workspace.ts';
import type { RemoteStatus, RemoteWorkspace } from './remote-view.ts';
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

export class ServiceWorkspace implements RemoteWorkspace {
  private status: RemoteStatus = { refreshing: false, checking: false, diagnostics: [] };
  private listeners = new Set<() => void>();
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
  async write(destination: Destination): Promise<void> {
    const thread = destination.row.thread;
    if (!thread || !destination.action || thread.source !== 'github') throw new Error('Open a real GitHub notification before confirming this operation.');
    const previous = destination.retryId ? this.workspace.state.operations.find(operation => operation.id === destination.retryId) : undefined;
    if (destination.retryId && (!previous || previous.status === 'confirmed' || previous.status === 'pending'
      || previous.threadId !== thread.id || previous.action !== destination.action)) throw new Error('This operation cannot be retried with a different context.');
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
