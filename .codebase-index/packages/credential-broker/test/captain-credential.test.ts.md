# packages/credential-broker/test/captain-credential.test.ts

Captain-bearer lifecycle: first-run mint persists
and is reused; 256 bits of entropy; env override
wins without writing to the store; resolve reads
nothing rather than minting; an empty env
override and a malformed stored credential are
typed errors; no collision with the operator
credential's slot.
