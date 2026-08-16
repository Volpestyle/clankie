export type InputPlacement = "top" | "bottom";
export type StatusPlacement = "above-input" | "below-input";
export type LayoutSettings = {
  readonly inputPlacement: InputPlacement;
  readonly statusPlacement: StatusPlacement;
};

export const CLANKIE_TUI_INPUT_PLACEMENT_ENV = "CLANKIE_TUI_INPUT_PLACEMENT";
export const CLANKIE_TUI_STATUS_PLACEMENT_ENV = "CLANKIE_TUI_STATUS_PLACEMENT";

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
