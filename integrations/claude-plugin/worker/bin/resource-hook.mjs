// Bash hook metadata is per invocation: native children share the parent's OS
// process and environment. Never write a shared env file or grant permissions.
let source = "";
for await (const chunk of process.stdin) {
  source += chunk;
  if (Buffer.byteLength(source) > 256 * 1024) process.exit(0);
}
let hook;
try {
  hook = JSON.parse(source);
} catch {
  process.exit(0);
}
if (
  hook.hook_event_name !== "PreToolUse" ||
  hook.tool_name !== "Bash" ||
  typeof hook.tool_input?.command !== "string" ||
  typeof hook.session_id !== "string" ||
  !hook.session_id ||
  (hook.agent_id !== undefined && (typeof hook.agent_id !== "string" || !hook.agent_id))
)
  process.exit(0);
const holder = `claude:${hook.session_id}${hook.agent_id ? `:agent:${hook.agent_id}` : ""}`;
if (holder.length > 256 || /\p{Cc}/u.test(holder)) process.exit(2);
const quoted = "'" + holder.replaceAll("'", "'\"'\"'") + "'";
process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      updatedInput: {
        ...hook.tool_input,
        // A subshell prevents a persistent Bash session from exporting one
        // child's identity into sibling calls. Ignore an ancestor Codex thread.
        command: `(unset CODEX_THREAD_ID\nexport CLANKIE_RESOURCE_HOLDER=${quoted}\n${hook.tool_input.command}\n)`,
      },
    },
  }) + "\n",
);
