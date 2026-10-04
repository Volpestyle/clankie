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

/** Owner-local clock, start inclusive and end exclusive, including overnight ranges. */
export function desktopIsQuiet(settings: DesktopSettings, now: Date): boolean {
  const hours = settings.quietHours;
  if (hours === undefined) return false;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: hours.timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const current = `${parts.find((part) => part.type === "hour")!.value}:${parts.find((part) => part.type === "minute")!.value}`;
  return hours.start < hours.end
    ? current >= hours.start && current < hours.end
    : current >= hours.start || current < hours.end;
}
