# apps/clankie/test

Service test suite covering API/authentication, captain tools and contexts, memory, Discord projections, devices, media, embodiment, GBA play, and optional hosts. It also carries source-boundary tests that prevent external PokeAgent MMO implementation details from entering the workspace.

The directory contains focused `*.test.ts` files for each service module, including `operator-conversation-context.test.ts` and `pokeagent-mmo-boundary.test.ts`.
