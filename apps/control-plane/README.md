# Control plane

This service owns mission state, doctrine compilation, action decisions, approvals, and the semantic event stream. The current skeleton uses an in-memory mission registry so the lead-agent lab stays easy to inspect. The production milestone replaces it with PostgreSQL plus an append-only event table and materialized read models.

It must never own provider subscription credentials or terminal processes. Those remain on the local runner.
