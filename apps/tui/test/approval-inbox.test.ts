import { describe, expect, it, vi } from "vitest";
import { formatApprovalEvidence, runApprovalInbox, type ApprovalInboxClient } from "../src/approval-inbox.ts";
import type { MenuOption, SetupFlow } from "../src/shell/setup-flow.ts";

type TestApproval = Awaited<ReturnType<ApprovalInboxClient["listApprovals"]>>[number];

const pending: TestApproval = {
  id: "approval-1",
  missionId: "mission-1",
  taskId: "verify",
  workerRunId: "worker-1",
  action: "github.pr.merge",
  resource: { type: "pull_request", id: "184", repository: "acme/example" },
  rationale: {
    effect: "require_approval",
    reason: "The invariant floor requires human approval.",
    matchedPolicyIds: ["invariant-floor:human-approval"],
    obligations: [],
  },
  requestedAt: "2026-07-11T21:00:00.000Z",
  status: "pending",
  correlationId: "correlation-1",
  profileHash: "profile-1",
};

class FakeFlow implements SetupFlow {
  public readonly outputs: string[] = [];
  public readonly statuses: Array<string | undefined> = [];
  private readonly selects: Array<string[] | undefined>;
  private readonly texts: Array<string | undefined>;

  public constructor(selects: Array<string[] | undefined>, texts: Array<string | undefined>) {
    this.selects = selects;
    this.texts = texts;
  }

  public begin(title: string): void {
    this.statuses.push(title);
  }
  public end(): void {
    this.statuses.push("ready");
  }
  public renderOutput(text: string): void {
    this.outputs.push(text);
  }
  public renderLine(text: string): void {
    this.outputs.push(text);
  }
  public setStatus(status: string | undefined): void {
    this.statuses.push(status);
  }
  public readText(): Promise<string | undefined> {
    return Promise.resolve(this.texts.shift());
  }
  public readSecret(): Promise<string | undefined> {
    return Promise.resolve(undefined);
  }
  public readSelect(options: { readonly options: readonly MenuOption[] }): Promise<string[] | undefined> {
    const selected = this.selects.shift();
    if (selected?.[0]) expect(options.options.some((option) => option.value === selected[0])).toBe(true);
    return Promise.resolve(selected);
  }
  public waitForInterrupt(): { readonly promise: Promise<void>; dispose(): void } {
    return { promise: Promise.resolve(), dispose() {} };
  }
}

function missionEvidence(): Record<string, unknown> {
  return {
    snapshot: {
      planReview: {
        rationale: "Merge the independently verified result.",
        assumptions: ["The branch is current."],
        risks: ["Merge conflicts."],
        humanDecisionsRequired: ["Approve merge."],
        validation: { valid: true },
      },
      tasks: [
        {
          state: "succeeded",
          spec: { id: "verify", title: "Verify" },
          result: {
            evidence: [
              {
                kind: "test_report",
                label: "pnpm test",
                summary: "All tests passed.",
                uri: "artifact://tests/report.json",
              },
            ],
          },
        },
      ],
    },
  };
}

describe("approval inbox", () => {
  it("shows policy and mission evidence before recording an authenticated approval", async () => {
    const flow = new FakeFlow([[pending.id], ["evidence"], ["approve"]], ["Diff and checks reviewed."]);
    const results: Array<{ text: string; tone: string }> = [];
    const decideApproval = vi.fn<ApprovalInboxClient["decideApproval"]>(async (_id, input) => ({
      ...pending,
      status: "approved",
      decidedAt: "2026-07-11T21:01:00.000Z",
      decidedBy: "operator-james",
      reason: input.reason,
    }));
    const client: ApprovalInboxClient = {
      listApprovals: vi.fn(async () => [pending]),
      getMission: vi.fn(async () => missionEvidence()),
      decideApproval,
    };

    await runApprovalInbox(
      {
        setupFlow: flow,
        insertCommandResult(_command, text, tone) {
          results.push({ text, tone });
        },
      },
      client,
    );

    expect(results.map((result) => result.text).join("\n")).toContain(
      "Policy rationale: The invariant floor",
    );
    expect(results.map((result) => result.text).join("\n")).toContain("Plan validation: valid");
    expect(results.map((result) => result.text).join("\n")).toContain(
      "Evidence: pnpm test — All tests passed.",
    );
    expect(decideApproval).toHaveBeenCalledWith("approval-1", {
      decision: "approve",
      reason: "Diff and checks reviewed.",
    });
    expect(results.at(-1)).toMatchObject({ tone: "success" });
    expect(results.at(-1)?.text).toContain("no action executed from the console");
  });

  it("sanitizes event-controlled evidence and never mutates state without the API", async () => {
    const lines = formatApprovalEvidence(
      {
        ...pending,
        rationale: { ...pending.rationale, reason: "safe\u001B]52;c;payload\u0007 rationale" },
      },
      undefined,
    );
    expect(lines.join("\n")).toContain("safe]52;c;payload rationale");
    // eslint-disable-next-line no-control-regex -- asserts the sanitizer stripped every control character
    expect(lines.every((line) => !/[\u0000-\u001F\u007F-\u009F]/u.test(line))).toBe(true);

    const results: string[] = [];
    await runApprovalInbox(
      {
        setupFlow: new FakeFlow([], []),
        insertCommandResult(_command, text) {
          results.push(text);
        },
      },
      undefined,
    );
    expect(results).toEqual([
      "Approval access is unavailable. Start the authenticated console with CLANKIE_OPERATOR_TOKEN.",
    ]);
  });
});
