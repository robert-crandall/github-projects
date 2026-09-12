import { Temporal } from '@js-temporal/polyfill';

export function instant(value: string): string {
  try {
    return Temporal.Instant.from(value).toString();
  } catch {
    throw new Error('Use a valid timestamp with a timezone, such as 2026-09-11T10:00:00Z.');
  }
}

export function addMinutes(value: string, minutes: number): string {
  return Temporal.Instant.from(value).add({ milliseconds: minutes * 60_000 }).toString();
}

export function initialClock(timeZone: string): string {
  try {
    return Temporal.ZonedDateTime.from({
      timeZone, year: 2026, month: 9, day: 11, hour: 9, minute: 40,
    }).toInstant().toString();
  } catch {
    throw new Error(`Unknown timezone: ${timeZone}`);
  }
}
