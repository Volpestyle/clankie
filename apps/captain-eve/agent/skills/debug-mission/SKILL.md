---
description: Use when the captain must diagnose and recover a blocked or failed multi-agent mission without discarding evidence, repairing code itself, or bypassing policy.
---

# Recover a mission

1. Request a pause on new side effects through the control plane and preserve worker output, terminal tail, branch, diff, environment metadata, and correlation identifiers.
2. Use `references/failure-taxonomy.md` to identify the first causal failure rather than the loudest downstream symptom.
3. Add the smallest diagnosis or repair task with a debugger role, bounded scope, success criteria, and evidence requirements. The captain does not repair code itself.
4. Prefer a different worker or harness when the failure may be agent-specific.
5. Re-run the original verifier and unchanged failing check after repair, then run the broader regression gate.
6. Record the incident and any proposed doctrine, skill, or evaluator change as separately reviewed work.
