# ADR 0222: Discord setup has one shared definition

Status: accepted foundation for VUH-1622, VUH-1624 and VUH-1625 (2026-10-04).

The public protocol owns the four Discord sentence parts, picker kinds, help
text, check kinds, choice labels and Advanced field groups. The app, console
and hosted dashboard consume this definition rather than authoring variants.
The optional `setup` member on settings snapshots exposes it through the API;
`clankie discord definition` reads the same snapshot. The host supplies its
machine name; a hosted body says “his cloud computer”. A screen never substitutes
its own device for the computer Clankie can use.

Only the computer-access sentence offers machine grants. Server/room presets
must not change `systemActorUserIds`, `systemActorGuildIds` or
`systemActorChannelIds`. This foundation supplies display/check definitions;
rendering sentences and performing setup checks remain their surface issues.
Existing settings writes keep strict input validation, authenticated operator
authority and the revision fence. Additive response metadata is optional and
read through the tolerant response parser (ADR 0016); an integration regression
uses an old settings-response schema against the new host and checks stale
writes and unknown grant fields are still refused (ADR 0221).

Managed-server wording replaces the retired name. `DISCORD_MANAGED_GUILD_ID`
is preferred; the old environment spelling remains a read alias. The stored
and wire key `swarmGuildId` is retained so existing clients can still read and
write it. Environment overrides continue to win over stored values.
