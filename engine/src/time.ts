/** Time-zone aware formatting that falls back to the device clock if this Node build lacks full time-zone data. */
export function fmtParts(d: Date, timeZone: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormatPart[] {
  try {
    return new Intl.DateTimeFormat("en-GB", { ...opts, timeZone }).formatToParts(d);
  } catch {
    return new Intl.DateTimeFormat("en-GB", opts).formatToParts(d);
  }
}

export function fmtLong(d: Date, timeZone: string): string {
  try {
    return d.toLocaleString("en-AU", { timeZone, dateStyle: "full", timeStyle: "short" });
  } catch {
    return d.toString();
  }
}
