# Security policy

Do not report vulnerabilities in public issues. Use the private disclosure channel configured by the project owner before launch.

High-priority areas:

- runner command execution and sandbox escape;
- terminal control-lease bypass;
- relay authentication or cross-workspace routing;
- credential leakage into workers, logs, events, analytics, or support bundles;
- policy bypass through direct provider tools or shell commands;
- prompt injection from repositories, terminals, Discord, trackers, Figma, or skill packages;
- cross-channel/private-memory disclosure;
- malicious ANSI/control-sequence handling;
- tampering with event logs, tests, evaluations, or doctrine hashes.

Preserve evidence, revoke affected credentials, stop the runner, and follow `docs/10-security-threat-model.md` for containment.
