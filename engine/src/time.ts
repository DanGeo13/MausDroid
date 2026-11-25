/**
 * Dates and times without Intl. The phone's Node.js build has no Intl
 * (time-zone database), so times use the phone's own local clock, which
 * Android sets to your time zone.
 */
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const pad = (n: number) => String(n).padStart(2, "0");

/** Local "HH:MM" (24-hour), weekday 0–6 and "YYYY-MM-DD". */
export function localParts(d: Date) {
  return { hm: `${pad(d.getHours())}:${pad(d.getMinutes())}`, wd: d.getDay(), ymd: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` };
}

/** e.g. "Tuesday 25 November 2026, 8:46 pm (UTC+11:00)". */
export function fmtLong(d: Date): string {
  const h = d.getHours();
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const tz = `UTC${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${h % 12 || 12}:${pad(d.getMinutes())} ${h < 12 ? "am" : "pm"} (${tz})`;
}

/** The phone's time zone name when this Node build can tell, otherwise its UTC offset. */
export function deviceTimeZone(): string {
  try {
    const I = (globalThis as any).Intl;
    const z = I?.DateTimeFormat?.().resolvedOptions?.().timeZone;
    if (z) return z;
  } catch {
    /* no Intl */
  }
  if (process.env.TZ) return process.env.TZ;
  const off = -new Date().getTimezoneOffset();
  return `UTC${off >= 0 ? "+" : "-"}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
}
