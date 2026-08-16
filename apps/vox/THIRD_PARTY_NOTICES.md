# Vox third-party notices

This is the native package's engineering inventory, not a complete SBOM.
Cargo's locked dependency graph remains the source of truth for exact versions.

Bundled or statically linked native components include:

- libopus through `audiopus-sys` 0.2.2, BSD-style Opus license. The Rust
  `audiopus` and `audiopus-sys` wrappers are ISC.
- Cisco OpenH264 through `openh264-sys2` 0.9.6, BSD-2-Clause.
- libjpeg-turbo through `turbojpeg-sys` 1.1.1, under its BSD-3-Clause, IJG,
  and zlib license set. The Rust wrapper is Unlicense OR MIT.
- `davey` 0.1.4, MIT, including MIT-licensed OpenMLS dependencies.

Vox can invoke separately installed programs at runtime. They are not bundled:

- FFmpeg, whose effective license depends on the installed build and codecs.
- libx264 through FFmpeg for H264 publishing.
- yt-dlp for indirect media URL resolution.
- the host shell and `sed` for media pipeline composition.

See `Cargo.lock` and `cargo metadata --locked --format-version 1` for the full
Rust graph.
