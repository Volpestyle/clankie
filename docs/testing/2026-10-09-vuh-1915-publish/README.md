# VUH-1915 evidence publication

This worker proof records the evidence-store workflow used for VUH-1915. The
worker writes this README, publishes the folder with `clankie evidence push
docs/testing/2026-10-09-vuh-1915-publish --issue VUH-1915`, commits only this
README and the generated `evidence.json`, and cites the returned
`clankie://evidence/sha256/...` links in the issue comment.

The documentation change updates worker, lead, and Linear guidance so raw
captures stay in the evidence store while the repository retains the readable
README and manifest.
