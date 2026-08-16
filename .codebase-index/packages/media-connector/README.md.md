# packages/media-connector/README.md

Explains the schema-v2 boundary (ADR 0085):
image/edit/video as a `kind` union, the supported
provider models, the authority split (this package
only writes a caller-selected local artifact;
posting a picture is the clankie service's and
presence schema's decision), the untrusted-
provider hardening (validated shapes, 0600 mode,
byte ceiling, host-pinned video download), the
pixel-art path refusal, and code examples for
image generation and the three-step video job.
