# Frozen PokeMMO simulator scenarios

`navigation-trainer-battle/v1` is the deterministic simulator-authoritative
scenario for the PokeMMO profile. The exact `scenario.json` bytes are pinned by
`scenario.sha256`; the binding repeats that digest and fixes the gameplay world.

The fixture contains fictional map, trainer, party, move, and inventory state.
It never contains account credentials, live-client data, screenshots, packets,
or copyrighted ROM assets. The simulator derives success from its own final
state and bounded hash-chained trace, not from model-authored claims.
