import React from "react";
import { requireNativeComponent, type ViewProps } from "react-native";

interface NativeTerminalProps extends ViewProps {
  terminalId: string;
  mode: "observe" | "control";
}

const NativeTerminal = requireNativeComponent<NativeTerminalProps>("SaplingTerminalSurface");

export function TerminalSurface(props: NativeTerminalProps) {
  return <NativeTerminal {...props} />;
}
