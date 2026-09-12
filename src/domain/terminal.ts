import type { Thread } from '../types.ts';
import { archiveBoundary, hasNewActivity } from './archive.ts';

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
  incoming.terminal = previous?.terminal && !hasNewActivity({ ...previous, archive: previous.terminal.boundary }, incoming)
    ? previous.terminal : null;
}

export function unknownSourceState(observedAt: string): NonNullable<Thread['sourceState']> {
  return { state: 'unknown', observedAt, updatedAt: null, error: {
    code: 'unavailable', retryable: true,
    message: 'Current source state was not returned. Terminal suppression is off; Refresh explicitly to check again.',
  } };
}
