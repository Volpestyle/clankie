interface SeatTool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties: false;
  };
}
export const MESSAGE_TOOL: SeatTool;
export const REPORT_LEADS_TOOL: SeatTool;
export const PEER_TOOLS: SeatTool[];
