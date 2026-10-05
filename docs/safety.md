# Owner safety settings

Safety settings belong to the owner in `~/.config/clankie/settings.json`, alongside
persona and connection settings. Configure them through `/safety`, `clankie safety`
or the authenticated operator API. Existing installations default to their current
direct-tool behavior. Safety configuration never comes from repository files,
memory, a worker message or an ordinary preference answer.

## Work preset

```sh
clankie safety preset work
clankie restart captain
```

The work preset makes Clankie an orchestrator. He can read context, plan, hire
native harness workers and coordinate them. His direct shell, file-editing and
browser mutation tools are blocked, together with known connected code-writing
and command-execution tools. The preset allows the built-in research,
memory and coordination tools; other tools, including unknown connected-service
tools and browser navigation, require owner review. It does not infer that a
connected tool is safe from its name or its server's read-only hint.

Standing work instructions require drafts before external replies and explicit
approval before creating MRs/PRs, posting comments or messages, merging or
controlling pipelines. They prohibit pushing to `main`, `master` and protected
branches, including asking a worker to do so. These instructions are carried into
Clankie's prompts and appended to worker briefs.

Native workers retain their harness permissions, accounts and approval UI. These
settings do not introduce a worker sandbox or answer native permission prompts.
Semantic instructions, such as identifying a protected branch or a pipeline
action, remain model instructions. Use native harness permissions and repository
branch protection for enforcement on workers. Clankie's own tool restrictions
are enforced before a Pi tool call or an operator-seat MCP tool call executes.

## Tool rules

`codeExecution` is `direct` or `delegate`. `delegate` denies `bash`, `powershell`,
`edit`, `write`, `browser_browser_use_javascript` and
`browser_browser_use_evaluate`, `browser_browser_use_click` and
`browser_browser_use_fill`, even if another tool rule would allow them. It also
denies connected tools ending in `push_files`, `create_or_update_file`,
`delete_file`, `edit_file`, `write_file`, `apply_patch`, `execute_code`, `run_code`,
`execute_command`, `run_command`, `bash`, `powershell`, `shell` or `exec`.
Unknown connected tools still need owner review; the owner must inspect their
contract before allowing them. Native harnesses handle browser changes too.
Fresh delegated sessions expose only the `read` built-in. Restrictions also
apply to tools retained in an older session after a settings change.

`defaultDecision` is `allow`, `ask` or `deny`. `rules` is an array of
`{tool, decision}` records. Patterns match the full tool name; `*` matches any
sequence of characters. All matching rules combine with `deny` taking priority
over `ask`, then `allow`. `instructions` is up to 8,000 characters of owner work
rules. Fields omitted from `safety set` retain their current values; passing a
new rules array replaces the old array.

```sh
clankie safety set '{"rules":[{"tool":"linear_get_issue","decision":"allow"},{"tool":"linear_create_comment","decision":"ask"},{"tool":"github_merge_pull_request","decision":"deny"}]}'
clankie safety status
```

Use exact names from the connected tool catalog. A rule for a deferred
`mcp_tool_call` is evaluated against the requested connected tool's qualified
name and arguments. Allowing the directory tool does not allow the tools it
can call. `clankie safety preset default` restores the existing behavior.

## Reviewing actions

An `ask` decision refuses the call before effects and returns a proposed action.
Clankie should show its complete arguments and destination as a draft. Open
`/safety` and choose **Review action approvals**, or inspect the proposals:

```sh
clankie safety approvals
clankie safety approve REQUEST_ID FINGERPRINT
clankie safety reject REQUEST_ID FINGERPRINT
```

The owner reviews the exact tool, arguments and conversation scope. Approval
authorizes one matching invocation; it does not execute it or automatically
continue a turn. Ask Clankie to continue with the reviewed action. Changing the
arguments, scope or safety settings requires fresh approval. A rejected action
stays rejected until its proposal expires. A denied tool has no approval path.

Proposals and approvals expire after 15 minutes. They are bounded to 100 records,
held only in the service process, and discarded on restart. An approval is
consumed before dispatch, so a failed or uncertain execution needs another
review rather than replaying the approval. Normal tool authority and body-lease
checks still apply after approval. It grants no room or account authority.

Approval binds the tool arguments, not mutable remote state such as a browser
page, account login or a branch's latest commit. Review those targets again when
their state changes. These controls are a boundary for Clankie's model-issued
tools, not an OS sandbox: a native worker, plugin, manually run CLI command or
other process with the owner's credentials keeps its existing OS authority.

Tool restrictions apply immediately. Restart the captain to refresh the prompt
and available built-ins. No harness permission settings are rewritten.

## API

`GET /v1/operator/safety` returns `{safety}`. `POST` takes a strict partial settings
object and returns the saved settings. `GET /v1/operator/safety/approvals` returns
`{approvals}`. `POST` takes `{id, fingerprint, approve}` and resolves a pending
proposal. Requests require owner operator authentication, or an authenticated
paired device with Take Control authority. Captain and worker bearers cannot
change settings or approve actions. Ordinary question answers grant nothing.
