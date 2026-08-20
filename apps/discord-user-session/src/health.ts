import { VOX_IPC_PROTOCOL_VERSION, type VoxStreamClient } from "@clankie/vox-client";

export type UserSessionGatewayStatus = "connecting" | "ready" | "reconnecting" | "failed" | "closed";

export function userSessionHealth(input: {
  readonly gatewayStatus: UserSessionGatewayStatus;
  readonly presenceReady: boolean;
  readonly vox: Pick<VoxStreamClient, "status" | "detail">;
  readonly voxProtocolVersion?: number;
  readonly terminalFailure?: string;
}): {
  readonly ok: boolean;
  readonly service: "discord-user-session";
  readonly gateway: { readonly status: UserSessionGatewayStatus };
  readonly presence: { readonly ready: boolean };
  readonly vox: {
    readonly status: VoxStreamClient["status"];
    readonly detail: string;
    readonly protocolVersion?: number;
  };
  readonly terminalFailure?: string;
} {
  const ok =
    input.terminalFailure === undefined &&
    input.presenceReady &&
    input.gatewayStatus === "ready" &&
    input.vox.status === "ready" &&
    input.voxProtocolVersion === VOX_IPC_PROTOCOL_VERSION;
  return {
    ok,
    service: "discord-user-session",
    gateway: { status: input.gatewayStatus },
    presence: { ready: input.presenceReady },
    vox: {
      status: input.vox.status,
      detail: input.vox.detail,
      ...(input.voxProtocolVersion === undefined ? {} : { protocolVersion: input.voxProtocolVersion }),
    },
    ...(input.terminalFailure === undefined ? {} : { terminalFailure: input.terminalFailure }),
  };
}
