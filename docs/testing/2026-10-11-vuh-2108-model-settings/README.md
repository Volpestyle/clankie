# VUH-2108: shared model settings and serving identity

Checked source revision: `edb812fbf5f69470a94b12764189550fe107924b` (before this evidence-only amendment).

65 tests across 7 focused suites; core and TUI typechecks passed. Real HTTP/Pi checks cover authenticated selection, persistence, reversal, rejection, actual hosted fallback identity and missing-header unknown. Authorization checks cover device grants and revocation; the gateway admits the shared GET/POST route.

Formatter ran directly on touched files; builds/tests/typechecks used `clankie heavy --`. Core/app submission uses plain integrate; ops uses its normal landing path. No local full core root gate, eval, hosted deployment or live hosted configuration change.

Policy-independent slice: catalog pins, defaults, prices and credit gates remain unchanged. Provider/catalog and credit-plan choices from VUH-1890 are open, explicitly represented as `included_catalog_policy` and `credit_rate_policy`. No rates invented. VUH-2107 owns policy-dependent catalog/credits; VUH-2109 owns broader automatic routing; VUH-2110 owns full UI completion and device captures. Actual usage metadata accompanies completed spoken messages; historical entries without observations remain unnamed.

The evidence archive retains inspected focused results and compiler output. Initial CLI/TUI fixture failures and the missing test cost field were corrected before these final green runs. Hosted deployment is a separate lead step.

Public-docs correction: the initial integration failed because the public endpoint table omitted GET/POST `/v1/model-settings`. Both entries are now documented beside the model-key endpoints. The focused docs check passed: 10 public pages, 110 network routes, 219 API operations and 81 slash commands; links and anchors resolve. The original gating request could not be cancelled (409); the corrected request follows its terminal state.
