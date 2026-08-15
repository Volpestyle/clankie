# integrations/gba-emulator/test/free-play-mind-prompt.test.ts

Runs both model minds through the **real**
`ai` SDK prompt validation with a mock
provider model — deliberately not mocking
`streamObject`, because a mocked stream cannot
see the class of failure where the SDK rejects
the prompt shape outright (the 2026-08-02
mute-Clankie incident). Asserts the player and
voice prompts reach the provider and decisions
round-trip.
