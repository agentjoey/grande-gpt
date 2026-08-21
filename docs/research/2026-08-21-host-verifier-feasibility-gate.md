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

A minimal regression test was added requiring `(allow sysctl-read)` while still forbidding `process-fork` and broad signal permissions. RED was observed in `job_93fc0b9a-c066-4af5-b56d-4bea1719a97b`; adding only `sysctl-read` restored `unit-selfhost` and `typecheck` and was committed as `9506e33f3c0cea5b4e2a894c9130ff6b08cfa878`.

### Second real-host run

The failure signature changed: Node now started normally (`status=1` instead of `null`) but reported `MODULE_NOT_FOUND` for probe scripts under `/var/folders/...`.

Root cause: `tmpdir()` produced `/var/...` paths, while the verifier policy was deliberately constructed from `realpathSync(...)` paths under `/private/var/...`. Seatbelt matches the path spelling used at runtime against profile paths; the probe passed the non-canonical `/var/...` script path to Node while only `/private/var/...` was allowed.

The probe fixture was corrected to canonicalize source/dependency/job-temp paths immediately after creation and to use those exact paths for policy construction, cwd, script argv, and probe files. No file-read or execution permission was broadened. That correction was committed as `f2e718ebf1b396c1b11007361b8d6d0ebcb99038`.

### Third real-host run

The canonical-path correction worked: the sensitive-path/environment probe passed, and the remaining failures were reduced to two actual policy/probe semantics.

1. The nested Seatbelt script entered Node successfully, but its inner `spawnSync()` produced no child stdout. The verifier policy allowed exact executable targets but still denied `process-fork`; child creation is required both by the nested probe and by the eventual fixed Vitest runner. A RED unit contract requiring `process-fork` was observed in `job_4896bd22-d492-44a0-9bb8-64741f19dbd9`. The implementation now permits `process-fork` while retaining exact-file `process-exec` and still denying broad signal permission. Fresh selfhost after the change is `78 files / 726 tests PASS` (`job_63e1cb33-0a49-405e-ba11-6f3055dd015d`); typecheck PASS is `job_1b46b0bd-4f7a-4e1a-8e3e-138d060c3af1`.
2. The network probe connected successfully to the machine's own non-loopback interface address. That destination is still the local machine and therefore is not a valid proof of reaching an external LAN peer under Seatbelt's `localhost` semantics. The probe now derives a same-subnet IPv4 address that is neither loopback nor any local interface address and requires that connection attempt to fail with a Seatbelt permission error. Loopback success and the explicit production-port deny remain separate assertions.

No generic host execution, directory-wide process-exec, broad signal permission, arbitrary argv/cwd, or wider filesystem/network rule was added by these changes.

The fork and remote-LAN probe corrections were committed as `20064b6a5d27ad41ab44c831242dedc960ff3e62`. A fresh clean-HEAD regression on that exact commit then passed `unit-selfhost` (`78 files / 726 tests`, `job_24ca661e-c1f7-4d9b-99d5-0381ce519604`) and `typecheck` (`job_05766b5f-5986-41c7-9985-68068dfbe607`). The commit itself lacked an attestation only because this evidence document had been edited after the immediately preceding run; the next evidence commit therefore used the correct `edit -> verify -> commit` order rather than an empty commit.

### Fourth real-host run

The fork and remote-LAN changes improved the evidence again: the distinct same-subnet LAN peer assertion passed, as did the sensitive-path/environment, Git hook, and process-group probes. Two failures remained.

1. Nested Seatbelt now spawned `/usr/bin/sandbox-exec`, but both inner `cat` invocations exited `71`; the nominal allow branch did not reach the file read. The outer verifier grants `process-exec` only to canonical executable literals, while the inner probe still hard-coded `/bin/cat`. This is the same class of path-spelling hazard already proven by the `/var` versus `/private/var` failure. The probe was changed to pass the canonical executable path, without adding executable permission.
2. The production Gateway connection to `127.0.0.1:8787` still succeeded even though LAN/non-loopback was denied. The previous carve-out used `(remote ip "localhost:8787")`; the real host proved that this filter did not override the broader `(remote ip "localhost:*")` allow for this TCP connection. A TCP-specific deny was tried next. A RED unit contract for that exact policy shape was observed in `job_b70b68c1-1815-46d9-a4e0-a0bdbc321d06`.

After those two corrections, sandboxed `unit-selfhost` returned to `78 files / 726 tests PASS` in `job_8b9829ed-526c-43a7-804c-472f908600a2`. The final attestation-bound verification was then run and committed as `7cbffa73c7ce6a0d508abd2afaa19545467633fb` with attestation `att_419a6dce-5d9a-4a09-b2bb-08591cfadab3`.

### Fifth real-host run — design-level blocker

The two remaining failures were unchanged on exact SHA `7cbffa73c7ce6a0d508abd2afaa19545467633fb`:

1. The nested `sandbox-exec` nominal allow branch still exited `71`, while the denied branch also exited `71`. Canonical executable paths did not address the root cause. A process already under Seatbelt cannot reliably apply a second Seatbelt profile on the target host; recursive `sandbox-exec` is therefore not a valid required proof.
2. The distinct LAN peer remained denied correctly, but `127.0.0.1:8787` still connected successfully even with the TCP-specific deny rule. The target macOS behavior therefore cannot support broad localhost allow plus a reliable one-port carve-out.

These are platform/design constraints, not reasons to weaken assertions. No further policy widening or test neutralization is permitted.

### Human Owner decision

On 2026-08-21 the Human Owner approved the platform amendment:

- replace recursive nested-Seatbelt success with child inheritance/non-escape under one outer Seatbelt boundary;
- replace broad ephemeral localhost with trusted parent allocation of exact loopback ports, so the production Gateway port is absent from the allowlist by construction;
- recursive-Seatbelt host cases are a predefined `manualOnly` Human Gate and cannot be represented as auto-safe coverage;
- bump verifier policy version to 2 and bind exact runtime port allocation into the trusted execution-plan/receipt digest.

The approved design and executable plan are:

- `docs/superpowers/specs/2026-08-21-grande-gpt-reliability-host-verifier-platform-amendment.md`
- `docs/superpowers/plans/2026-08-21-host-verifier-platform-amendment.md`

### Amended B2R implementation evidence

The approved amendment is now implemented at the unit/type boundary pending fresh real-host proof:

- `TRUSTED_HOST_MANIFEST` now records `execution: "auto" | "manualOnly"`; recursive-Seatbelt/runner/e2e/verifier-feasibility adapters are manual-only, while the real Git-hook proof is split into a dedicated auto-safe host file. The planning helper fails closed to `full + manualOnlyRequired` for sandbox/SBPL/verifier-policy surfaces. RED was observed in `job_e899e4c8-1792-406a-acaa-2851acaa4e48`; GREEN reached 78 files / 729 tests in `job_bc9027da-9f03-4be9-aa61-314cb414c275`.
- `HOST_VERIFIER_POLICY_VERSION` is now `2`. The verifier profile no longer contains broad `localhost:*`; trusted internal input supplies at most eight unique exact IPv4 loopback ports, rejects invalid/duplicate/production-port entries, and emits bind/inbound/outbound allows only for `127.0.0.1:<trusted-port>`. RED was observed in `job_ccddf90e-7bb6-420f-a2b4-6c3177b11953`; GREEN reached 78 files / 730 tests in `job_05bb3362-f7af-4259-8827-4a23d2e4ed3e`.
- The real-host feasibility harness now allocates a loopback port on the trusted host before constructing the profile. Its inheritance probe starts one outer verifier Seatbelt and then an ordinary child Node process; the child must retain allowed fixture/job-temp behavior while DB and LAN access remain denied. The network probe binds/connects only the trusted exact port, while LAN and production Gateway destinations remain unlisted and therefore denied by default.
- The scrubbed verifier environment exposes only the already-validated trusted allocation through `GRANDE_VERIFIER_LOOPBACK_PORTS`; it is not inherited from the host and cannot introduce a port not already present in the Seatbelt profile. The corresponding RED was `job_0ba33710-b235-4062-a97b-574c3d441972`; after adding the trusted env projection, `unit-selfhost` passed 78 files / 730 tests in `job_cf4005da-d039-42fc-a2e1-a37ca2ee7f4c` and typecheck passed in `job_df552a4d-42c0-4c45-a86d-ed4b9830cddb`.
- A security review identified that the future auto-safe server listener harness currently uses a legacy fixed port. The C2 amendment now explicitly requires auto-safe listener cases to consume only `GRANDE_VERIFIER_LOOPBACK_PORTS` from the trusted parent allocation; this is a Slice C orchestrator integration requirement and does not weaken the B feasibility gate.

No generic host execution, arbitrary argv/cwd/env input, directory-wide process-exec, broad signal permission, inherited credential/proxy state, broad localhost rule, or production-port allow was introduced by B2R.

## Current gate state

The previous design-level blocker is **resolved by Owner approval** and the amended implementation is **unit/type GREEN**, but Slice B is **not yet PASS** until the clean exact-SHA real-host run succeeds.

Already proven and retained:

- Safe Git hook suppression: PASS on prior host runs; now isolated into its own trusted host case for fresh rerun;
- remote LAN/non-loopback deny under deny-default: PASS on prior host runs;
- sensitive control/workspace/canonical/task/DB/credential/env isolation: PASS on prior host runs;
- timeout process-group cleanup with no residual orphan: PASS on prior host runs;
- Node/V8 startup under the verifier sandbox: PASS on prior host runs.

Required on the next clean exact SHA before Slice C:

- policy v2 exact trusted loopback allocation PASS with no broad localhost;
- child inheritance/non-escape probe PASS;
- exact allocated loopback port PASS, LAN peer DENY, production port DENY;
- dedicated raw-hook/Safe-Git host case PASS;
- sensitive path/env and process-group cleanup PASS;
- manual-only manifest contract PASS;
- exact-SHA outer-test receipt issued only after the worktree is clean.

Until those amended requirements pass:

- Slice C must not start;
- no PR/merge should occur;
- `hostVerification.mode` remains `manual`.
