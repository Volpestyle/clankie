import { SafetyApprovalsSchema, SafetyStatusSchema } from "@clankie/protocol";
import type { BrowserCommandOptions } from "./command/browser.ts";
import { runSafetyCommand } from "./command/safety.ts";
import { runSettingsMenu } from "./settings-menu.ts";
import type { FaceShellCommand } from "./shell/shell.ts";

export function buildSafetyCommands(options: BrowserCommandOptions): FaceShellCommand[] {
  return [
    {
      name: "safety",
      aliases: [],
      description: "Configure owner safety rules and review exact action approvals",
      argumentHint: "[status|preset work|approvals|approve ID FINGERPRINT]",
      takesArgument: true,
      async run(argument, shell) {
        if (argument.trim()) {
          const text = argument.trim();
          const args = text.startsWith("set ") ? ["set", text.slice(4).trim()] : text.split(/\s+/u);
          const result = await runSafetyCommand(args, options);
          shell.insertCommandResult("/safety", JSON.stringify(result, null, 2), "success");
          return;
        }
        await runSettingsMenu(shell, "/safety", async () => {
          const { safety } = SafetyStatusSchema.parse(await runSafetyCommand([], options));
          const update = async (value: Record<string, unknown>) => {
            await runSafetyCommand(["set", JSON.stringify(value)], options);
            return "Saved. Tool restrictions apply immediately; restart Clankie to refresh prompts and available tools.";
          };
          return {
            title: "Safety",
            actions: [
              {
                value: "preset",
                label: "Apply preset",
                hint: `${safety.codeExecution}, default ${safety.defaultDecision}`,
                async run(flow) {
                  const preset = await flow.readSelect({
                    message: "Safety preset",
                    options: [
                      {
                        value: "work",
                        label: "Work",
                        description: "Orchestrate workers and review external tool calls.",
                      },
                      {
                        value: "default",
                        label: "Default",
                        description: "Direct tools and the existing permission behavior.",
                      },
                    ],
                    allowBack: true,
                  });
                  if (!preset) return;
                  await runSafetyCommand(["preset", preset], options);
                  return "Saved safety preset. Restart Clankie to refresh prompts and available tools.";
                },
              },
              {
                value: "code",
                label: "Code execution",
                hint: safety.codeExecution,
                async run(flow) {
                  const codeExecution = await flow.readSelect({
                    message: "Who changes code?",
                    options: [
                      {
                        value: "delegate",
                        label: "Native workers",
                        description:
                          "Clankie reads and orchestrates; direct shell and file edits are blocked.",
                      },
                      { value: "direct", label: "Clankie and workers" },
                    ],
                    currentValue: safety.codeExecution,
                    allowBack: true,
                  });
                  if (codeExecution) return update({ codeExecution });
                },
              },
              {
                value: "default",
                label: "Default tool decision",
                hint: safety.defaultDecision,
                async run(flow) {
                  const defaultDecision = await flow.readSelect({
                    message: "Tools without a matching rule",
                    options: ["allow", "ask", "deny"].map((value) => ({ value, label: value })),
                    currentValue: safety.defaultDecision,
                    allowBack: true,
                  });
                  if (defaultDecision) return update({ defaultDecision });
                },
              },
              {
                value: "rules",
                label: "Tool rules",
                hint: `${safety.rules.length} rules`,
                async run(flow) {
                  const choice = await flow.readSelect({
                    message: "Tool rules",
                    options: [
                      { value: "add", label: "Add a rule" },
                      ...safety.rules.map((rule, index) => ({
                        value: String(index),
                        label: rule.tool,
                        hint: rule.decision,
                      })),
                    ],
                    allowBack: true,
                  });
                  if (choice === undefined) return;
                  const index = choice === "add" ? -1 : Number(choice);
                  const current = safety.rules[index];
                  const tool = await flow.readText({
                    message: "Tool name or pattern (* matches any text)",
                    defaultValue: current?.tool ?? "",
                    allowBack: true,
                    validate: (value) =>
                      value.trim().length === 0 || value.trim().length > 256
                        ? "Use 1 to 256 characters."
                        : undefined,
                  });
                  if (tool === undefined) return;
                  const decision = await flow.readSelect({
                    message: "What may Clankie do with this tool?",
                    options: [
                      { value: "allow", label: "Allow" },
                      { value: "ask", label: "Ask for approval" },
                      { value: "deny", label: "Block" },
                      ...(current ? [{ value: "remove", label: "Remove this rule" }] : []),
                    ],
                    currentValue: current?.decision ?? "ask",
                    allowBack: true,
                  });
                  if (decision === undefined) return;
                  const rules = safety.rules.filter((_, savedIndex) => savedIndex !== index);
                  if (decision !== "remove")
                    rules.push({ tool: tool.trim(), decision: decision as "allow" | "ask" | "deny" });
                  return update({ rules });
                },
              },
              {
                value: "instructions",
                label: "Standing work instructions",
                async run(flow) {
                  const instructions = await flow.readText({
                    message: "Owner work rules",
                    defaultValue: safety.instructions,
                    multiline: true,
                    allowBack: true,
                  });
                  if (instructions !== undefined) return update({ instructions });
                },
              },
              {
                value: "approvals",
                label: "Review action approvals",
                async run(flow) {
                  const { approvals } = SafetyApprovalsSchema.parse(
                    await runSafetyCommand(["approvals"], options),
                  );
                  const pending = approvals.filter((approval) => approval.status === "pending");
                  if (!pending.length) return "No pending approvals.";
                  const id = await flow.readSelect({
                    message: "Proposed actions",
                    options: pending.map((a) => ({ value: a.id, label: a.tool, description: a.scope })),
                    allowBack: true,
                  });
                  const approval = pending.find((a) => a.id === id);
                  if (!approval) return;
                  flow.renderLine(JSON.stringify(approval, null, 2));
                  const decision = await flow.readSelect({
                    message: "Approve this exact action once?",
                    options: [
                      { value: "reject", label: "Reject" },
                      { value: "approve", label: "Approve once" },
                    ],
                    allowBack: true,
                  });
                  if (!decision) return;
                  await runSafetyCommand([decision, approval.id, approval.fingerprint], options);
                  return decision === "approve"
                    ? "Approved once. Ask Clankie to continue with the reviewed action."
                    : "Rejected.";
                },
              },
            ],
          };
        });
      },
    },
  ];
}
