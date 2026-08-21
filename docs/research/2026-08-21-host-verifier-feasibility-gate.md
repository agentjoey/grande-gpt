# Host Verifier Feasibility Gate — 2026-08-21

Task: `task-reliability-hostverifier-20260821-001`

## Gate purpose

Slice B requires real trusted-host evidence before Slice C is allowed. The original gate assumptions were revised by Human Owner approval after the fifth real-host run. The active criteria are now:

1. one outer Seatbelt boundary proves child inheritance/non-escape: allowed fixture behavior succeeds while sensitive-path and non-loopback behavior remains denied;
2. a real Git hook executes without Safe Git overrides and is suppressed by Safe Git;
3. a trusted-parent allocated exact loopback port works while LAN/non-loopback and the production Gateway port are denied by default because they are absent from the allowlist;
4. timeout kills the whole process group with no residual orphan;
5. recursive-Seatbelt host cases are explicitly `manualOnly` and cannot be counted by an auto-safe receipt.

The trusted host suite also contains negative probes for control/workspace/canonical/task/DB/credential-store reads and inherited credential/proxy/SSH state.

Approved override: `docs/superpowers/specs/2026-08-21-grande-gpt-reliability-host-verifier-platform-amendment.md`.

## Evidence history

### Initial real-host run

The existing host suites passed, but three new `runVerifierNode()` probes failed before their assertions ran. All three returned `status=null` with:

`[low_level_alloc.cc : 437] RAW: Check sum >= a failed: LowLevelAlloc arithmetic overflow`

The common path was the new verifier SBPL launching Node. The established sandbox profile already allowed `sysctl-read`, and prior Seatbelt research records that Node/V8 startup uses sysctl reads and can otherwise fail with misleading startup errors.

A minimal regression test was added requiring `(allow sysctl-read)` while still forbidding broad signal permissions. RED was observed in `job_93fc0b9a-c066-4af5-b56d-4bea1719a97b`; adding only `sysctl-read` restored `unit-selfhost` and `typecheck` and was committed as `9506e33f3c0cea5b4e2a894c9130ff6b08cfa878`.

### Second real-host run

The failure signature changed: Node now started normally (`status=1` instead of `null`) but reported `MODULE_NOT_FOUND` for probe scripts under `/var/folders/...`.

Root cause: `tmpdir()` produced `/var/...` paths, while the verifier policy was deliberately constructed from `realpathSync(...)` paths under `/private/var/...`. Seatbelt matches runtime path spelling against profile paths; the probe passed the non-canonical `/var/...` script path to Node while only `/private/var/...` was allowed.

The probe fixture was corrected to canonicalize source/dependency/job-temp paths immediately after creation and to use those exact paths for policy construction, cwd, script argv, and probe files. No file-read or execution permission was broadened. That correction was committed as `f2e718ebf1b396c1b11007361b8d6d0ebcb99038`.

### Third real-host run

The canonical-path correction worked: the sensitive-path/environment probe passed, and the remaining failures were reduced to two actual policy/probe semantics.

1. The nested Seatbelt script entered Node successfully, but its inner `spawnSync()` produced no child stdout. The verifier policy allowed exact executable targets but still denied `process-fork`; child creation is required both by the nested probe and by the eventual fixed Vitest runner. A RED unit contract requiring `process-fork` was observed in `job_4896bd22-d492-44a0-9bb8-64741f19dbd9`.
2. The network probe connected successfully to the machine's own non-loopback interface address. That destination is still the local machine and therefore is not a valid proof of reaching an external LAN peer under Seatbelt's `localhost` semantics. The probe was changed to derive a same-subnet IPv4 address that is neither loopback nor any local interface address.

### Fourth real-host run

The distinct LAN peer assertion passed. Two failures remained: nested Seatbelt nominal allow still exited 71, and production `127.0.0.1:8787` still connected despite a narrow deny attempt.

### Fifth real-host run — design-level blocker

The two failures were unchanged on exact SHA `7cbffa73c7ce6a0d508abd2afaa19545467633fb`:

1. recursive `sandbox-exec` nominal allow and deny both exited 71;
2. LAN peer was denied, but production localhost port remained reachable under broad localhost allow.

Human Owner approved the platform amendment: one outer Seatbelt with child inheritance/non-escape, trusted exact loopback-port allocation, explicit `manualOnly` host cases, verifier policy version 2, and runtime allocation bound into execution-plan/receipt identity.

### Amended B2R implementation evidence

The amendment was implemented at the unit/type layer:

- `TRUSTED_HOST_MANIFEST` records `execution: "auto" | "manualOnly"`; recursive-Seatbelt/runner/e2e/verifier-feasibility adapters are manual-only, while the real Git-hook proof is split into a dedicated auto-safe host file. Planning fails closed to `full + manualOnlyRequired` for sandbox/SBPL/verifier-policy surfaces.
- `HOST_VERIFIER_POLICY_VERSION` is `2`. Broad `localhost:*` is absent; trusted input supplies at most eight unique ports, rejects invalid/duplicate/production-port entries, and exposes only the validated allocation through `GRANDE_VERIFIER_LOOPBACK_PORTS`.
- The feasibility harness allocates a port on the trusted host before constructing the profile. Its inheritance probe starts one outer verifier Seatbelt and then an ordinary child Node process; the child must retain allowed fixture/job-temp behavior while DB and LAN access remain denied.
- A future auto-safe server listener harness currently uses a legacy fixed port; the C2 amendment explicitly requires it to consume only `GRANDE_VERIFIER_LOOPBACK_PORTS` from trusted parent allocation.

No generic host execution, arbitrary argv/cwd/env input, directory-wide process-exec, broad signal permission, inherited credential/proxy state, broad localhost rule, or production-port allow was introduced by B2R.

### Sixth real-host run — SBPL exact-port syntax failure

Real host run against clean exact SHA `b6ed5101ab18ca3ea4aa5419c792bae2abe17609` reached 6/7 host files PASS and 164/166 tests PASS. The only two failures were the two new verifier feasibility tests, and both failed before Node started because Seatbelt rejected the generated profile:

`host must be * or localhost in network address`

The offending profile rules were of the form:

`(local ip "127.0.0.1:<trusted-port>")`

This is a syntax/selector-spelling issue, not a failure of the security property. The real-host compiler proves that exact port filters must use Seatbelt's accepted `localhost:<port>` host spelling for `local ip` / `remote ip`. Runtime probes still bind/connect explicitly to `127.0.0.1`, so the network target remains IPv4 loopback; only the SBPL selector spelling changes.

A new RED unit contract was observed in `job_e4e360aa-2a3c-44ba-ab33-4e5223200f68`, requiring exact `localhost:<port>` rules and rejecting the old `127.0.0.1:<port>` profile spelling. The minimal builder correction restored `unit-selfhost` to 78 files / 730 tests in `job_95711573-dd21-4445-9ef2-2eaa39eb7b32`; typecheck passed in `job_e87c5917-3551-4882-93d6-60f58afeb5e9`.

## Current gate state

Slice B is **not yet PASS** until a fresh clean exact-SHA real-host run proves the amended criteria with the corrected Seatbelt selector syntax.

Already proven and retained:

- Safe Git hook suppression: PASS on prior host runs;
- remote LAN/non-loopback deny under deny-default: PASS on prior host runs;
- sensitive control/workspace/canonical/task/DB/credential/env isolation: PASS on prior host runs;
- timeout process-group cleanup with no residual orphan: PASS on prior host runs;
- Node/V8 startup under the verifier sandbox: PASS on prior host runs;
- sixth run: all legacy/manual host files except the two profile-compile feasibility probes passed, giving 6/7 files and 164/166 tests PASS.

Required on the next clean exact SHA before Slice C:

- policy v2 exact trusted `localhost:<port>` Seatbelt filters PASS with no broad localhost;
- child inheritance/non-escape probe PASS;
- exact allocated runtime `127.0.0.1` loopback PASS, LAN peer DENY, production port DENY;
- dedicated raw-hook/Safe-Git host case PASS;
- sensitive path/env and process-group cleanup PASS;
- manual-only manifest contract PASS;
- exact-SHA outer-test receipt issued only after the worktree is clean.

Until those requirements pass:

- Slice C must not start;
- no PR/merge should occur;
- `hostVerification.mode` remains `manual`.
