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

Visual channels are presentation-contract semantics derived from the mission event stream:

- harness/provider → accent color + glyph;
- role → accessory;
- execution state → animation;
- attention severity → pulse/outline;
- risk/approval/control → ground ring;
- phase → location;
- relationship → path;
- collapsed subagents → attached sprouts.

The selected `SkinPack` supplies the character poses, channel glyphs, accessories, rings, scene
art, anchors, animation timing, palette, and typography used to render those semantics. The
garden engine resolves semantic keys through the versioned skin contract; it does not import a
hardcoded atlas. The built-in Clankies pixel atlas is the default skin, not garden state or
authority. A skin changes presentation only and cannot change commands, policy, evidence, or
mission truth. See
[ADR 0005: Skin packs are versioned data behind an engine-owned loader](https://github.com/Volpestyle/clankie-app/blob/main/docs/adr/0005-skin-pack-contract-boundary.md).

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
