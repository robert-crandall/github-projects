import { Temporal } from '@js-temporal/polyfill';
import type { AppState, Occurrence, Routine, WorkItem } from './types.ts';

export function timestamp(value: string): number {
  const match = /^(\d{4}-\d{2}-\d{2})(?:T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,9})?)?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?)?$/.exec(value);
  if (!match) throw new Error('Use a valid date and time in ISO format.');
  // Offset-free inputs use the demo's UTC timezone, not the browser's timezone.
  const input = !value.includes('T') ? `${value}T00:00:00Z` : match[2] ? value : `${value}Z`;
  const parsed = Date.parse(input);
  const day = new Date(`${match[1]}T00:00:00Z`);
  if (!Number.isFinite(parsed) || !Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== match[1]) {
    throw new Error('Use a valid date and time.');
  }
  return parsed;
}

export function validateTime(time: string): void {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    throw new Error('Use a daily time in HH:mm format.');
  }
}

export function validateTimeZone(zone: string): void {
  try {
    if (!zone || /^[+-]/.test(zone)) throw new Error();
    Temporal.Instant.fromEpochMilliseconds(0).toZonedDateTimeISO(zone);
  } catch {
    throw new Error('Use a valid IANA timezone, such as America/Los_Angeles.');
  }
}

export function systemTimeZone(): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  validateTimeZone(zone);
  return zone;
}

export function calendarDay(clock: string, zone = 'UTC'): string {
  validateTimeZone(zone);
  return Temporal.Instant.fromEpochMilliseconds(timestamp(clock)).toZonedDateTimeISO(zone).toPlainDate().toString();
}

export function dateAtTime(day: string, time: string, zone = 'UTC'): string {
  validateTime(time);
  validateTimeZone(zone);
  const date = Temporal.PlainDate.from(day.includes('T') ? calendarDay(day, zone) : new Date(timestamp(day)).toISOString().slice(0, 10));
  // Compatible disambiguation shifts spring gaps forward and uses the first
  // occurrence of a repeated fall time. Each local date still occurs only once.
  return date.toPlainDateTime(time).toZonedDateTime(zone, { disambiguation: 'compatible' })
    .toInstant().toString({ fractionalSecondDigits: 3 });
}

export function nextDailyDue(clock: string, time: string, zone = 'UTC'): string {
  const today = dateAtTime(clock, time, zone);
  return timestamp(today) > timestamp(clock) ? today : nextCalendarDue(today, time, zone);
}

function nextCalendarDue(dueAt: string, time: string, zone = 'UTC'): string {
  const day = Temporal.PlainDate.from(calendarDay(dueAt, zone)).add({ days: 1 }).toString();
  return dateAtTime(day, time, zone);
}

export function nextRoutineDue(clock: string, routine: Routine): string {
  const zone = routine.timeZone ?? 'UTC';
  let dueAt = nextDailyDue(clock, routine.time, zone);
  const lastDay = routine.occurrences.reduce((last, occurrence) => {
    const day = calendarDay(occurrence.dueAt, zone);
    return day > last ? day : last;
  }, '');
  if (calendarDay(dueAt, zone) <= lastDay) {
    dueAt = dateAtTime(Temporal.PlainDate.from(lastDay).add({ days: 1 }).toString(), routine.time, zone);
  }
  return dueAt;
}

export function addDays(clock: string, days: number, zone = 'UTC'): string {
  validateTimeZone(zone);
  return Temporal.Instant.fromEpochMilliseconds(timestamp(clock)).toZonedDateTimeISO(zone)
    .add({ days }).toInstant().toString({ fractionalSecondDigits: 3 });
}

export function outstanding(item: WorkItem): Occurrence | undefined {
  return item.routine?.occurrences.find(occurrence => occurrence.status === 'outstanding');
}

// Undo can revive an older occurrence after a newer day has already become due.
// Keep the original work and timestamps; retain the other days as history.
export function coalesceOutstanding(routine: Routine): void {
  const pending = routine.occurrences
    .filter(occurrence => occurrence.status === 'outstanding')
    .sort((a, b) => timestamp(a.dueAt) - timestamp(b.dueAt) || a.id.localeCompare(b.id));
  for (const extra of pending.slice(1)) extra.status = 'missed';
}

export function reconcileClock(state: AppState, to: string): AppState {
  const target = timestamp(to);
  if (target < timestamp(state.clock) && state.runtime !== 'desktop') throw new Error('The demo clock cannot move backwards.');
  const next = structuredClone(state);
  next.clock = new Date(target).toISOString();

  for (const item of next.items) {
    let resumedAt: string | undefined;
    if (next.runtime === 'desktop' && item.status === 'deferred' && item.availableAt
      && timestamp(item.availableAt) <= target) {
      resumedAt = item.availableAt;
      item.status = 'available';
      delete item.availableAt;
      delete item.reason;
    }
    const routine = item.routine;
    if (!routine) continue;
    validateTime(routine.time);
    const zone = routine.timeZone ?? 'UTC';
    validateTimeZone(zone);
    coalesceOutstanding(routine);
    if (resumedAt) {
      const sameDay = dateAtTime(resumedAt, routine.time, zone);
      const firstDue = timestamp(sameDay) >= timestamp(resumedAt) ? sameDay : nextDailyDue(resumedAt, routine.time, zone);
      if (timestamp(firstDue) > timestamp(routine.nextDueAt)) routine.nextDueAt = firstDue;
    }
    if (next.runtime === 'desktop' && item.status !== 'available') {
      const future = nextRoutineDue(next.clock, routine);
      if (timestamp(future) > timestamp(routine.nextDueAt)) routine.nextDueAt = future;
      continue;
    }
    const recordedDays = new Set(routine.occurrences.map(occurrence => calendarDay(occurrence.dueAt, zone)));
    while (timestamp(routine.nextDueAt) <= target) {
      const dueAt = routine.nextDueAt;
      const id = `${item.id}@${dueAt}`;
      const day = calendarDay(dueAt, zone);
      if (!recordedDays.has(day)) {
        const alreadyOutstanding = !!outstanding(item);
        routine.occurrences.push({
          id, dueAt,
          status: alreadyOutstanding ? 'missed' : 'outstanding',
          steps: item.steps.map(({ id: stepId, title }) => ({ id: stepId, title })),
          ...(alreadyOutstanding ? {} : { reminderAt: dueAt }),
        });
        recordedDays.add(day);
      }
      routine.nextDueAt = nextCalendarDue(dueAt, routine.time, zone);
    }
    for (const occurrence of routine.occurrences) {
      if (occurrence.snoozedUntil && timestamp(occurrence.snoozedUntil) <= target) {
        delete occurrence.snoozedUntil;
      }
    }
  }
  return next;
}
