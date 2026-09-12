import type { Thread } from '../types.ts';
import { archiveBoundary, latestTime } from './archive.ts';

export function reconcileTerminal(previous: Thread | undefined, incoming: Thread): void {
  const observation = incoming.sourceState;
  if (!observation || observation.state === 'unknown') {
    incoming.terminal = previous?.terminal ?? null;
    return;
  }
  if (observation.state !== 'open') {
    incoming.terminal = { reason: observation.state, boundary: archiveBoundary(incoming, observation.observedAt) };
    return;
  }
  const checkpoint = previous?.terminal;
  if (!checkpoint) {
    incoming.terminal = null;
    return;
  }
  const boundary = checkpoint.boundary;
  const cutoff = Date.parse(latestTime([boundary.at, boundary.evidenceAt, boundary.notificationUpdatedAt])!);
  // Compare all retained source activity to the terminal cutoff, not the previous refresh:
  // unknown checks can retain new evidence, while delayed listings can describe terminal-era activity.
  const notificationAdvanced = incoming.notificationUpdatedAt && Date.parse(incoming.notificationUpdatedAt) > cutoff;
  const evidenceAdvanced = incoming.events.some(event => event.kind !== 'read' && event.kind !== 'acknowledged'
    && event.rawKind !== 'notification-update' && Date.parse(event.at) > cutoff);
  incoming.terminal = notificationAdvanced || evidenceAdvanced ? null : checkpoint;
}

export function unknownSourceState(observedAt: string): NonNullable<Thread['sourceState']> {
  return { state: 'unknown', observedAt, updatedAt: null, error: {
    code: 'unavailable', retryable: true,
    message: 'Current source state was not returned. Terminal suppression is off; Refresh explicitly to check again.',
  } };
}
