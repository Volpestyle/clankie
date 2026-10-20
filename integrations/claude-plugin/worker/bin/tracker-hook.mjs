// Loaded only by Clankie's worker/operator plugins. No owner configuration is edited.
// A local deny must survive an unavailable bridge and a hand-started, unbound pane.
let source = "";
for await (const chunk of process.stdin) {
  source += chunk;
  if (Buffer.byteLength(source) > 256 * 1024) process.exit(2);
}
let hook;
try {
  hook = JSON.parse(source);
} catch {
  process.exit(2);
}
// The operator plugin passes `lead`: that seat is the lead and reaches Linear through its own lead tools.
const guidance =
  process.argv[2] === "lead"
    ? "This is Clankie's operator seat. Write to Linear through your lead MCP server's linear_* tools as the Clankie app. Inherited Linear connectors are denied here. Plain Claude sessions without this plugin keep the owner's connector access."
    : "This is a Clankie plugin session. Post Linear evidence through clankie_tools / clankie_call as the Clankie app; if unavailable, ask your lead with message_clankie. Inherited Linear connectors are denied here. Plain Claude sessions without this plugin keep the owner's connector access.";
if (hook.hook_event_name === "SessionStart") {
  process.stdout.write(
    JSON.stringify({
      systemMessage: guidance,
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: guidance },
    }) + "\n",
  );
} else if (hook.hook_event_name === "PreToolUse" && typeof hook.tool_name === "string") {
  const server = /^mcp__(.+)__.+$/u.exec(hook.tool_name)?.[1];
  if (server && /linear/iu.test(server))
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: guidance,
        },
      }) + "\n",
    );
}
