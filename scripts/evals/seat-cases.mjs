/**
 * Seat cases (VUH-1473): work that needs Clankie's presence and integrations,
 * run in three arms on the same machine. Every arm has the same fake herdr
 * fleet on PATH, because a machine has herdr with or without Clankie; only the
 * seat arm has the throwaway service and the real plugin. Graders read what
 * actually happened (the fake Discord body, the fake fleet, the tracker files,
 * the service's reply record) as well as the answer, and are tested against a
 * passing and a failing observation (eval-runner.test.ts).
 */

/** The fleet every arm can see: one worker is blocked on the owner. */
export const FLEET = [
  {
    pane_id: "w1:p2",
    terminal_id: "term_a2",
    name: "docs-worker",
    agent: "codex",
    agent_status: "working",
    title: "VUH-1500 update the relay docs",
  },
  {
    pane_id: "w1:p3",
    terminal_id: "term_a3",
    name: "relay-worker",
    agent: "claude",
    agent_status: "blocked",
    title: "VUH-1501 move the relay to the new host",
  },
  {
    pane_id: "w1:p4",
    terminal_id: "term_a4",
    name: "test-worker",
    agent: "codex",
    agent_status: "done",
    title: "VUH-1502 add relay tests",
  },
];

/** Memories seeded through the service's own episode endpoint. */
export const EPISODES = [
  {
    episodeId: "ep-relay-port",
    lane: "operator",
    targetId: "global-default",
    // A value that appears nowhere in the repository, so only memory can supply it.
    summary:
      "James and I decided the relay moves to port 47113 next week; the old port stays as a one-release fallback.",
    occurredAt: "2026-09-23T15:00:00.000Z",
    retained: true,
  },
  {
    episodeId: "ep-sprites",
    lane: "operator",
    targetId: "global-default",
    summary: "James asked me to keep the garden sprites at 32 pixels for now.",
    occurredAt: "2026-09-25T18:30:00.000Z",
    retained: false,
  },
];

/** Rooms he has heard from, as lane-log entries (minutes ago, speaker line). */
export const ROOMS = [
  {
    lane: "discord_presence",
    targetId: "guild1:garden",
    entries: [
      [95, "heard", "Bea: morning all"],
      [70, "heard", "Ari: can someone review PR #88 before Friday?"],
      [65, "said", "I can look at it this afternoon."],
    ],
  },
  {
    lane: "discord_voice",
    targetId: "guild1:voice-lounge",
    entries: [
      [12, "heard", "James: the demo moves to Thursday"],
      [10, "heard", "Bea: I'll bring the new sprites"],
      [8, "heard", "James: and we skip the retro this week"],
    ],
  },
];

/** Every arm gets this in place of the eval runner's offline boundary. */
export const SEAT_BOUNDARY =
  "This is an evaluation. The worktree is your project. Any Clankie service, Discord room, voice call, " +
  "tracker or worker fleet you can reach here is a throwaway stand-in: use it exactly as you normally " +
  "would. Nothing else is in scope. Do not commit.";

const ANSWER = "Write answer.json as {answer: string}.";
const text = (value) => (typeof value === "string" ? value : "");
const said = (obs) => `${text(obs.answer?.answer)}\n${text(obs.result)}`;
// "I couldn't verify whether VUH-1501 is still blocked" names the worker and the
// word, but asserts nothing: a hedge is not a report. The claim is the first
// sentence; a caveat after a real report does not undo it.
const hedged =
  /couldn[’']?t|could not|cannot|can[’']?t|unable|not (?:able|verif)|unknown|no (?:local )?record/i;
const blockedOn1501 = (value) => {
  const claim = value.trim().split(/(?<=[.!?])\s/u)[0] ?? "";
  return /1501|relay-worker/i.test(claim) && /block|stuck|wait/i.test(claim) && !hedged.test(claim);
};

export const seatCases = [
  {
    id: "seat-recall-decision",
    coverage: "recall a decision from last week's memory",
    prompt: `What did we decide last week about the relay port? ${ANSWER}`,
    rubric: ["Names the decided port, 47113, from his own memory"],
    grade: (obs) => /47113/.test(text(obs.answer?.answer)),
  },
  {
    id: "seat-observe-room",
    prompt: `What did Ari ask for in the garden room this morning? ${ANSWER}`,
    rubric: ["Reports Ari's request: a review of PR #88 before Friday"],
    grade: (obs) => /88/.test(text(obs.answer?.answer)) && /friday/i.test(text(obs.answer?.answer)),
  },
  {
    id: "seat-stuck-worker",
    coverage: "report which hired worker is stuck",
    prompt: `Which of my workers is stuck waiting on me, and on what task? ${ANSWER}`,
    rubric: ["Names the blocked worker's task, VUH-1501, as the one waiting"],
    grade: (obs) => blockedOn1501(text(obs.answer?.answer)),
  },
  {
    id: "seat-hire-brief",
    prompt:
      "Hire a Claude worker in this worktree to add a CHANGELOG entry for VUH-1503. Its brief must include the line `Owner: VUH-1503`.",
    rubric: ["Starts a Claude worker in the fleet", "Delivers a brief that carries Owner: VUH-1503"],
    grade: (obs) =>
      obs.herdr.some((a) => a[0] === "agent" && a[1] === "start" && a.includes("claude")) &&
      obs.herdr.some((a) => a[0] === "agent" && a[1] === "prompt" && text(a[3]).includes("Owner: VUH-1503")),
  },
  {
    id: "seat-work-item",
    prompt:
      "File a work item in this repository's tracker titled 'Rotate the relay key' with the acceptance criterion 'The old key is rejected'.",
    rubric: ["Creates the item in the repository's own tracker with that title and criterion"],
    grade: (obs) =>
      Object.values(obs.workItems).some(
        (body) => body.includes("Rotate the relay key") && body.includes("The old key is rejected"),
      ),
  },
  {
    id: "seat-escalation",
    coverage: "act on a room escalation",
    trigger: {
      kind: "escalation",
      text: "Ari is asking in the garden room whether the relay migration (VUH-1501) is finished. Tell me what to say to her.",
    },
    rubric: [
      "Answers the escalation through the reply door, so it reaches the waiting run",
      "Says truthfully that VUH-1501 is blocked, not finished",
    ],
    grade: (obs) => obs.replies.some((r) => r.ok && blockedOn1501(r.text)),
  },
  {
    id: "seat-wake",
    trigger: {
      kind: "wake",
      reason: "Check on the relay worker (VUH-1501). If it is still blocked, tell James in one line.",
    },
    rubric: ["Checks the fleet when the wake fires", "Tells James that VUH-1501 is still blocked"],
    grade: (obs) => blockedOn1501(said(obs)),
  },
  {
    id: "seat-voice-summary",
    coverage: "join voice and summarize",
    prompt: `Join the voice call I'm in and tell me what's been said there so far. ${ANSWER}`,
    rubric: ["Joins the call through his voice body", "Summarizes at least two of the three things said"],
    grade: (obs) =>
      obs.discord.some((c) => c.path === "/voice/join") &&
      [/thursday/i, /sprite/i, /retro/i].filter((r) => r.test(text(obs.answer?.answer))).length >= 2,
  },
  {
    id: "seat-post-room",
    coverage: "post to a Discord room",
    prompt: "Post 'Standup moves to 3pm today' in the garden room.",
    rubric: ["The message reaches the garden room through his Discord body"],
    grade: (obs) => obs.discord.some((c) => c.method === "POST" && JSON.stringify(c.body).includes("3pm")),
  },
  {
    id: "seat-where-things-live",
    prompt: `Where do durable facts about people come from for you, and what do you use to search memories older than what you currently see? ${ANSWER}`,
    rubric: ["Names the person-memory command", "Names recall_episodes"],
    grade: (obs) =>
      /person-memory/.test(text(obs.answer?.answer)) && /recall_episodes/.test(text(obs.answer?.answer)),
  },
  {
    id: "seat-baseline",
    prompt: "Reply with the single word OK.",
    rubric: ["Measures startup context: any arm passes"],
    grade: (obs) => /\bOK\b/.test(text(obs.result)),
  },
];

export const coverageCases = seatCases.filter((c) => c.coverage).map((c) => c.id);

/** A channel event as Claude Code renders it, for arms whose bridge cannot push it. */
export function channelText(event) {
  return `<channel source="clankie" kind="${event.kind}" conversation="${event.conversationId}" source="${event.source}" event_id="${event.id}" created_at="${event.createdAt}">\n${event.content}\n</channel>`;
}

/** The service's own wake wording (captain self-wake), for arms without a service. */
export function wakeContent(reason) {
  return `This is a self-wake you scheduled, not a new instruction from the owner.\n\nReason you recorded: ${reason}\n\nReview the conversation and decide what is useful now. You may act, report, schedule another wake, or do nothing. Waking grants no additional authority or permissions.`;
}
