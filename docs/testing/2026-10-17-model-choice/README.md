# VUH-2108 / VUH-2110: model selection compatibility

Tracks: https://linear.app/vuhlp/issue/VUH-2108 and https://linear.app/vuhlp/issue/VUH-2110

Audited fetched core `origin/main` `45829f33a` and app `fb75199e`; both Oct 11 implementations are already on main (`0e579cc3e`, `9e6a6c948`; app `1db6e24b`, `d40ef584`). Both issues' comments and all attachments were read. [Acceptance-by-acceptance core audit](https://linear.app/vuhlp/issue/VUH-2108#comment-dd9a2eda-bd45-474e-92d3-68aa05e95718); [app audit](https://linear.app/vuhlp/issue/VUH-2110#comment-446237af-9dc9-40d4-99f3-46f72e01e6f3).

The core gap was the compatibility selector: `/v1/model-keys/select` called a setter that did not enforce the settings API's eligible choices. The shared setter now enforces current availability and hosted mappings for every caller. The legacy endpoint maps routine/escalation to an eligible `clankie/default` preference; the new endpoint still refuses tier choices. Existing persisted tier values remain readable until replaced by an eligible choice. Credential storage, provider authentication and spending rules are unchanged.

CLI/TUI now say “Rates not published yet” before selection. No approved rate/catalog policy exists; Clankie confirmed that VUH-2107/VUH-1890 alone retain `needs-human`. No prices, entitlements, paid model calls, evals, deployment or account changes.

## Verification

- Model-key/API checks: 17 passed, including real settings HTTP selection/reversal, unauthenticated/refused writes, legacy migration and unavailable included mappings.
- CLI/provider consumers: 35 passed on unchanged source inputs (7 CLI, 28 provider-command cases).
- An existing telemetry fixture now supplies an available fixture credential before selecting, so it still proves custom IDs and key material never enter telemetry while obeying the new eligibility boundary.
- Initial dependency-copy failures were setup failures (missing integration links and a copied lead-skin link to another app worktree), not passing product evidence. Repaired only this isolated worktree's links/copies; the held `~/dev/clankie` remained untouched.
- Real source-service turn HTTP integration: 1 passed, covering escalation, fallback identity, refusal, token reconciliation, authentication and retained history without a paid provider.
- The required root landing gate's checked HEAD, base and actual result are posted to the issue. App/device evidence is retained in the private app's same dated folder.

## Focused result output

```text
RUN  v4.1.10 /Users/james/dev/clankie-wt/vuh-2108-night


 Test Files  2 passed (2)
      Tests  17 passed (17)
   Start at  00:33:55
   Duration  5.15s (transform 3.88s, setup 67ms, import 6.47s, tests 807ms, environment 0ms)
RUN  v4.1.10 /Users/james/dev/clankie-wt/vuh-2108-night


 Test Files  1 passed (1)
      Tests  1 passed (1)
   Start at  00:34:30
   Duration  14.60s (transform 731ms, setup 28ms, import 1.14s, tests 13.33s, environment 0ms)
```

## Retained API observations

[Authenticated turn events and metrics](clankie://evidence/sha256/a5867cf53c8e728278093f8d9585beeb0d4dbe89ffccd8ddf3c2dfbaece2e8a8) and [controlled provider requests](clankie://evidence/sha256/9eaf9a24aa42d95dca5c751f3f4ebc05e49b2db5625f27724afaf25063a63540) come from the production source service, Pi transport and durable journal against an owned streaming provider. They prove integration behavior, not cloud model quality or commercial billing. The provider never receives real owner context or a paid credential.
