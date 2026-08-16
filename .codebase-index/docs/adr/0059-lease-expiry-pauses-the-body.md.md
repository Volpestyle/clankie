# docs/adr/0059-lease-expiry-pauses-the-body.md

Decision that an expired environment lease represents an idle holder, so the live body pauses and the same capability may renew it subject to the single-writer rule. Explicit stop, emergency stop, adapter failure, and revocation remain final and cannot renew.
