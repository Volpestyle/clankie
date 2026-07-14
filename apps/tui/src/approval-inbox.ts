import type { ClankieApiClient } from "@clankie/api-client";
import type { ClankieFaceShell } from "./shell/shell.ts";
import type { SetupFlow } from "./shell/setup-flow.ts";

export type ApprovalInboxClient = Pick<ClankieApiClient, "decideApproval" | "getMission" | "listApprovals">;

type Approval = Awaited<ReturnType<ApprovalInboxClient["listApprovals"]>>[number];
type ApprovalInboxShell = Pick<ClankieFaceShell, "insertCommandResult"> & { readonly setupFlow: SetupFlow };

export async function runApprovalInbox(
  shell: ApprovalInboxShell,
  client: ApprovalInboxClient | undefined,
): Promise<void> {
  if (!client) {
    shell.insertCommandResult(
      "/approvals",
      "Approval access is unavailable. Start the control plane once to bootstrap the local operator credential.",
      "error",
    );
    return;
  }
  const flow = shell.setupFlow;
  flow.begin("approval inbox");
  let approvals: Awaited<ReturnType<ApprovalInboxClient["listApprovals"]>>;
  try {
    flow.setStatus("loading pending approvals");
    approvals = await client.listApprovals("pending");
  } catch (error) {
    flow.end();
    shell.insertCommandResult("/approvals", safeError(error), "error");
    return;
  }
  if (approvals.length === 0) {
    flow.end();
    shell.insertCommandResult("/approvals", "No approvals pending.", "success");
    return;
  }
  const picked = await flow.readSelect({
    kind: "single",
    message: `Pending approvals (${approvals.length.toString()})`,
    options: approvals.map((approval) => ({
      value: approval.id,
      label: sanitize(approval.action),
      description: sanitize(`${resourceLabel(approval)} · ${approval.rationale.reason}`),
    })),
    required: true,
  });
  const approval = approvals.find((candidate) => candidate.id === picked?.[0]);
  if (!approval) {
    flow.end();
    shell.insertCommandResult("/approvals", "Approval review cancelled.", "error");
    return;
  }

  let mission: Record<string, unknown> | undefined;
  try {
    flow.setStatus("loading plan and evidence");
    mission = await client.getMission(approval.missionId);
  } catch (error) {
    flow.renderLine(`Mission evidence unavailable: ${safeError(error)}`, "warning");
  }
  const evidence = formatApprovalEvidence(approval, mission);

  for (;;) {
    const selection = await flow.readSelect({
      kind: "single",
      message: sanitize(approval.action),
      options: [
        {
          value: "evidence",
          label: "Inspect evidence",
          description: evidence[0] ?? "No evidence is available.",
        },
        {
          value: "approve",
          label: "Approve",
          description: sanitize(approval.rationale.reason),
        },
        {
          value: "deny",
          label: "Deny",
          description: "Terminal; returns the reason to the policy path.",
        },
      ],
      required: true,
    });
    if (selection?.[0] === "evidence") {
      flow.end();
      shell.insertCommandResult("/approvals evidence", evidence.join("\n"), "success");
      flow.begin("approval inbox");
      continue;
    }
    if (selection?.[0] !== "approve" && selection?.[0] !== "deny") {
      flow.end();
      shell.insertCommandResult("/approvals", "Approval review cancelled.", "error");
      return;
    }
    const decision = selection[0];
    const reason = await flow.readText({
      message: decision === "approve" ? "Approval reason (recorded in audit log)" : "Denial reason",
      placeholder:
        decision === "approve"
          ? "why the reviewed evidence permits this action"
          : "why this action must not proceed",
      validate: (value) => (value.trim().length === 0 ? "A reason is required." : undefined),
    });
    if (reason === undefined) {
      flow.end();
      shell.insertCommandResult("/approvals", "Approval review cancelled.", "error");
      return;
    }
    try {
      flow.setStatus("recording authenticated decision");
      const decided = await client.decideApproval(approval.id, {
        decision,
        reason: reason.trim(),
      });
      flow.end();
      shell.insertCommandResult(
        "/approvals",
        [
          `${decided.status === "approved" ? "Approved" : "Denied"}: ${sanitize(decided.action)}`,
          `Operator: ${sanitize(decided.decidedBy ?? "authenticated operator")}`,
          `Reason: ${sanitize(decided.reason ?? reason.trim())}`,
          "The decision is recorded for policy re-evaluation; no action executed from the console.",
        ].join("\n"),
        "success",
      );
    } catch (error) {
      flow.end();
      shell.insertCommandResult("/approvals", safeError(error), "error");
    }
    return;
  }
}

export function formatApprovalEvidence(
  approval: Approval,
  mission: Record<string, unknown> | undefined,
): string[] {
  const lines = [
    `Action: ${approval.action}`,
    `Resource: ${resourceLabel(approval)}`,
    `Policy effect: ${approval.rationale.effect}`,
    `Policy rationale: ${approval.rationale.reason}`,
    `Matched rules: ${approval.rationale.matchedPolicyIds.join(", ") || "none"}`,
    `Mission: ${approval.missionId}`,
    ...(approval.taskId ? [`Task: ${approval.taskId}`] : []),
  ];
  if (!mission) return [...lines, "Mission evidence: unavailable"].map(sanitize);
  const snapshot = record(mission.snapshot) ?? mission;
  const planReview = record(snapshot.planReview);
  const validation = record(planReview?.validation);
  pushString(lines, "Plan rationale", planReview?.rationale);
  pushStrings(lines, "Assumptions", planReview?.assumptions);
  pushStrings(lines, "Risks", planReview?.risks);
  pushStrings(lines, "Human decisions", planReview?.humanDecisionsRequired);
  if (typeof validation?.valid === "boolean") {
    lines.push(`Plan validation: ${validation.valid ? "valid" : "invalid"}`);
  }
  const tasks = array(snapshot.tasks);
  for (const value of tasks) {
    const task = record(value);
    if (!task) continue;
    const spec = record(task.spec);
    const taskId = string(spec?.id) ?? string(task.id) ?? "task";
    const title = string(spec?.title) ?? string(task.title) ?? taskId;
    const state = string(task.state) ?? "unknown";
    lines.push(`Task ${taskId}: ${title} · ${state}`);
    const result = record(task.result);
    for (const evidenceValue of array(result?.evidence)) {
      const item = record(evidenceValue);
      if (!item) continue;
      const label = string(item.label) ?? string(item.kind) ?? "evidence";
      const summary = string(item.summary);
      const uri = string(item.uri);
      lines.push(`  Evidence: ${label}${summary ? ` — ${summary}` : ""}${uri ? ` (${uri})` : ""}`);
    }
  }
  return lines.map(sanitize);
}

function resourceLabel(approval: Approval): string {
  const details = [approval.resource.repository, approval.resource.environment].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  return sanitize(
    `${approval.resource.type}:${approval.resource.id}${details.length ? ` · ${details.join(" · ")}` : ""}`,
  );
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? sanitize(value) : undefined;
}

function pushString(lines: string[], label: string, value: unknown): void {
  const parsed = string(value);
  if (parsed) lines.push(`${label}: ${parsed}`);
}

function pushStrings(lines: string[], label: string, value: unknown): void {
  const values = array(value)
    .map(string)
    .filter((item): item is string => item !== undefined);
  if (values.length > 0) lines.push(`${label}: ${values.join(" · ")}`);
}

function sanitize(value: string): string {
  return Array.from(value.replace(/\r\n?/gu, " "), (character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || (code >= 127 && code <= 159) ? "" : character;
  }).join("");
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return sanitize(message.replace(/Bearer\s+\S+/giu, "Bearer [redacted]"));
}
