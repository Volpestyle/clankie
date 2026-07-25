# Clankie capability evaluation

**Result:** INCOMPLETE

**Checked:** 2026-07-25T18:11:22.343Z

**Manifest:** `evals/capabilities/v1/manifest.yaml` (`5ac481c5a6eeb3672227325300dff13d014ccb9e042679c1e2e8955c886eaaad`)

| Capability | Status | Evidence / missing inputs |
| --- | --- | --- |
| Discord bot and text chat | missing_input | ambient_roles, application_id, control_plane_composition, discord_application_identity, discord_guild_membership, ingress_allowlist, message_content_intent, official_bot_credential, presence_allowlist, target_guild, text_ingress_enabled, readiness_not_passed |
| Multi-person Discord voice | missing_input | application_id, control_plane_composition, discord_application_identity, discord_guild_membership, official_bot_credential, target_guild, target_voice_channel, voice_enabled, readiness_not_passed |
| Discord screen watch and publish | blocked | discord_screen_official_transport_unavailable |
| Pokémon FireRed | passed | all gates passed |
| Minecraft | missing_input | minecraft_eula_acknowledgement, readiness_not_passed |
| Long-term Discord people memory | missing_input | approved_fact_recalled, control_plane_restart_durability, reviewed_proposal_delivered |
| Command-started coding workers | passed | all gates passed |
| Live operator TUI | passed | all gates passed |
| Discord-origin workers in the TUI | missing_input | discord_tui_live_receipt_path |

Raw command output is not retained. Each command receipt contains only exit status, duration, normalized issue codes, and output hashes.

