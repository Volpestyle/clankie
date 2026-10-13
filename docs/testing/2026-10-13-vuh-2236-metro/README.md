# VUH-2236: portable protocol and headless Metro bundles

Tracks: https://linear.app/vuhlp/issue/VUH-2236

The hosted-browser-session → public-gateway → discord-ingress import graph now
uses the existing app's portable SHA-256 algorithm. Host IDs and signed event /
recipient digests retain their UTF-8 inputs, domain separators, schema parsing,
and canonical unpadded base64url output. No grants, encryption or revocation
behavior changed. No app source change is needed.

## Inputs

Core base: `14690037026714aa4e034bab2471c119a56e0528`, fetched origin/main.
Fixed core worktree: `/Users/james/dev/clankie-wt/vuh-2236`.
Fresh, clean app worktree: `/Users/james/dev/clankie-wt/vuh-2236-app`,
app SHA `d03296c29543bc04c34d67af18afbc9729fb9fda`.
Hosted integration fixture: fresh ops worktree at
`5192538` (fetched origin/main; full SHA in inputs.json).

Each worktree received a real install under `clankie heavy`; no dependency/cache
symlinks to another checkout were used. Disposable app/ops workspace manifests
were adjusted for install-time sibling names. The app's tracked manifest and
lockfile were restored before bundling; pnpm dependency preflight was disabled
for proof commands to preserve the installed links. Metro used
`CLANKIE_CORE_ROOT=/Users/james/dev/clankie-wt/vuh-2236` throughout.

## Results

All commands ran headlessly through `clankie heavy --`, without GUI, simulators,
screen capture, owner credentials or Keychain. Logs are archived beside this file.

- iOS: `pnpm exec expo export --platform ios --output-dir CORE/.local/vuh-2236/ios --max-workers 2`
  from `apps/mobile`, with `CI=1`: exit 0, Hermes bundle and metadata written.
- Web: `pnpm exec expo export --platform web --output-dir CORE/.local/vuh-2236/web --max-workers 2`
  from `apps/web`, with `CI=1`: exit 0, JavaScript bundle and HTML written.
- macOS: `pnpm exec react-native bundle --platform macos --dev false --entry-file apps/macos/index.js --bundle-output CORE/.local/vuh-2236/macos.jsbundle --assets-dest CORE/.local/vuh-2236/macos-assets --max-workers 2`
  from `apps/macos`: exit 0, bundle and assets written. Metro's configured root is the app repo root.
- Six focused core files: 50 cases passed, including hosted pairing, WebCrypto
  browser pairing, hosted device security, Node-free import graphs and Node SHA-256
  compatibility for Unicode, boundary-size content and existing host identities.
- Original app hosted-browser-session and device-management integration suites:
  25 cases passed, none skipped. Real local fleet/body, signed pairing, encrypted
  gateway and relay; existing local Cognito/AWS/Stripe/captain fixtures.
- App hostedSignIn and pairingSession: 54 cases passed.
- Protocol typecheck, touched-file formatting and lint: exit 0.
- Regression check: substituting only the two original source files from the base
  into the graph reader makes the extended check fail on all three newly covered
  entrypoints (3 failures / 3 passes). The fixed graph passes all six entrypoints.

The integration-only configuration in the archive maps the tests' hard-coded
`../clankie` and `../clankie-ops` paths to these proof inputs and resolves public
workspace packages from the fixed core. It changes no tests or fixture assertions.
An initial attempt used an older local ops fixture and failed; the matching fresh
ops fixture passed. This proof makes no native-launch or production-deployment claim.

The service-owned integration queue supplies the final exact-tree landing gate.
