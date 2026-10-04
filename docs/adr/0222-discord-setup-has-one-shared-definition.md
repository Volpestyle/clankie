# ADR 0222: Discord setup has one shared definition

Status: accepted foundation for VUH-1622, VUH-1624 and VUH-1625 (2026-10-04).

The public protocol owns the four Discord sentence parts, picker kinds, help
text, check kinds, choice labels and Advanced field groups. The app, console
and hosted dashboard consume this definition rather than authoring variants.
Optional bindings also define picker server scopes, room kinds, enablement and
the independent computer-access fields. `@clankie/api-client` supplies a shared
sentence projection and revision-fenced writer; the TUI and CLI use it directly
(VUH-1628), and the app adapts its paired transport to it (VUH-1627). Its
`pickerText` method supplies inline blank labels from the same projection. The
app consumes the host’s Advanced groups and check labels; it keeps no setting
inventory or sentence-to-field mapping of its own. All blanks in one sentence save atomically. Directory member entries
are scoped by server before deduplication, since one person can occur in more
than one guild. Additive binding metadata is covered by an old-shape-client
integration regression against the new loopback host.
The optional `setup` member on settings snapshots exposes it through the API;
`clankie discord definition` reads the same snapshot. The host supplies its
machine name; a hosted body says “his cloud computer”. A screen never substitutes
its own device for the computer Clankie can use.

Only the computer-access sentence offers machine grants. Server/room presets
must not change `systemActorUserIds`, `systemActorGuildIds` or
`systemActorChannelIds`. This foundation supplies display/check definitions;
rendering belongs to the shared client projection. Active permission/test-post
checks are deferred to VUH-1642; surfaces show evidence-backed directory checks
and label the rest “not checked”. A real test post needs explicit owner action.
Existing settings writes keep strict input validation, authenticated operator
authority and the revision fence. Additive response metadata is optional and
read through the tolerant response parser (ADR 0016); an integration regression
uses an old settings-response schema against the new host and checks stale
writes and unknown grant fields are still refused (ADR 0221).

Managed-server wording replaces the retired name. `DISCORD_MANAGED_GUILD_ID`
is preferred; the old environment spelling remains a read alias. The stored
and wire key `swarmGuildId` is retained so existing clients can still read and
write it. Environment overrides continue to win over stored values.

The team server stays in `discord.swarmGuildId`. Independent optional
`discord.teamVisible` gates its display; omission means visible. Its server
picker and visibility picker are separate. Old-client writes that omit this
new field preserve the existing gate. Hiding/showing changes the gate, keeps
the selected server and is implemented by VUH-1626 without deleting webhooks.

Directory pickers read the currently connected account's observed gateway cache
through the API and CLI. The existing active body's loopback server uses its
own brokered bridge bearer; this read does not start a runtime or obtain an
account credential. The API/relay retain Observe authorization and recheck it
after awaited work. Active-body changes reject the pending result. Names, IDs
and kinds are projected only when the account's view permits them. Missing
permission evidence fails closed. Partial member/thread coverage and runtime
absence are explicit states, with bounded ID-based pages. Integration tests
exercise native discord.js caches, a real loopback user gateway, body HTTP,
API/client/CLI and paired relay, including old-client/new-host settings reads.
