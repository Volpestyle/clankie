# docs/adr/0024-discord-dual-plane-presence.md

Decision that official-bot and explicitly opted-in normal-user transports are isolated processes representing one character through shared semantic presence contracts. Only one body is active, credentials/gateways never mix, Go Live and share watch belong to the lab user body, and ordinary bot voice/Activity remain distinct surfaces.
