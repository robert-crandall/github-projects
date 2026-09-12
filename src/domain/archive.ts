import type { Thread } from '../types.ts';

export function latestTime(values: (string | undefined)[]): string | undefined {
  return values.filter((value): value is string => value !== undefined)
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0];
}

export function archiveBoundary(thread: Thread, at: string): NonNullable<Thread['archive']> {
  const evidenceAt = latestTime(thread.events.filter(event => event.kind !== 'read' && event.kind !== 'acknowledged').map(event => event.at));
  return {
    at, ...(thread.notificationUpdatedAt ? { notificationUpdatedAt: thread.notificationUpdatedAt } : {}),
    ...(evidenceAt ? { evidenceAt } : {}),
  };
}

export function hasNewActivity(previous: Thread, incoming: Thread): boolean {
  const boundary = previous.archive;
  if (!boundary) return false;
  const notificationAt = boundary.notificationUpdatedAt ?? latestTime([boundary.at, boundary.evidenceAt])!;
  if (incoming.notificationUpdatedAt && Date.parse(incoming.notificationUpdatedAt) > Date.parse(notificationAt)) return true;
  // A newly fetched ID alone can be old history, including a previously missing page.
  const evidenceAt = latestTime([boundary.at, boundary.evidenceAt, boundary.notificationUpdatedAt])!;
  const known = new Set(previous.events.map(event => event.id));
  return incoming.events.some(event => !known.has(event.id) && event.kind !== 'read' && event.kind !== 'acknowledged'
    && event.rawKind !== 'notification-update' && Date.parse(event.at) > Date.parse(evidenceAt));
}
