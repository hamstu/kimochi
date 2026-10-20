/**
 * Times and days for the Log: the short time beside each line, its full date on hover, and the
 * day dividers that appear once a session's lines span more than one day.
 */

/** The local calendar day a time falls on, as a comparable key. */
export function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** The time beside a line: 24-hour, so the column keeps one width. */
export function lineTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** The full date and time a line was read, in the reader's own locale. */
export function lineDate(ts: number, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "full", timeStyle: "short" }).format(ts);
}

/** A day divider's label: Today, Yesterday, else the date (with the year once it is not this one). */
export function dayLabel(ts: number, now = Date.now(), locale?: string): string {
  const key = dayKey(ts);
  if (key === dayKey(now)) return "Today";
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (key === dayKey(yesterday.getTime())) return "Yesterday";
  const sameYear = new Date(ts).getFullYear() === new Date(now).getFullYear();
  return new Intl.DateTimeFormat(locale, {
    weekday: "long",
    month: "long",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  }).format(ts);
}

/**
 * Which of the shown lines start a day, so a divider goes above them. None while every line in
 * the session (`all`, shown or not) falls on one day; once they span days, the first shown line
 * is labelled too, so every run of lines says which day it is.
 */
export function dayStarts(all: readonly { ts: number }[], shown: readonly { ts: number }[]): Set<number> {
  const starts = new Set<number>();
  if (all.length < 2 || dayKey(all[0].ts) === dayKey(all[all.length - 1].ts)) return starts;
  shown.forEach((line, i) => {
    if (i === 0 || dayKey(line.ts) !== dayKey(shown[i - 1].ts)) starts.add(i);
  });
  return starts;
}
