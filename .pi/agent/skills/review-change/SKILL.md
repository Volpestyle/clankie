---
description: Use when reviewing a pull request, branch, design change, integration result, or architecture proposal for correctness and operational risk.
---

# Review a change

Review in this order:

1. acceptance-criteria coverage;
2. correctness and edge cases;
3. security, privacy, credentials, and policy bypass;
4. architecture boundaries and dependency direction;
5. concurrency, idempotency, cancellation, and recovery;
6. observability and evidence quality;
7. performance/cost and maintainability;
8. tests and rollback.

Classify findings as blocking, important, or suggestion. Include file/location, consequence, reproducer, and smallest remediation. Do not approve merely because checks are green.
