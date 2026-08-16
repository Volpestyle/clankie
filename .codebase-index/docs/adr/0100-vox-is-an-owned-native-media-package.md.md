# docs/adr/0100-vox-is-an-owned-native-media-package.md

Decision to own the recovered native media implementation as AGPL `apps/vox` while keeping Apache product code across the typed `@clankie/vox-client` process boundary. Current integration consumes lab-user screen-watch and Go Live; ordinary Discord voice/music stays on `@discordjs/voice` until a separately tested migration.
