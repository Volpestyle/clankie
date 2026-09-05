# Disposable Linux service proof for VUH-1053. This image is not the hosted
# Clankie service image, and it is not a release artifact.
#
# Herdr is a required runtime, not an optional one, so the binary comes from the
# already-proven `clankie-herdr-linux:local` image rather than being rebuilt:
# no Rust or Zig toolchain in this layer. Build a context of tracked files only
# (`git archive HEAD`), never a dirty checkout — the working tree holds
# credentials, state, and node_modules that must not enter an image.
FROM clankie-herdr-linux:local AS herdr

FROM node:24.20.0-bookworm
# The launcher reads the process table with `ps` and resolves port owners with
# `lsof`, which is how it tells its own service from a foreign one on another
# port. Debian's node image carries procps but not lsof.
RUN apt-get update \
 && apt-get install -y --no-install-recommends procps lsof \
 && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@11.11.0 --activate
WORKDIR /clankie

# Where `bundledHerdrBinary` looks in a checkout (apps/clankie/src/herdr-runtime.ts).
COPY --from=herdr /clankie/.data/herdr /clankie/.data/herdr

COPY . .
# devDependencies included: every service `start` script runs through tsx.
RUN pnpm install --frozen-lockfile

# State, settings, and credentials live outside the source tree so the container
# is disposable. CLANKIE_CREDENTIALS_FILE forces the file broker explicitly
# rather than relying on the platform default doing the right thing.
ENV CLANKIE_STATE=/state \
    XDG_CONFIG_HOME=/state/config \
    CLANKIE_CREDENTIALS_FILE=/state/credentials.json \
    CLANKIE_RELAY_HOST=0.0.0.0
CMD ["sleep", "infinity"]
