# integrations/gba-emulator/scripts/evaluate-free-play-competence-receipt.ts

`gameplay:evaluate-competence-receipt` —
independently verifies a stored competence
receipt: loads the canonical benchmark from
the repo, reruns the ROM-gated states fresh on
the operator's local ROM, and calls
`evaluateFreePlayCompetenceReceipt` to match
the receipt at
`CLANKIE_GBA_COMPETENCE_RECEIPT_PATH` against
both. Prints the check list; exits 1 on
failure.
