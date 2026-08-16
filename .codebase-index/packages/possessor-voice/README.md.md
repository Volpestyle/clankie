# packages/possessor-voice/README.md

Documents the ADR 0064 possessor voice seam: the
two halves (`createPossessorVoiceListener` for the
bridge, `createBrokeredPossessorVoiceClient` for a
possessor), the deliberately tiny wire contract
(narrate in, utterance out — adding a message is a
decision), narration-as-context-never-script, the
dial-out + loopback + bearer direction/locking
model, the refuse-don't-queue lossiness, and the
content-free evidence the listener can emit for
the bridge receipt log. It explains how an asked-
play `deliveryId` joins journal, submission,
spoken response, and suppression evidence.
Includes a mermaid diagram.
