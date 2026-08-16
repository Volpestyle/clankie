# packages/credential-broker/src/activity-producer-credential.ts

Typed lifecycle for the private `clankie_activity_producer` bearer used by the Activity producer/snapshot listener. It rejects environment copies and delegates mint/resolve/ensure mechanics to the shared stored-bearer helper while preserving activity-specific patterns and errors.
