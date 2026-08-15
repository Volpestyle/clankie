# integrations/gba-emulator/README.md

The package's deep guide: the three cores
behind the `GbaCoreSeam`, how collision and
exits are decoded from live FireRed RAM, the
scenario drivers, free play, asked play, and
every operator command.

Sections cover the core seam (double / real
FireRed / Emerald visual), the live map buffer
(`gBackupMapLayout`) and minimap, deterministic
scenario receipts with the two-run
byte-identical live proof, the rolling
evidence policy for open-ended play, minted
checkpoints, the free-play competence gate,
and the journal every run writes. Includes
the env-var incantations for bootstrap,
live-proof, receipt evaluation, and the
bounded RAM probe. References ADRs 0039/0040/
0043/0049/0058-0061/0063/0066/0072/0073/0075/
0089/0090 in docs/adr.
