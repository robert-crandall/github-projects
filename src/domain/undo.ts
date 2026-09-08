import { coalesceOutstanding, nextRoutineDue } from './clock.ts';
import { isActionable } from './ranking.ts';
import type { AppState, UndoEntry, WorkItem } from './types.ts';

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function inverse(before: unknown, after: unknown, current: unknown): unknown {
  if (same(before, after)) return current;
  if (Array.isArray(before) && Array.isArray(after) && Array.isArray(current)) {
    return current.map(value => {
      if (!record(value) || typeof value.id !== 'string') return value;
      const old = before.find(entry => record(entry) && entry.id === value.id);
      const changed = after.find(entry => record(entry) && entry.id === value.id);
      return old && changed ? inverse(old, changed, value) : value;
    });
  }
  if (record(before) && record(after) && record(current)) {
    const result = { ...current };
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (['id', 'createdAt', 'updatedAt', 'nextDueAt', 'dueAt', 'reminderAt'].includes(key)) continue;
      const value = inverse(before[key], after[key], current[key]);
      if (value === undefined) delete result[key];
      else result[key] = value;
    }
    return result;
  }
  return same(current, after) ? structuredClone(before) : current;
}

export function eligibleActive(state: AppState): void {
  const active = state.items.find(item => item.id === state.activeId);
  if (!active || !isActionable(active, state)) delete state.activeId;
}

export function recordDecision(before: AppState, after: AppState, label: string): AppState {
  const changed = before.items.filter(old => {
    const item = after.items.find(candidate => candidate.id === old.id);
    return item && !same(old, item);
  });
  if (changed.length || before.activeId !== after.activeId) {
    after.undo.push({
      id: `${label}:${after.clock}:${after.undo.length}`,
      label,
      itemsBefore: structuredClone(changed),
      itemsAfter: structuredClone(changed.map(old => after.items.find(item => item.id === old.id)!)),
      activeBefore: before.activeId,
      activeAfter: after.activeId,
    });
  }
  return after;
}

function restoreItem(current: WorkItem, before: WorkItem, after: WorkItem, clock: string): WorkItem {
  const restored = inverse(before, after, current) as WorkItem;
  // Captures and autosaved notes are not part of a decision, even if a snapshot predates them.
  restored.notes = current.notes;
  restored.sources = current.sources;
  if (same(current.steps, after.steps) && !same(before.steps, after.steps)) restored.steps = structuredClone(before.steps);
  if (!before.routine && after.routine && restored.kind !== 'routine') delete restored.routine;
  if (restored.routine) {
    if (restored.routine.time !== current.routine?.time || restored.routine.timeZone !== current.routine?.timeZone) {
      restored.routine.nextDueAt = nextRoutineDue(clock, restored.routine);
    }
    coalesceOutstanding(restored.routine);
  }
  if (!same(restored, current)) restored.updatedAt = clock;
  return restored;
}

export function undoDecision(state: AppState): AppState {
  const next = structuredClone(state);
  const entry = next.undo.pop();
  if (!entry) throw new Error('There is no decision to undo.');
  next.items = next.items.map(item => {
    const before = entry.itemsBefore.find(snapshot => snapshot.id === item.id);
    const after = entry.itemsAfter.find(snapshot => snapshot.id === item.id);
    return before && after ? restoreItem(item, before, after, next.clock) : item;
  });
  if (entry.activeBefore !== entry.activeAfter && next.activeId === entry.activeAfter) {
    next.activeId = entry.activeBefore;
  }
  eligibleActive(next);
  return next;
}

export function retainUndoForItems(entries: UndoEntry[], retained: Set<string>): UndoEntry[] {
  return entries.map(entry => ({
    ...entry,
    itemsBefore: entry.itemsBefore.filter(item => retained.has(item.id)),
    itemsAfter: entry.itemsAfter.filter(item => retained.has(item.id)),
    activeBefore: entry.activeBefore && retained.has(entry.activeBefore) ? entry.activeBefore : undefined,
    activeAfter: entry.activeAfter && retained.has(entry.activeAfter) ? entry.activeAfter : undefined,
  })).filter(entry => entry.itemsBefore.length || entry.activeBefore !== entry.activeAfter);
}
