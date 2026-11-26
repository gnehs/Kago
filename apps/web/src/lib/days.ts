/*
 * Calendar days by the clock of the person looking, which is not the server's. Windows that sort things under "Today"
 * and "Yesterday" (the Trash, the audit log) share these, and node tests them, so this file imports nothing.
 */

const SECONDS_PER_DAY = 86400;

/** The unix second the local day of `seconds` began. */
export function startOfDay(seconds: number): number {
  const day = new Date(seconds * 1000);
  day.setHours(0, 0, 0, 0);
  return day.getTime() / 1000;
}

/** `days` calendar days after the local day of `seconds` (before it when negative), at its start. A day with a clock change in it is not 24 hours long, which is why this goes by dates. */
export function addDays(seconds: number, days: number): number {
  const day = new Date(startOfDay(seconds) * 1000);
  day.setDate(day.getDate() + days);
  return day.getTime() / 1000;
}

/** How many calendar days before the one `now` is in `seconds` falls: 0 for today, 1 for yesterday, below 0 for a time still to come. */
export const daysAgo = (seconds: number, now: number): number => Math.round((startOfDay(now) - startOfDay(seconds)) / SECONDS_PER_DAY);
