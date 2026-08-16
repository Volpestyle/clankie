# packages/credential-broker/src/possessor-voice-credential.ts

Local bearer for the possessor voice seam (ADR
0064), under `clankie_possessor_voice`: a process
driving Clankie's body presents it to the
bridge's loopback possessor listener to speak and
hear through his live voice session. Mirrors the
activity-producer module exactly — mint/resolve/
ensure plus a hard startup error when
`CLANKIE_POSSESSOR_VOICE_TOKEN` appears in the
environment. The bridge owns the listener and the
mint; possessors only resolve.
