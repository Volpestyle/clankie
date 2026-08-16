# docs/adr/0039-gba-emulator-embodiment-and-deterministic-core-boundary.md

Decision to model GBA play as a governed interactive environment behind a narrow core seam. A deterministic ROM-free double proves contracts in CI while pinned real mGBA cores provide product play without allowing ROM, savestate, frame, or credential bytes into semantic evidence.
