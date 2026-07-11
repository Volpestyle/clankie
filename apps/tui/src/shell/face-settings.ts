import { normalizeAgentSpinnerCycleDwellMs } from "../face/agent-spinners.ts";

export type InputPlacement = "top" | "bottom";
export type StatusPlacement = "above-input" | "below-input";
export type LayoutSettings = {
  readonly inputPlacement: InputPlacement;
  readonly statusPlacement: StatusPlacement;
};

export const CLANKIE_TUI_INPUT_PLACEMENT_ENV = "CLANKIE_TUI_INPUT_PLACEMENT";
export const CLANKIE_TUI_STATUS_PLACEMENT_ENV = "CLANKIE_TUI_STATUS_PLACEMENT";
export const CLANKIE_TUI_SPINNER_ENV = "CLANKIE_TUI_SPINNER";
export const CLANKIE_TUI_SPINNER_RATE_MS_ENV = "CLANKIE_TUI_SPINNER_RATE_MS";

export function parseAgentSpinnerCycleRateMs(
  value: string | undefined,
  defaultDwellMs: number,
): number | undefined {
  const raw = value?.trim().toLowerCase();
  if (raw === undefined || raw.length === 0) return undefined;
  if (raw === "fast") return 400;
  if (raw === "normal" || raw === "default") return defaultDwellMs;
  if (raw === "slow") return 1_200;
  const milliseconds = raw.endsWith("ms") ? Number.parseInt(raw.slice(0, -2), 10) : undefined;
  if (milliseconds !== undefined && Number.isInteger(milliseconds) && `${milliseconds}ms` === raw)
    return validAgentSpinnerCycleRateMs(milliseconds);
  if (raw.endsWith("s")) {
    const seconds = Number.parseFloat(raw.slice(0, -1));
    if (Number.isFinite(seconds) && seconds > 0 && `${seconds}s` === raw)
      return validAgentSpinnerCycleRateMs(Math.round(seconds * 1_000));
  }
  const parsed = Number.parseInt(raw, 10);
  if (Number.isInteger(parsed) && String(parsed) === raw) return validAgentSpinnerCycleRateMs(parsed);
  return undefined;
}

export function validAgentSpinnerCycleRateMs(value: number): number | undefined {
  const normalized = normalizeAgentSpinnerCycleDwellMs(value);
  return normalized === value ? normalized : undefined;
}

export function parseInputPlacement(value: string | undefined): InputPlacement | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "top" || normalized === "above") return "top";
  if (normalized === "bottom" || normalized === "below") return "bottom";
  return undefined;
}

export function parseStatusPlacement(value: string | undefined): StatusPlacement | undefined {
  const normalized = value?.trim().toLowerCase().replace(/_/gu, "-");
  if (normalized === "above" || normalized === "above-input" || normalized === "top") return "above-input";
  if (normalized === "below" || normalized === "below-input" || normalized === "bottom") return "below-input";
  return undefined;
}

export function layoutSettingsFromEnv(env: NodeJS.ProcessEnv): LayoutSettings {
  return {
    inputPlacement: parseInputPlacement(env[CLANKIE_TUI_INPUT_PLACEMENT_ENV]) ?? "bottom",
    statusPlacement: parseStatusPlacement(env[CLANKIE_TUI_STATUS_PLACEMENT_ENV]) ?? "above-input",
  };
}
