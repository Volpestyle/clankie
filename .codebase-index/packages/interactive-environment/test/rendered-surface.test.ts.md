# packages/interactive-environment/test/rendered-surface.test.ts

Overlay versioning suite. Covers: the legacy v1
`lines` payload still accepted; the structured
overlay normalized to an honest schemaVersion 2
even from a producer still stamping 1; shapes
that lie about their version rejected (lines
claiming v2, structured claiming v3); and both
overlay versions carried through the
`RenderedSurfaceMessageSchema` envelope.
