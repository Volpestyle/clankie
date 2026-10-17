# Activity media publication and source transitions — VUH-1481

Two product gaps were reproduced before implementation:

- Normally published MP4/WAV/MP3 files were inferred as `application/octet-stream`. Activity source selection refused them; existing media tests supplied MIME overrides. Normal publication now infers `video/mp4`, `audio/wav`, and `audio/mpeg`. Real decoder tests retain size/duration/content refusal and cleanup checks.
- Closing the previous generation during a source switch emitted a false idle transition before the replacement attached. The body now retains its busy hold across that transfer and releases it in failure/shutdown paths. Successful and failed attachment cases exercise the real private HTTP/media boundary.

## Checks before landing

- Core sharing and hosted integration: **18/18 pass**, 17.04 s, after both fixes. The MIME regression first failed with `application/octet-stream`; the busy regression first observed `[true,false,true]` during a successful switch.
- Composed managed stack: **6/6 pass**, 56.45 s, across the existing gateway journey and new two-customer journey. The normal-WAV source switch first failed `404 activity_source_unavailable`; its stricter busy check then exposed the second bug.
- Gateway typecheck: **exit 0**, includes source and tests.
- Bundled Embedded App SDK/native Chromium: **1/1 pass**, 7.00 s. Desktop, phone and tablet captures were inspected: isolated red/blue fixture sources, green replacement source, sound control and terminal revocation state. These are fixture-colored frames, not actual Pokémon gameplay or Discord recordings.

The two-customer journey uses one gateway, edge and fleet with two isolated body runtimes/private producers, current signed installation requests, SQLite, delivered artifact storage, real WebSockets, the production play-source fanout and real WAV decoding. It checks game frame/PCM projection, nonzero decoded non-game PCM, source generations, stale admission refusal, foreign tenant control/viewer/publisher refusal, and independent stop/busy cleanup.

## Scope and remaining acceptance

Discord OAuth, permissions, instance and invite responses are loopback provider fixtures. Native SDK/browser coverage and the composed managed-stack wire coverage are separate tests; this is not a claim of a real Discord iframe running through the deployed managed stack. No real server, tenant, installation, Discord account, tunnel, deployment, shared-service restart, or model eval was used.

Official Activity application selection/registration, verification ownership, approved mapping and deployment remain prerequisites. Real Discord recordings still need game and non-game sources, audio, switching/stopping, two concurrent customers and self-hosted behavior. Technical live verification is agent work after authorized setup/deployment. The self-hosted official launch/admission adapter remains outside this slice; delegated local sharing is covered by existing tests. VUH-1481 remains open for that acceptance.

Raw test outputs, source diffs and inspected browser captures are in the content-addressed evidence manifest. Final landing results and commits are recorded on the issue.
