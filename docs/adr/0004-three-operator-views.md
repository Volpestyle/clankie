# ADR 0004: Garden, graph, and terminal are synchronized projections

Status: accepted.

No view owns separate operational state. Garden optimizes fleet control, graph optimizes diagnosis, and terminal optimizes low-level intervention. Selecting an entity in one view selects the same worker/task/artifact everywhere.
