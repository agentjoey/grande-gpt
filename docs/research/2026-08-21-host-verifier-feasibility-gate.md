# Host Verifier Feasibility Gate — 2026-08-21

Task: `task-reliability-hostverifier-20260821-001`

## Gate purpose

Slice B requires real trusted-host evidence for four load-bearing properties before Slice C is allowed:

1. nested Seatbelt produces a true inner allow/deny result;
2. a real Git hook executes without Safe Git overrides and is suppressed by Safe Git;
3. ephemeral loopback works while LAN/non-loopback and the production Gateway port are denied;
4. timeout kills the whole process group with no residual orphan.

The trusted host suite also contains negative probes for control/workspace/canonical/task/DB/credential-store reads and inherited credential/proxy/SSH state.

## Evidence history

### Initial real-host run

The existing host suites passed, but three new `runVerifierNode()` probes failed before their assertions ran. All three returned `status=null` with:

`[low_level_alloc.cc : 437] RAW: Check sum >= a failed: LowLevelAlloc arithmetic overflow`

The common path was the new verifier SBPL launching Node. The established sandbox profile already allowed `sysctl-read`, and prior Seatbelt research records that Node/V8 startup uses sysctl reads and can otherwise fail with misleading startup errors.

A minimal regression test was added requiring `(allow sysctl-read)` while still forbidding `process-fork` and broad signal permissions. RED was observed in `job_93fc0b9a-c066-4af5-b56d-4bea1719a97b`; adding only `sysctl-read` restored `unit-selfhost` and `typecheck` and was committed as `9506e33f3c0cea5b4e2a894c9130ff6b08cfa878`.

### Second real-host run

The failure signature changed: Node now started normally (`status=1` instead of `null`) but reported `MODULE_NOT_FOUND` for probe scripts under `/var/folders/...`.

Root cause: `tmpdir()` produced `/var/...` paths, while the verifier policy was deliberately constructed from `realpathSync(...)` paths under `/private/var/...`. Seatbelt matches runtime path spelling against profile paths; the probe passed the non-canonical `/var/...` script path to Node while only `/private/var/...` was allowed.

The probe fixture was corrected to canonicalize source/dependency/job-temp paths immediately after creation and to use those exact paths for policy construction, cwd, script argv, and probe files. No file-read or execution permission was broadened.

## Current gate state

The four real-host properties are **not yet claimed PASS** after the canonical-path fix. A fresh trusted-host run against the new clean exact SHA is still required. Until that run passes:

- Slice C must not start;
- merge must not occur;
- `hostVerification.mode` remains `manual`.
