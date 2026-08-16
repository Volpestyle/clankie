# packages/credential-broker/test/activity-producer-credential.test.ts

Activity-producer bearer tests: a prefixed
high-entropy bearer distinct from the Discord
bridge family; bootstrap-once semantics; an
env-supplied token refused as a startup error;
malformed stored credentials refused; undefined
before bootstrap so callers can fail closed.
