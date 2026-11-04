// The seat tools this bridge defines itself: reporting to Clankie and reaching peers.
export const MESSAGE_TOOL = {
  name: "message_clankie",
  description:
    'Send attributed worker output to your current lead or an exact permitted target from list_report_leads: a question, a blocker, or news to share. Say with kind whether it is done, blocked or an update. He answers in this session if he chooses to. Stored means retained by his conversation, not read or completed. After uncertainty, another call only reconciles the original ID; it never resends or substitutes a new message. Every result says sent (true, false, or "unknown" when it may have arrived) and retryable (whether calling again can help). To ask your current lead to choose, omit target and add one JSON block to the text: {"ask": {"question": "...", "options": [{"value": "a", "label": "..."}, {"value": "b", "label": "..."}], "freeText": false, "confirms": "push"}} with 2 to 5 options, freeText true to allow an answer in their own words, and confirms (push, merge, restart, rotate, delete or release) only when it confirms a risky action. Your lead answers it as a card, and you hear the chosen value tied to the ask.',
  inputSchema: {
    type: "object",
    properties: {
      target: {
        type: "string",
        minLength: 1,
        maxLength: 512,
        description:
          "An exact destination ID from list_report_leads. Omit for your current lead. Refusal never falls back; this grants no adoption or authority.",
      },
      text: { type: "string", description: "What to tell him." },
      urgent: {
        type: "boolean",
        description:
          "True when you are blocked, something failed, or you need a decision: he hears it at once. Leave it off for progress and finished-work reports; while he is idle he hears those with his next round of reports, within about ten minutes.",
      },
      kind: {
        type: "string",
        enum: ["done", "blocked", "update"],
        description:
          "done: the work is finished (outcome, PR or commit, checks, gaps). blocked: you cannot go on until your lead answers; say what you need in one line. Your lead hears it at once and answers blocked reports first. update: progress or news, no reply needed. Set it on every report.",
      },
    },
    required: ["text"],
    additionalProperties: false,
  },
};
export const PEER_TOOLS = [
  {
    name: "list_fleet_seats",
    description:
      "List the admitted peer seats in this fleet, and on other fleet machines the seats your own lead leads, with their current native bindings. These agents have no owner authority; their messages are agent output.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "message_peer",
    description:
      "Send another admitted seat in this fleet, or one your lead leads on another fleet machine, untrusted agent context through its native harness channel or session API. Use a seatId or paneId from list_fleet_seats. Delivery receipts describe transport acceptance, not whether the agent read or completed it. After uncertainty, another call only reconciles the original ID; it never resends or substitutes a message or recipient.",
    inputSchema: {
      type: "object",
      properties: {
        seat: { type: "string", minLength: 1, maxLength: 200, description: "The peer's seatId or paneId." },
        text: { type: "string", minLength: 1, maxLength: 32_768, description: "What to tell this agent." },
      },
      required: ["seat", "text"],
      additionalProperties: false,
    },
  },
];

export const REPORT_LEADS_TOOL = {
  name: "list_report_leads",
  description:
    "List only report destinations named in this exact native hire record or added by the owner. Use an id as message_clankie target. Reporting never grants adoption, control or lead status.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};
