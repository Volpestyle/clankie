# docs/adr/0068-a-playthrough-leaves-a-durable-trail.md

Decision that each playthrough writes an append-only per-run journal, bounded environment operational state, and shared body-possession transitions. These trails separate complete narrative history from the runtime's rolling working set and remain inspectable after process exit.
