# Clankie capability evaluation

**Result:** INCOMPLETE

**Checked:** 2026-08-11T04:41:56.523Z

**Manifest:** `evals/capabilities/v2/manifest.yaml` (`b8326d39796d889e55156140c6a50ef2722fdeebabdee5bd8e25b39b9d917c0f`)

| Capability | Status | Evidence / missing inputs |
| --- | --- | --- |
| Discord bot and text chat | missing_input | ambient_roles, application_id, discord_application_identity, discord_guild_membership, ingress_allowlist, message_content_intent, presence_allowlist, target_guild, text_ingress_enabled, readiness_not_passed |
| Multi-person Discord voice | missing_input | clean_leave, dave_reconnect, overlap_and_barge_in, possessor_two_way_delivery, speech_round_trips, three_attributed_speakers, three_explicit_participants |
| Discord screen watch and publish | blocked | discord_screen_official_transport_unavailable |
| Pokémon FireRed | missing_input | firered_live_receipt_path, firered_free_play_competence_receipt_path |
| Minecraft | missing_input | minecraft_eula_acknowledgement, readiness_not_passed |
| Long-term Discord people memory | missing_input | approved_fact_recalled, control_plane_restart_durability, reviewed_proposal_delivered |
| Command-started coding workers | passed | all gates passed |
| Live operator TUI | passed | all gates passed |
| Discord-origin workers in the TUI | missing_input | discord_tui_live_receipt_path |

Raw command output is not retained. Each command receipt contains only exit status, duration, normalized issue codes, and output hashes.

