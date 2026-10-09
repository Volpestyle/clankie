# Cleanup lenses

## Mapping commands

Adjust the globs to the repo's languages.

```bash
git ls-files '*.ts' '*.tsx' | xargs wc -l | sort -rn | head -40
git log --since="12 months ago" --format= --name-only -- '*.ts' '*.tsx' | sort | uniq -c | sort -rn | head -40
git log --since="12 months ago" -i -E --grep='fix|bug|hotfix|revert' --format= --name-only -- '*.ts' '*.tsx' | sort | uniq -c | sort -rn | head -30
git shortlog -sn --since="12 months ago"
```

Rank hotspots by churn × size. For each one, note its bug-fix churn and its
count of distinct recent authors; a file with only one author is a bus-factor
risk.

Prefer analyzers already in the repo's devDependencies. Read-only `npx`
analyzers (`knip`, `madge`, `depcheck`) are fine where the network allows. Fall
back to `rg`, `git` and reading code. Never add packages to run an audit. Route
typechecks, test suites and analyzers that build through `clankie heavy`.

## Finding format

```
### [LENS-NN] Short title
- Where: path/to/file.ts:120-180 (plus others)
- Evidence: what you observed, with counts or a snippet of 10 lines or fewer
- Cost: concrete impact (bugs, slow changes, onboarding, performance)
- Essential or accidental: which, and why
- Suggested fix: the smallest effective change; say if it is a deletion
- Effort: S (<1 day) / M (days) / L (weeks)
- Confidence: high / medium / low, and what would raise it
```

## A. Type safety and trust boundaries → `types.md`

- **Escape hatches, reported as clusters rather than totals:**
  `rg -n --type ts -e ':\s*any\b' -e '\bas any\b' -e '<any>' -e 'as unknown as' -e '@ts-(ignore|expect-error|nocheck)' -e 'eslint-disable'`.
  Also non-null assertions on hot paths.
- **Strictness gaps:** estimate what enabling a missing flag would cost with a
  temporary config that extends the root one, counting errors by directory.
- **Untrusted input:** check whether API responses, request bodies, env,
  storage and message payloads are validated at runtime, or cast and trusted.
- **Drift:** duplicated or diverging types for the same domain concept.

## B. Architecture and coupling → `architecture.md`

- **Import graph:** cycles, the most-imported modules, layering violations,
  and domains reaching into each other's internals.
- **God modules and catch-all folders** (`utils/`, `shared/`, `common/`).
- **Abstraction mismatches:** shallow abstractions that hide nothing, and
  generic code with one caller. Also the reverse: the same logic pasted three
  or more times.
- **Intended vs. actual** architecture, compared against the map.

## C. Dead code and cruft → `dead-code.md`

- **Unused files, exports and dependencies.**
- **Feature flags:** for each flag, where it's read, and whether it's
  effectively permanent or its purpose has passed.
- **Unfinished migrations:** parallel paths they left behind (v1/v2,
  legacy/new), compatibility shims, deprecated APIs still in use.
- **Old markers:** commented-out blocks, and TODO/FIXME/HACK aged with `git blame`.
- **Deliverable:** a table of deletion candidates with estimated LOC and
  safety confidence.

## D. Dependencies and tooling → `dependencies.md`

- **Outdated majors and deprecated packages**, read-only.
- **Redundancy:** several libraries doing the same job, a heavy package used
  for one function, several versions of one package in the lockfile.
- **Lint and CI health:** whether lint is enforced, and how many rules are
  disabled globally or inline.

## E. Tests and the safety net → `tests.md`

- **Coverage against hotspots:** which hot files have no meaningful tests.
- **Quality:** assertions on mocks rather than behavior, snapshot-only tests,
  skipped tests, sleeps and long timeouts.
- **Prune candidates:** tests that pin incidental output. Never cut tests that
  guard trust boundaries, contracts, protocol shapes, security or data
  integrity. Follow the repo's own test policy where it has one.
- **Refactor readiness:** what it would take to refactor the top three
  hotspots safely.

## F. Runtime robustness → `runtime.md`

Swallowed errors, floating promises, inconsistent error and result patterns,
network calls without timeouts, and unchecked index access on hot paths.

## G. Hotspot deep reads → `hotspots/<file-slug>.md`

Use one agent per top-3-to-5 hotspot. It reads the file and its history closely
and answers two questions:

- Why does it change so often: too many jobs, a missing abstraction, or a
  genuinely hard domain?
- What is the smallest change that would make the next ten edits cheaper?
