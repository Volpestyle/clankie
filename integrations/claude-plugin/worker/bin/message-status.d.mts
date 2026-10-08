import type { FleetSeatMessageStatus } from "@clankie/protocol";
export const MESSAGE_CLANKIE_STATUS_TOOL: {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, { type: string; format: string; description: string }>;
    required: string[];
    additionalProperties: false;
  };
};
export function readMessageStatus(
  request: (suffix: string) => Promise<Response>,
  deliveryId: unknown,
): Promise<FleetSeatMessageStatus>;
