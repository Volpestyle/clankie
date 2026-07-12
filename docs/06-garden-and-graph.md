# Garden, graph, and terminal UX

## Spatial model

- world: organization/workspace;
- biome: stable project or repository;
- mission plot: active initiative or issue cluster;
- station: workflow phase;
- clankie/computer: worker run;
- object: task or artifact;
- path: dependency, delegation, conflict, or information flow.

Biomes remain stable to preserve spatial memory. Temporary execution state moves characters among stations.

## Stations

| Garden location | Operational phase         |
| --------------- | ------------------------- |
| Observatory     | planning/orchestration    |
| Seed Library    | context/tracker/docs      |
| Design Pond     | approved-design authority |
| Build Grove     | implementation/debugging  |
| Test Greenhouse | tests/evals/CI            |
| Review Pavilion | review/critique           |
| Merge Gate      | approval/integration      |
| Release Harbor  | deployment                |
| Recovery Shed   | failure/conflict recovery |
| Commons         | idle/available            |
| Archive Tree    | completed history/memory  |

The exact system state remains visible in the inspector; metaphor never replaces technical truth.

The Design Pond is the station for whichever source is bound to the `approved_design` authority role. That may be a design connector, repository assets, or the operator; the garden does not assume a particular vendor.

## Visual channels

- accent color + glyph: harness/provider;
- accessory: role;
- animation: execution state;
- pulse/outline: attention severity;
- ground ring: risk/approval/control;
- location: phase;
- path: relationship;
- attached sprouts: collapsed subagents.

Never rely on color alone. Make all actions accessible outside the canvas.

## Typed verbs

```text
Assign  Split  Pair  Race  Review  Compare  Steer
Pause   Resume Take over Hand back Retry Replace
Approve Reject Merge Deploy Cancel Archive
```

Every gesture compiles to a typed command and receives a policy decision. Dragging a PR to Merge Gate is a request, not authority.

## Efficiency requirements

The garden must outperform terminals at fleet operations through:

- lasso/multi-select and command groups;
- attention queue for blockers/approvals/budgets/conflicts;
- batch steering and pause/resume;
- dependency-aware drag/drop assignment;
- side-by-side artifact comparison;
- one action to focus the matching graph node and terminal;
- no artificial travel time, stamina, or resource grinding.

## Graph layers

- task dependency;
- delegation/parent-child;
- artifact lineage;
- write-scope/conflict;
- communication.

Use deterministic layouts by default. At distant zoom show semantic activity; at close zoom allow terminal tails.

## Progression

Reward verified accepted outcomes, low rework, useful escalation, doctrine adherence, and cost efficiency. Never reward tokens, elapsed busyness, raw lines, or number of agents. Progression affects cosmetics and routing recommendations—not security permission.
