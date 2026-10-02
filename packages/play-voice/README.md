# @clankie/play-voice

The canonical loopback seam for Clankie's gameplay commentary and room hearing.
It preserves the event-not-script boundary from historical
[ADR 0064](../../docs/adr/0064-possessor-voice-seam.md), scoped by the current
no-possession decision in
[ADR 0129](../../docs/adr/0129-each-player-owns-a-body.md).

Clankie's hosted-world play loop holds no Discord gateway or live presence
claim. It reports what happened; the active media-enabled Discord body decides
whether and how to speak, and pushes only room input it is already allowed to
hear. External harnesses do not receive this package or credential.

The package connects Clankie's credentialed hosted-world seat to his own active
Discord body. Other players use their own PokeAgents seats and cannot receive
Clankie's room input or publish through his voice connection
([ADR 0145](../../docs/adr/0145-the-world-is-the-only-body.md)).

## API

| Export                          | Consumer            | Responsibility                                                                                |
| ------------------------------- | ------------------- | --------------------------------------------------------------------------------------------- |
| `createPlayVoiceListener`       | Active Discord body | Binds loopback, authenticates the bearer, accepts narration, pushes utterances and room state |
| `createBrokeredPlayVoiceClient` | Clankie play        | Resolves the broker bearer and dials the listener                                             |

The client exposes `narrate`, `subscribe`, `roomListening`, `connected`, and
`close`. The listener exposes `publishUtterance`, `publishRoom`,
`attachedCount`, and `close`.

## Wire And Bounds

The wire has three messages: `narrate` enters the active Discord body;
attributed `utterance` and boolean `room` state are pushed back. Narration and
utterances are capped at 2,000 characters; a socket payload is capped at 64 KiB.

Narration is context, never a script. Play cannot choose an audience,
join or leave a channel, or reach another presence action. Raw audio and member
identities never cross this seam.

## Direction And Credentials

The active Discord body opens only a loopback listener. Play dials it and presents
the broker-minted `clankie_play_voice` bearer, so local binding and
authentication are independent locks. The Discord body owns first-run minting;
clients only resolve the stored bearer. `CLANKIE_PLAY_VOICE_TOKEN` is a
hard error.

The media-enabled active Discord body hosts `ws://127.0.0.1:4323/play` whenever
its voice session exists. The endpoint is fixed and only one active body runs.

No credential, bridge, or live voice session returns a typed refusal rather
than false success.

## Loss And Evidence

Narration refuses while disconnected instead of queueing stale commentary.
Utterances published with nobody attached are dropped without a delivery
receipt, never replayed. The consumer connects only during a play session;
ordinary room traffic while play is idle is not a failed delivery. Current
room state is sent once on attach and on every change.

The listener's optional evidence contains only connection phase,
attached/delivered counts, listening state, delivery ids, and bounded refusal
codes. Narration and utterance text cannot enter the evidence type. A
narration-submission event means the live voice session accepted the report; a
rejected call emits only a refusal.
