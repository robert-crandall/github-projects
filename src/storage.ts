import type { AppState } from './domain/types.ts';
import { timestamp, validateTimeZone } from './domain/clock.ts';

export const STORAGE_KEY = 'follow-through.prototype.v1';

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string';
const date = (value: unknown) => {
  try { return text(value) && Number.isFinite(timestamp(value)); } catch { return false; }
};
const zone = (value: unknown) => {
  try { if (!text(value)) return false; validateTimeZone(value); return true; } catch { return false; }
};
const bounded = (value: unknown, max = 2000) => text(value) && !!value.trim() && value.length <= max;
const optional = (value: unknown, check: (value: unknown) => boolean) => value === undefined || check(value);
const list = (value: unknown, check: (value: unknown) => boolean) => Array.isArray(value) && value.every(check);
const step = (value: unknown) => object(value) && text(value.id) && text(value.title) && optional(value.doneAt, date);
const source = (value: unknown) => object(value) && text(value.id) && text(value.label)
  && ['github', 'capture', 'routine'].includes(String(value.kind)) && optional(value.reference, text);
const occurrence = (value: unknown) => object(value) && text(value.id) && date(value.dueAt)
  && ['outstanding', 'completed', 'skipped', 'missed'].includes(String(value.status))
  && list(value.steps, step) && optional(value.reminderAt, date) && optional(value.finishedAt, date)
  && optional(value.snoozedUntil, date) && optional(value.reminderDismissed, (v) => typeof v === 'boolean');
const routine = (value: unknown) => object(value) && text(value.time)
  && /^([01]\d|2[0-3]):[0-5]\d$/.test(value.time) && date(value.nextDueAt)
  && optional(value.timeZone, zone)
  && list(value.occurrences, occurrence);
const review = (value: unknown) => object(value) && ['direct', 'team', 'manual'].includes(String(value.request))
  && optional(value.identity, text) && optional(value.team, text)
  && optional(value.lines, (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0)
  && optional(value.files, (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0);
const item = (value: unknown) => object(value) && text(value.id) && text(value.title)
  && ['review', 'fix', 'mention', 'task', 'routine'].includes(String(value.kind))
  && ['available', 'deferred', 'waiting', 'completed', 'removed'].includes(String(value.status))
  && date(value.createdAt) && date(value.updatedAt) && list(value.sources, source)
  && text(value.notes) && list(value.steps, step) && text(value.nextStep)
  && optional(value.projectId, text) && optional(value.reason, text) && optional(value.evidence, text)
  && optional(value.availableAt, date) && optional(value.completedAt, date)
  && optional(value.startedAt, date) && optional(value.review, review)
  && optional(value.signalCurrent, v => typeof v === 'boolean')
  && optional(value.routine, routine) && (value.kind !== 'routine' || routine(value.routine));
const capture = (value: unknown) => object(value) && text(value.id) && text(value.original)
  && date(value.createdAt) && text(value.itemId)
  && ['pending', 'task', 'review', 'routine', 'unsupported', 'error'].includes(String(value.interpretation))
  && optional(value.explanation, text) && optional(value.timeZone, zone)
  && optional(value.actionEdited, v => typeof v === 'boolean');
const project = (value: unknown) => object(value) && text(value.id) && text(value.name) && text(value.notes);
const undo = (value: unknown) => object(value) && text(value.id) && text(value.label)
  && list(value.itemsBefore, item) && list(value.itemsAfter, item)
  && optional(value.activeBefore, text) && optional(value.activeAfter, text);
const ranking = (value: unknown) => {
  if (!object(value) || !Array.isArray(value.orderedIds) || value.orderedIds.length > 40
    || !value.orderedIds.every(id => bounded(id, 500)) || new Set(value.orderedIds).size !== value.orderedIds.length
    || !Array.isArray(value.reasons) || value.reasons.length !== value.orderedIds.length
    || !bounded(value.summary) || !date(value.generatedAt)) return false;
  const ids = new Set(value.orderedIds);
  const reasons = new Set();
  for (const reason of value.reasons) {
    if (!object(reason) || !ids.has(reason.id) || reasons.has(reason.id) || !bounded(reason.reason, 500)) return false;
    reasons.add(reason.id);
  }
  return true;
};

export function isAppState(value: unknown): value is AppState {
  const valid = object(value) && value.version === 1 && date(value.clock)
    && optional(value.runtime, v => v === 'desktop') && optional(value.aiRanking, ranking)
    && list(value.items, item) && list(value.captures, capture) && list(value.projects, project)
    && list(value.undo, undo) && text(value.draft) && optional(value.activeId, text)
    && typeof value.interpretationError === 'boolean'
    && object(value.sync) && ['ok', 'error', 'disconnected'].includes(String(value.sync.status)) && date(value.sync.lastSuccessAt)
    && optional(value.sync.login, v => bounded(v, 100)) && optional(value.sync.error, v => bounded(v))
    && optional(value.sync.warnings, v => Array.isArray(v) && v.length <= 100 && v.every(warning => bounded(warning)));
  if (!valid || !object(value) || !Array.isArray(value.items) || !Array.isArray(value.captures)) return false;
  const ids = new Set(value.items.map((entry: Record<string, unknown>) => entry.id));
  return ids.size === value.items.length
    && new Set(value.captures.map((entry: Record<string, unknown>) => entry.id)).size === value.captures.length
    && (value.activeId === undefined || ids.has(value.activeId))
    && (!object(value.aiRanking) || (value.aiRanking.orderedIds as string[]).every(id => ids.has(id)))
    && value.captures.every((entry: Record<string, unknown>) => ids.has(entry.itemId))
    && value.items.every((entry: Record<string, unknown>) => !object(entry.routine)
      || !Array.isArray(entry.routine.occurrences)
      || entry.routine.occurrences.filter((record: Record<string, unknown>) => record.status === 'outstanding').length <= 1);
}

export function loadState(): AppState | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  const parsed: unknown = JSON.parse(raw);
  if (!isAppState(parsed)) {
    throw new Error('The saved workspace has an unsupported or damaged format. It has not been overwritten.');
  }
  return parsed;
}

export function saveState(state: AppState) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

export function preserveBackup() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) localStorage.setItem(`${STORAGE_KEY}.backup.${Date.now()}`, raw);
}
