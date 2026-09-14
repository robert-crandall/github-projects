import { LIMITS, threadIdSchema, type Evidence, type Thread as SourceThread } from '../../service/src/schema.ts';
import { beginOperation, finishOperation, mergeRefresh, type RefreshBatch } from '../domain/live.ts';
import type { Activity, Row, Thread } from '../types.ts';
import { transition } from '../domain/engine.ts';
import { ServiceClient, type ServiceOutput } from '../platform/service.ts';
import type { DesktopWorkspace } from './desktop-workspace.ts';
import type { RemoteStatus, RemoteWorkspace } from './remote-view.ts';
import type { Destination } from './view.ts';
import { ConversationWorkspace } from './conversation-workspace.ts';

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
  if (!events.some(event => Date.parse(event.at) >= Date.parse(thread.updatedAt))) events.push({
    id: `github:notification:${thread.id}:${thread.updatedAt}`, threadId: thread.id, kind: 'unknown', rawKind: 'notification-update',
    at: thread.updatedAt, actor: 'GitHub', summary: 'GitHub updated this notification. The saved timeline may not include the activity; inspect the source for context.',
    requestState: 'uncertain',
  });
  return {
    id: thread.id, ...thread.reference, source: 'github', title: thread.title,
    reason: thread.reason === 'review_requested' ? 'review_requested' : thread.reason.includes('mention') ? 'mention' : 'subscribed',
    rawReason: thread.reason, notification: thread.notification, notificationUpdatedAt: thread.updatedAt,
    state: thread.sourceState.state === 'queued' ? 'queued' : thread.sourceState.state === 'closed' || thread.sourceState.state === 'merged' ? 'closed' : 'open',
    sourceState: thread.sourceState,
    subscribed: thread.subscription === 'subscribed', subscription: thread.subscription,
    lines: thread.size ? thread.size.additions + thread.size.deletions : undefined,
    events, sourceMetadata: metadata,
    coverage: { timeline: thread.coverage.timeline, newestPage: thread.coverage.fetchedPages.includes(thread.coverage.newestPage),
      fetchedPages: thread.coverage.fetchedPages.length, observedAt: thread.coverage.observedAt },
    diagnostics: [...new Set(diagnostics.filter(diagnostic => diagnostic.threadId === thread.id).map(diagnostic => diagnostic.message))],
  };
}

export class ServiceWorkspace implements RemoteWorkspace {
  readonly conversation: ConversationWorkspace;
  private status: RemoteStatus = { refreshing: false, checking: false, diagnostics: [] };
  private listeners = new Set<() => void>();
  constructor(private readonly workspace: DesktopWorkspace, private readonly client = new ServiceClient()) {
    this.conversation = new ConversationWorkspace(workspace.platform, client);
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.status;
  private publish(patch: Partial<RemoteStatus>) { this.status = { ...this.status, ...patch }; for (const listener of this.listeners) listener(); }
  async refresh(): Promise<void> {
    if (this.status.refreshing) return;
    this.publish({ refreshing: true });
    const startedAt = new Date().toISOString();
    const conversation = this.conversation.prepareRefresh();
    try {
      const result = await this.client.call('github.refresh', {});
      const reader = await conversation;
      const batch: RefreshBatch = { startedAt, fetchedAt: result.fetchedAt, status: result.status,
        threads: result.threads.map(thread => sourceThread(thread, result.diagnostics)),
        diagnostics: result.diagnostics.map(diagnostic => diagnostic.message),
        coverageMessage: result.status === 'complete' && result.coverage.notifications === 'partial'
          ? `Showing the latest ${result.threads.length} thread${result.threads.length === 1 ? '' : 's'}.` : '' };
      this.workspace.update(current => mergeRefresh(current, batch));
      this.conversation.commit(reader);
    } catch (error) {
      const reader = await conversation;
      const message = error instanceof Error ? error.message : 'Refresh failed without usable results.';
      this.workspace.update(current => {
        const next = mergeRefresh(current, { threads: [], startedAt, fetchedAt: new Date().toISOString(), status: 'partial', diagnostics: [message] });
        return { ...next, refresh: { ...next.refresh, status: 'error', message } };
      });
      this.conversation.commit(reader);
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
    if (!thread || !destination.action || thread.source !== 'github' || !threadIdSchema.safeParse(thread.id).success) {
      throw new Error('Open a real GitHub notification before confirming this operation.');
    }
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
    } else this.workspace.update(current => beginOperation(current, {
      id: operationId, threadId: thread.id, action: destination.action!, eventIds, notificationUpdatedAt: thread.notificationUpdatedAt,
    }));
    await this.performWrite(operationId, thread);
  }
  async archive(row: Row): Promise<void> {
    const thread = row.thread;
    if (!thread || thread.source !== 'github') throw new Error('Select a saved GitHub thread before archiving.');
    const canWrite = threadIdSchema.safeParse(thread.id).success;
    const operationId = crypto.randomUUID();
    let pending = false;
    this.workspace.update(current => {
      const archived = transition(current, { type: 'archive', threadId: thread.id });
      pending = current.operations.some(operation => operation.threadId === thread.id && operation.status === 'pending');
      if (!canWrite) return archived;
      return beginOperation(archived, {
        id: operationId, threadId: thread.id, action: 'done',
        eventIds: row.events.slice(-LIMITS.events).map(event => event.id), notificationUpdatedAt: thread.notificationUpdatedAt,
      }, true);
    });
    if (!canWrite || pending) {
      await this.workspace.flush();
      this.workspace.feedback(!canWrite
        ? 'Archived here. This source has no GitHub notification ID, so no GitHub write was sent.'
        : 'Archived here. Another GitHub write is pending; retry this archive acknowledgement explicitly when it finishes.');
      return;
    }
    await this.performWrite(operationId, thread);
    this.workspace.feedback(this.workspace.state.threads.find(value => value.id === thread.id)?.archive
      ? 'Archived here. GitHub confirmed Done for this notification. Notes and Tasks are unchanged.'
      : 'GitHub confirmed Done. This thread is in Inbox here; notes and Tasks are unchanged.');
  }
  private async performWrite(operationId: string, thread: Thread): Promise<void> {
    try {
      await this.workspace.flush();
      const operation = this.workspace.state.operations.find(operation => operation.id === operationId)!;
      if (operation.action === 'done' && !operation.notificationUpdatedAt) {
        throw new Error('This intent has no saved notification-update boundary. No GitHub write was sent. Refresh, then acknowledge the current evidence explicitly instead of retrying this older intent.');
      }
      const eventIds = operation.eventIds;
      const input = { operationId, threadId: thread.id, reference: { repo: thread.repo, number: thread.number, kind: thread.kind },
        displayedEvidenceIds: eventIds, notificationUpdatedAt: operation.notificationUpdatedAt };
      const action = operation.action === 'done' ? 'acknowledge' : 'unsubscribe';
      const result = await this.client.call(action === 'acknowledge' ? 'github.acknowledge' : 'github.unsubscribe', input);
      if (result.operationId !== operationId || result.threadId !== thread.id || result.action !== action
        || JSON.stringify(result.reference) !== JSON.stringify(input.reference)
        || JSON.stringify(result.displayedEvidenceIds) !== JSON.stringify(eventIds)
        || result.notificationUpdatedAt !== input.notificationUpdatedAt) throw new Error('GitHub confirmation did not match the saved operation context.');
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
