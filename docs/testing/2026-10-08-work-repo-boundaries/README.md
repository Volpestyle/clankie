# VUH-1725 — work repository boundary docs

Fresh worktree from fetched main `7ae6b6e241acd83a3b91186a67ce881bc030f369`.
The [worker-access guide](../../worker-access.md#work-repositories) and shipped
[lead skill](../../../.agents/skills/lead/SKILL.md#work-project-boundaries)
now name native harness permissions, forge branch protection/MR approval and
pi lane grants. They distinguish working preferences from enforcement, account
context from same-user isolation, and Claude Code/Codex prompts from Pi workers
and unseated pi turns. A global work preset or a replacement policy engine was
not introduced.

The issue's documentation criterion is met. The other four criteria remain open:

- The owner must identify the work repo and desired push/release/closure overrides.
- The approved work forge account must remain outside Clankie's connected accounts;
  no credential enrollment, sign-in or account move was performed.
- Default-branch protection, bypass permissions and required MR approvals need
  verification on that forge; no remote protection setting was read or changed.
- The owner must choose pi lane grants or native-seat operator turns. Neither is
  inferred from an owner preference. VUH-1523 and VUH-1687 remain separate open
  decisions; no per-action pi enforcement or same-user isolation is claimed.

[Documentation checks](checks.txt) ran through `clankie heavy --`, exit 0.
The existing project list was read, but no task-specific work repo was named.
Global fleet settings still report commit/push/closure as lead; workspace-specific
working preferences returned `Machine setup context refused (409)`. No cause is
claimed and no runtime/machine repair or settings mutation was attempted. This
source landing follows the owner's explicit assignment and existing authority.
No employer repository details or credentials are recorded in this public evidence.
