# SECURITY.md

Vulnerability disclosure policy: report privately
through the owner's channel, never in public
issues. Lists the high-priority attack surfaces
and points to docs/10-security-threat-model.md
for containment.

Priority areas include: runner command execution
and sandbox escape, terminal control-lease bypass,
relay auth / cross-workspace routing, credential
leakage into workers or logs, policy bypass via
direct provider tools or shell, prompt injection
from repos/terminals/Discord/trackers/Figma/
skills, cross-channel or private-memory
disclosure, malicious ANSI sequences, and
tampering with event logs or evaluations.

Incident steps: preserve evidence, revoke
credentials, stop the runner.
