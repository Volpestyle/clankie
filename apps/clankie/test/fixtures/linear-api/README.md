# Linear GraphQL provider schema fixture

Subset of the public Linear SDK SDL from [commit `2a3ac4cfd28af84b98c439efa74b1e32b2ce985b`](https://github.com/linear/linear/blob/2a3ac4cfd28af84b98c439efa74b1e32b2ce985b/packages/sdk/src/schema.graphql), downloaded 2026-10-05 and retained under the adjacent upstream MIT license. Trimmed 2026-10-09 for VUH-1897 item 1 / VUH-1925's first batch.

The localhost HTTP fixture validates actual adapter documents and variable coercion against provider-owned definitions before returning synthetic responses. No provider credentials or customer data are included. A native Vitest raw import connects the SDL to its consumers in the existing `--changed` dependency graph.

The subset retains exercised output fields, their complete argument signatures, interface requirements, and all transitively referenced input objects, scalars and enums. Input fields, nullability, defaults, enum values and field arguments are copied unchanged from the upstream AST. Unexercised output fields/types and documentation descriptions are omitted. This is a test fixture for covered operations, not a complete Linear API schema.

All five consumers and their assertions remain:

- `linear-api-tracker.test.ts`: tracker API contracts, credentials, token redaction, renewal and pagination.
- `linear-graphql.integration.test.ts`: lane authority, destructive confirmation and budget admission over localhost HTTP.
- `linear-request-budget.integration.test.ts`: provider quotas, actor accounting and reserved writes.
- `linear-request-budget-autonomous.integration.test.ts`: retained autonomous integration case, including its existing skip.
- `worker-call-receipts.integration.test.ts`: durable uncertain receipts, replay refusal and authority fencing.

For a newly covered operation, add its original provider field definitions and their dependencies from the pinned upstream schema. Keep full input definitions and validate the real adapter document; do not invent a permissive schema to make a test pass. The [batch evidence](../../../../../docs/testing/2026-10-09-linear-schema-subset/README.md) records the retained fields, upstream-signature audit, test results, line counts and measured gate costs.
