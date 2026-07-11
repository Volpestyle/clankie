import React from "react";
import { UIManager, requireNativeComponent, type ViewProps } from "react-native";
import { TerminalSurface as PlaceholderSurface } from "./TerminalSurface.tsx";

interface NativeTerminalProps extends ViewProps {
  terminalId: string;
  mode: "observe" | "control";
}

// The SwiftTerm-backed native view ships with the iOS shell's native
// milestone; until the running binary registers it, fall back to the
// placeholder instead of red-boxing the Terminal tab.
const hasNativeSurface = UIManager.hasViewManagerConfig?.("SaplingTerminalSurface") ?? false;

const NativeTerminal = hasNativeSurface
  ? requireNativeComponent<NativeTerminalProps>("SaplingTerminalSurface")
  : null;

export function TerminalSurface(props: NativeTerminalProps) {
  if (!NativeTerminal) {
    return <PlaceholderSurface {...props} />;
  }
  return <NativeTerminal {...props} />;
}
