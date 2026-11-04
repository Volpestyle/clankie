import { z } from "zod";

const clock = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u, "Use HH:mm");
export const DesktopSettingsSchema = z
  .object({
    quietHours: z
      .object({
        start: clock,
        end: clock,
        timeZone: z
          .string()
          .min(1)
          .max(100)
          .refine((value) => {
            try {
              new Intl.DateTimeFormat("en", { timeZone: value });
              return true;
            } catch {
              return false;
            }
          }, "Use an IANA time zone"),
      })
      .strict()
      .refine((hours) => hours.start !== hours.end, "Quiet hours need different start and end times")
      .optional(),
  })
  .strict();
export type DesktopSettings = z.infer<typeof DesktopSettingsSchema>;

const MINUTE_MS = 60_000;
const DAY_MINUTES = 1_440;
/** A clock change moves an end by an hour at most; walking this far past it always crosses it. */
const CLOCK_SHIFT_MINUTES = 120;

function localClock(timeZone: string): (at: Date) => string {
  const format = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  return (at) => {
    const parts = format.formatToParts(at);
    return `${parts.find((part) => part.type === "hour")!.value}:${parts.find((part) => part.type === "minute")!.value}`;
  };
}

function withinQuietHours(hours: { readonly start: string; readonly end: string }, current: string): boolean {
  return hours.start < hours.end
    ? current >= hours.start && current < hours.end
    : current >= hours.start || current < hours.end;
}

/** Owner-local clock, start inclusive and end exclusive, including overnight ranges. */
export function desktopIsQuiet(settings: DesktopSettings, now: Date): boolean {
  const hours = settings.quietHours;
  return hours !== undefined && withinQuietHours(hours, localClock(hours.timeZone)(now));
}

/**
 * The instant quiet hours end, or undefined when they are not in effect. The
 * end is found on the owner's clock rather than added up, so a daylight-saving
 * change inside the range, or an end the clock skips, still lands correctly.
 */
export function desktopQuietUntil(settings: DesktopSettings, now: Date): Date | undefined {
  const hours = settings.quietHours;
  if (hours === undefined) return undefined;
  const clock = localClock(hours.timeZone);
  const current = clock(now);
  if (!withinQuietHours(hours, current)) return undefined;
  const minutes = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
  const remaining = (minutes(hours.end) - minutes(current) + DAY_MINUTES) % DAY_MINUTES;
  const nextMinute = Math.floor(now.getTime() / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  const walkFrom = nextMinute + Math.max(0, remaining - 1 - CLOCK_SHIFT_MINUTES) * MINUTE_MS;
  for (let step = 0; step <= CLOCK_SHIFT_MINUTES * 2; step += 1) {
    const at = new Date(walkFrom + step * MINUTE_MS);
    if (!withinQuietHours(hours, clock(at))) return at;
  }
  return undefined;
}
