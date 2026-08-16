# docs/adr/0059-lease-expiry-pauses-the-body.md

Lease expiry says the holder went away, not that
the world should die: a lapsed lease pauses the
body in place (fenced, world kept); only explicit
stop, emergency stop, and adapter failure revoke.
Every authorized call re-arms the expiry, so an
actively driven session cannot lapse.

Read for the recovery contract: the same token
`renew`s a lapsed claim (unless another writer
took the body), renewal resumes only the pause
the lapse caused (deliberate safety pauses
survive), and the free-play composer retries a
lapsed dispatch once. `pause` is lease-free;
`resume` is driving and lease-gated.
