# VUH-2221: private identity registry

The 13:31Z deployment placed the VUH-2145 registry directly in an existing 0755 captain directory. The private-file writer requires a 0700 parent, so discovery and account selection failed before hires. The lead mitigated this machine with chmod; the code must handle existing installs itself.

The shared path helper owns `harness-account-identities/registry.json` in a newly created 0700 directory, leaving the captain directory mode untouched. Both cleared captain call sites use it. If the old file exists and the new file does not, migration parses and copies it once and retains the old file. Only this read permits an owned readable parent; file mode, UID, no-follow open, hard-link and size checks remain identical. New writes still require a private directory. No credentials, accounts or sign-ins are changed.

The existing native executable integration fixture now starts from a 0755 state directory and runs actual discovery, the authenticated accounts API and CLI, and hire account choice. It verifies 0700 directory / 0600 registry permissions and unchanged parent mode. A file-backed migration case proves retained aliases survive, the old file remains, and later reads do not overwrite the new registry; unsafe links, shared modes, hard links and a foreign-owned target are refused. This is a scratch-state proof, not a live hire or deployment claim.

Governed focused checks passed: 21 cases across three files, plus formatting and lint. Docs checks passed for 743 Markdown files and ten public pages. Exact integrator landing gate and deployment remain pending. VUH-2219 remains parked behind this Urgent fix.
