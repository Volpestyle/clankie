# docs/adr/0043-version-pinned-firered-gameplay-profile.md

`decodeFireRedState` accepts exactly Pokémon
FireRed US v1.0 (pinned SHA-256) with layouts
from pret/pokefirered: overworld, encrypted party
and bag substructures, battle buffers, menus,
dialog. Everything validated; unsupported state
throws and pauses the session.

Read before touching the RAM decoder or gameplay
controller. Key rules: only battle outcome 1 is a
win; the controller observes / decides / acts
once / verifies with no input transcript;
evidence tiers separate CI-on-double from the
two-fresh-core ROM-gated live proof; another ROM
revision needs its own profile, never guessed
offsets.
