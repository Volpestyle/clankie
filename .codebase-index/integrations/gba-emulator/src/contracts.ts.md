# integrations/gba-emulator/src/contracts.ts

Zod contracts for the frozen (deterministic
double) scenario family: scenario fixture,
binding, hash-chained evidence events/trace,
driver decisions, and the scenario report.
All strictly bounded and cross-validated.

Key exports: `FrozenGbaScenarioSchema` (map,
party, trainer, target — with superRefines
that keep positions on the map and the target
within trainer reach), `GbaScenarioBindingSchema`,
`GbaEmulatorEvidenceEventSchema` /
`GbaEmulatorTraceSchema` (SHA-256 chained,
max 256 events; optional `rolledWindows` /
`droppedEvidenceEvents` only on rolling
sessions), `GbaDriverDecisionSchema` /
`GbaDecisionTraceSchema` (halt decisions carry
no action; frames monotone), and
`GbaScenarioReportSchema` whose `result` must
agree with its checks. `gbaEmulatorGoalEvent`
turns a report+binding into an
`environment.goal.verified/failed` semantic
event. Also exports `Sha256Schema` and the
schema version constant.
