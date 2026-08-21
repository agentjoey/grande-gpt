# Host verifier feasibility gate — 2026-08-21

This document records the real-host evidence for Slice B of the reliability/automated host verifier work. It is evidence, not a substitute for the approved design/spec.

## Original feasibility failures and root causes

The first host verifier feasibility implementation deliberately stopped at the Human Gate when macOS Seatbelt behavior did not match the original assumptions.

Observed sequence on the real trusted host:

1. Node/V8 startup inside the verifier failed until read-only `sysctl-read` was added. No process/file/network permission was broadened.
2. `/var` versus `/private/var` aliasing caused policy/runtime path mismatch; verifier paths were canonicalized instead of broadening file permissions.
3. Child creation required `process-fork`; exact executable allowlisting remained in force and broad signal permission was not added.
4. The initial LAN probe accidentally targeted the same machine's non-loopback interface. It was replaced with a distinct same-subnet peer candidate, after which LAN/non-loopback deny was proven.
5. Recursive `sandbox-exec` never produced a valid inner nominal-allow result: both branches exited 71. Canonical executable spelling did not change this. The target host therefore cannot use recursive Seatbelt application as a required proof.
6. Broad localhost outbound plus a single production-port carve-out did not work reliably: the distinct LAN peer was denied, but `127.0.0.1:8787` remained reachable under both `remote ip` and TCP-specific narrow deny attempts.

These were treated as platform constraints rather than reasons to weaken the sandbox.

## Owner-approved platform amendment

The Owner approved the following replacement design:

- prove one outer verifier Seatbelt boundary plus ordinary-child inheritance/non-escape instead of recursive Seatbelt success;
- classify host cases that inherently require a second Seatbelt boundary as `manualOnly` Human Gates when those surfaces change;
- remove broad `localhost:*` capability;
- let the trusted parent preallocate a bounded set of exact loopback ports before sandbox launch;
- compile only those exact ports into the profile and keep the production Gateway port out of the allocation so deny-default protects it;
- bind the runtime allocation into later verifier execution-plan/receipt identity.

The approved amendment is recorded in:

- `docs/superpowers/specs/2026-08-21-grande-gpt-reliability-host-verifier-platform-amendment.md`
- `docs/superpowers/plans/2026-08-21-host-verifier-platform-amendment.md`

## Amended B2R implementation evidence

The approved amendment was implemented and validated incrementally:

- `TRUSTED_HOST_MANIFEST` records `execution: "auto" | "manualOnly"`; recursive-Seatbelt/runner/e2e/verifier-feasibility adapters are manual-only, while the real Git-hook proof is isolated in a dedicated auto-safe host file. The planner fails closed to `full + manualOnlyRequired` for sandbox/SBPL/verifier-policy surfaces.
- `HOST_VERIFIER_POLICY_VERSION` is `2`. Trusted internal input supplies at most eight unique exact loopback ports and rejects invalid, duplicate, or production-port entries. No `localhost:*`, network range, broad network rule, arbitrary argv/cwd/env input, directory-wide process-exec, broad signal permission, or inherited credential/proxy state was introduced.
- The scrubbed verifier environment exposes only the already-validated allocation through `GRANDE_VERIFIER_LOOPBACK_PORTS`; it cannot introduce a port not already present in the trusted Seatbelt profile.
- The feasibility harness allocates a loopback port on the trusted host before constructing the profile. Its inheritance probe starts one outer verifier Seatbelt and then an ordinary Node child; the child must retain allowed fixture/job-temp behavior while DB and LAN access remain denied.
- The future auto-safe server listener harness currently has a legacy fixed port. The C2 amendment explicitly requires it to consume only trusted parent allocated ports from `GRANDE_VERIFIER_LOOPBACK_PORTS`; this remains a Slice C orchestrator integration requirement.

### Real-host SBPL syntax correction

The sixth real-host run reached Seatbelt profile compilation and failed only because exact network filters used `127.0.0.1:<port>` in `local ip` / `remote ip`. The host returned:

`sandbox-exec: host must be * or localhost in network address`

The implementation therefore uses Seatbelt's accepted exact selector spelling `localhost:<trusted-port>`, while the actual test listener/connect target remains runtime IPv4 loopback `127.0.0.1`. This is a syntax correction only: the allocation is still exact-port, `localhost:*` remains forbidden, and the production port cannot enter the allocation.

The corresponding RED was `job_e4e360aa-2a3c-44ba-ab33-4e5223200f68`. After the minimal correction, `unit-selfhost` passed 78 files / 730 tests in `job_f259c727-2baf-490d-afcb-90cbc3117950` and typecheck passed in `job_489321b1-af62-4b2d-9bdc-88827679978e`. The clean implementation commit was `f210886818d5b4d13db056130081556cd8e39c6b`, with local attestation `att_ec9b3cf7-249d-4a5f-9b05-e12d99adc104`.

## Final Slice B real-host gate — PASS

The Owner executed the approved manual real-host outer-test against exact clean commit:

`f210886818d5b4d13db056130081556cd8e39c6b`

Result:

- Test Files: **7 passed / 7**
- Tests: **166 passed / 166**
- outer-test exit: **0**
- trusted host receipt recorded for exact commit `f210886818d5b4d13db056130081556cd8e39c6b`

The run included the legacy/manual-only host suites and the amended verifier feasibility probes. In particular it proved, on the real host:

- one outer verifier Seatbelt can start and ordinary child processes inherit the sandbox boundary without escaping it;
- trusted exact loopback allocation works without broad localhost capability;
- runtime loopback `127.0.0.1:<allocated-port>` succeeds while LAN/non-loopback and the production Gateway port remain denied by default;
- the real raw Git hook executes normally and the same hook is suppressed by Safe Git;
- sensitive control/workspace/canonical/task/DB/credential paths and inherited secret/proxy/SSH-agent state remain inaccessible;
- timeout/process-group cleanup leaves no residual orphan;
- all existing host runner/tools/server/e2e behavior remains green.

## Gate conclusion

**Slice B feasibility gate: PASS.**

There is no remaining Slice B Human Gate. Slice C may proceed from the next clean task HEAD.

The following activation constraint remains unchanged:

- `hostVerification.mode` stays `manual` throughout implementation;
- no automatic production activation is allowed without the separately required soak evidence and explicit Owner approval.
