import { outstanding, timestamp } from './clock.ts';
import type { AppState, WorkItem } from './types.ts';

export function isActionable(item: WorkItem, state: AppState): boolean {
  if (item.status !== 'available') return false;
  if (item.signalCurrent === false && !item.wake && state.activeId !== item.id && !item.sources.some(source => source.kind === 'capture')) return false;
  if (item.availableAt && timestamp(item.availableAt) > timestamp(state.clock)) return false;
  if (item.kind === 'routine') {
    const occurrence = outstanding(item);
    if (!occurrence || (timestamp(occurrence.dueAt) > timestamp(state.clock)
      && !(state.runtime === 'desktop' && state.activeId === item.id))) return false;
    if (occurrence.snoozedUntil && timestamp(occurrence.snoozedUntil) > timestamp(state.clock)) return false;
  }
  return true;
}

function smallReview(item: WorkItem): boolean {
  const lines = item.review?.lines;
  return item.kind === 'review' && lines !== undefined && Number.isFinite(lines) && lines >= 0 && lines <= 50;
}

export function isPossibleRereview(item: WorkItem): boolean {
  return item.kind === 'review' && item.review?.request === 'manual'
    && item.sources.some(source => source.kind === 'github' && source.id === `github:${item.review?.identity}:Reviewed`)
    && !item.sources.some(source => source.kind === 'capture');
}

function priority(item: WorkItem, state: AppState): number {
  if (state.activeId === item.id) return 0;
  if (item.kind === 'routine') return 1;
  if (isPossibleRereview(item)) return 8;
  if (smallReview(item)) {
    return item.review?.request === 'direct' ? 2 : item.review?.request === 'team' ? 3 : 4;
  }
  return { review: 5, fix: 6, task: 7, mention: 8, routine: 1 }[item.kind];
}

export function rankedItems(state: AppState): WorkItem[] {
  const aiOrder = new Map(state.aiRanking?.orderedIds.map((id, index) => [id, index]));
  const fixedPriority = (item: WorkItem) => state.activeId === item.id ? 0 : item.kind === 'routine' ? 1 : 2;
  return state.items.filter(item => isActionable(item, state)).sort((a, b) =>
    fixedPriority(a) - fixedPriority(b)
    || (fixedPriority(a) === 2 ? (aiOrder.get(a.id) ?? 40) - (aiOrder.get(b.id) ?? 40) : 0)
    || priority(a, state) - priority(b, state)
    || timestamp(a.updatedAt) - timestamp(b.updatedAt)
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

export function reconcileAiRanking(state: AppState): void {
  if (!state.aiRanking) return;
  const eligible = new Set(state.items.filter(item => isActionable(item, state)).map(item => item.id));
  state.aiRanking.orderedIds = state.aiRanking.orderedIds.filter(id => eligible.has(id));
  state.aiRanking.reasons = state.aiRanking.reasons.filter(reason => eligible.has(reason.id));
  if (!state.aiRanking.orderedIds.length) delete state.aiRanking;
}

export function recommendationReason(item: WorkItem, state: AppState): string {
  if (!isActionable(item, state)) {
    if (item.status === 'waiting' || item.status === 'deferred') return item.reason || 'Saved for later.';
    if (item.status === 'completed') return 'Completed locally.';
    if (item.status === 'removed') return 'Removed from recommendations.';
    if (item.signalCurrent === false) return 'Not seen in the latest GitHub snapshot; the previous signal may no longer require action.';
    if (outstanding(item)?.snoozedUntil) return 'Routine snoozed; progress is saved.';
    return 'Scheduled for later.';
  }
  if (state.activeId === item.id) return 'Your active action; keeping your place.';
  if (item.kind === 'routine') return `Your ${item.routine!.time} ${item.routine!.timeZone ?? 'UTC'} routine is due.`;
  if (item.wake) return {
    mention: 'Awake: someone mentioned you on GitHub.',
    'review-request': 'Awake: your review was requested.',
    time: 'Awake: your chosen time has arrived.',
    manual: 'You brought this action back.',
  }[item.wake.reason];
  if (item.signalCurrent === false) return 'Your saved commitment; its previous GitHub signal is no longer current.';
  if (isPossibleRereview(item)) return 'May need another review; recent activity is not a review request.';
  const aiReason = state.aiRanking?.reasons.find(reason => reason.id === item.id)?.reason;
  if (aiReason) return aiReason;
  if (smallReview(item)) {
    if (item.review?.request === 'direct') return 'Small review; directly requested.';
    if (item.review?.request === 'team') return 'Small review; requested from your team.';
    return 'Small review; supported by the recorded diff.';
  }
  if (item.kind === 'review') return 'Review request; size is unknown or above the small-review limit.';
  if (item.kind === 'fix') return 'Your authored PR needs a fix.';
  if (item.kind === 'mention') return 'May need a reply; a mention is not a confirmed request.';
  return 'An available next action you saved.';
}
