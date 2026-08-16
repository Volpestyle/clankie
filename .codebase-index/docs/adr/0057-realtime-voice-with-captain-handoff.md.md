# docs/adr/0057-realtime-voice-with-captain-handoff.md

Decision for dormant per-speaker transcription feeding one shared floor and an engaged realtime conversation session. The realtime session owns ordinary speech and local voice/music tools; one bounded `ask_clankie` handoff reaches the continuing voice captain lane for actions beyond that local surface.
