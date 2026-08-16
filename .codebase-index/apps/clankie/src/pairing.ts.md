# apps/clankie/src/pairing.ts

Device pairing-offer minting and single-use
redemption. An offer is short-lived display data
(5 min TTL) an operator hands to a device — a
QR deep link (`clankie://connect?offer=...`)
carrying a high-entropy secret, plus a typed
code like `7F3K-M2QT` from an unambiguous
alphabet. Secrets go to the operator's terminal
only; audit events carry the non-secret
`offerId`.

Exports `mintPairingOffer()`,
`pairingOfferWire()` (the shape `clankie pair`
expects), and `PairingOfferStore`: in-memory,
lookup by hashed secret or normalized-code hash,
synchronous single-use `take()` so concurrent
redemptions cannot both win. A consumed offer
reads `consumed` for a grace window and then
`expired` — identical to unknown — so redemption
never becomes an enumeration oracle.
