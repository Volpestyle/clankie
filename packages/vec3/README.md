# Minecraft vector compatibility

`@clankie/vec3` is an independent Apache-2.0 implementation of the vector surface
used by Clankie's pinned Minecraft motor. The workspace override aliases every
`vec3` dependency to this package, including Mineflayer's transitive dependencies.
It ships JavaScript directly so CommonJS consumers and the release copy need no
build step. The package includes its own license text; the release license gate
is unchanged.

This implementation was written from installed **consumer** call sites and
ordinary vector mathematics. No upstream vec3 implementation or vec3 test source
was used. It is a scoped compatibility package, not a promise to support every
upstream vec3 API. Re-enumerate consumers and run motor conformance whenever the
Minecraft dependency pins change.

## Consumer inventory

Installed tree enumerated on 2026-10-04, excluding upstream vec3 paths and
viewer public/browser bundles:

| Consumer                    | Representative call sites                                                                              | Required surface                                                                                                                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| mineflayer 4.35.0           | `lib/plugins/entities.js`, `digging.js`, `blocks.js`, `creative.js`, `ray_trace.js`, `lib/location.js` | numeric constructor; writable x/y/z; set/update/translate; clone/add/subtract/scale; offset/plus/minus/scaled/floored; normalize/norm/dot/distanceTo/distanceSquared/modulus/equals/toString |
| mineflayer-pathfinder 2.4.5 | `lib/move.js`, `shapes.js`, `physics.js`, `goals.js`, `index.js`                                       | named Vec3 class (including extends); clone/subtract/scale/update; plus/minus/offset/scaled/floored; norm/normalize/dot/distanceTo                                                           |
| prismarine-physics 1.10.0   | `index.js`                                                                                             | named Vec3 constructor; clone/add/offset/normalize/translate/norm                                                                                                                            |
| prismarine-world 3.6.3      | `src/world.js`, `worldsync.js`, `iterators.js`                                                         | named constructor; offset/plus/minus/scaled/floored                                                                                                                                          |
| prismarine-chunk 1.39.0     | `src/pc/1.8/chunk.js`, `src/bedrock/{0.14,1.0}/chunk.js`, `src/bedrock/common/CommonChunkColumn.js`    | named constructor and constructible CommonJS default export; modulus; writable coordinates                                                                                                   |
| prismarine-entity 2.6.0     | `index.js`                                                                                             | named constructor with zero coordinates                                                                                                                                                      |
| prismarine-viewer 1.33.0    | `viewer/lib/{worldView,world,worldrenderer,worker,models}.js`, `lib/standalone.js`                     | named constructor; update/offset/plus/floored/toString                                                                                                                                       |

Mutating methods return the same object. `clone`, `offset`, `plus`, `minus`,
`scaled`, and `floored` allocate a base Vec3 so pathfinder's Move subclass does
not acquire constructor-specific state on copies. Zero-vector normalization
keeps zero finite, as required by still-water physics. Equality compares exact
coordinates; flooring uses mathematical floor for negative block coordinates.
Public browser assets supplied by prismarine-viewer remain third-party assets;
this package replaces server-side Node dependency resolution.
