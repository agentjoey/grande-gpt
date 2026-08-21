import { dirname, isAbsolute, sep } from "node:path";

export const HOST_VERIFIER_POLICY_VERSION = 2;

export interface HostVerifierSandboxPaths {
  verifierWorktree: string;
  dependencyRoots: readonly string[];
  jobTmp: string;
  controlRoot: string;
  workspaceRoot: string;
  canonicalRepo: string;
  taskWorktree: string;
  databasePath: string;
  toolchainReadRoots: readonly string[];
  executableFiles: readonly string[];
  productionPort: number;
  loopbackPorts: readonly number[];
}

export interface HostVerifierSandboxPlan {
  policyVersion: number;
  profile: string;
  env: Readonly<Record<string, string>>;
}

function q(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function isUnder(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

function overlaps(a: string, b: string): boolean {
  return isUnder(a, b) || isUnder(b, a);
}

function assertAbsolute(label: string, value: string): void {
  if (!isAbsolute(value)) throw new Error(`${label} must be absolute: ${value}`);
}

function validatePort(label: string, port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${label} out of range: ${port}`);
  }
}

function ancestors(path: string): string[] {
  const result: string[] = [];
  let current = dirname(path);
  while (current !== "/" && current !== "." && current !== dirname(current)) {
    result.push(current);
    current = dirname(current);
  }
  return result;
}

function validatePaths(input: HostVerifierSandboxPaths): void {
  const scalarPaths = [
    ["verifierWorktree", input.verifierWorktree],
    ["jobTmp", input.jobTmp],
    ["controlRoot", input.controlRoot],
    ["workspaceRoot", input.workspaceRoot],
    ["canonicalRepo", input.canonicalRepo],
    ["taskWorktree", input.taskWorktree],
    ["databasePath", input.databasePath],
  ] as const;
  for (const [label, value] of scalarPaths) assertAbsolute(label, value);
  input.dependencyRoots.forEach((value, index) => assertAbsolute(`dependencyRoots[${index}]`, value));
  input.toolchainReadRoots.forEach((value, index) => assertAbsolute(`toolchainReadRoots[${index}]`, value));
  input.executableFiles.forEach((value, index) => assertAbsolute(`executableFiles[${index}]`, value));

  if (input.dependencyRoots.length === 0) throw new Error("dependencyRoots must not be empty");
  if (input.toolchainReadRoots.length === 0) throw new Error("toolchainReadRoots must not be empty");
  if (input.executableFiles.length === 0) throw new Error("executableFiles must not be empty");
  validatePort("production port", input.productionPort);
  if (input.loopbackPorts.length > 8) throw new Error(`too many verifier loopback ports: ${input.loopbackPorts.length}`);
  const seenPorts = new Set<number>();
  for (const port of input.loopbackPorts) {
    validatePort("verifier loopback port", port);
    if (port === input.productionPort) {
      throw new Error(`verifier loopback port must not equal production port: ${port}`);
    }
    if (seenPorts.has(port)) throw new Error(`duplicate verifier loopback port: ${port}`);
    seenPorts.add(port);
  }

  if (overlaps(input.verifierWorktree, input.jobTmp)) {
    throw new Error("verifier source/job temp overlap would make candidate source writable");
  }
  for (const root of input.dependencyRoots) {
    if (overlaps(root, input.jobTmp)) {
      throw new Error("dependency/job temp overlap would make trusted dependencies writable");
    }
  }

  const sensitive = [
    ["control", input.controlRoot],
    ["workspace", input.workspaceRoot],
    ["canonical", input.canonicalRepo],
    ["task worktree", input.taskWorktree],
  ] as const;
  for (const [label, root] of sensitive) {
    if (overlaps(root, input.verifierWorktree)) {
      throw new Error(`verifier source overlaps sensitive ${label} root`);
    }
    for (const dep of input.dependencyRoots) {
      if (overlaps(root, dep)) throw new Error(`dependency root overlaps sensitive ${label} root`);
    }
    if (label !== "control" && overlaps(root, input.jobTmp)) {
      throw new Error(`job temp overlaps sensitive ${label} root`);
    }
    for (const toolRoot of input.toolchainReadRoots) {
      if (overlaps(root, toolRoot)) throw new Error(`toolchain root overlaps sensitive ${label} root`);
    }
  }

  for (const executable of input.executableFiles) {
    if (!input.toolchainReadRoots.some((root) => isUnder(root, executable))) {
      throw new Error(`executable is outside trusted toolchain read roots: ${executable}`);
    }
  }
}

/**
 * Builds the verifier's fixed Seatbelt policy and scrubbed environment.
 *
 * This function deliberately has no argv/cwd/profile/environment input. The later
 * orchestrator may choose only task/repo/commit/level; executable entry points and paths
 * are resolved by trusted control-plane code before reaching this boundary.
 */
export function buildHostVerifierSandboxPlan(input: HostVerifierSandboxPaths): HostVerifierSandboxPlan {
  validatePaths(input);

  const metadataPaths = [...new Set([
    ...ancestors(input.verifierWorktree),
    ...input.dependencyRoots.flatMap(ancestors),
    ...ancestors(input.jobTmp),
    ...input.toolchainReadRoots.flatMap(ancestors),
  ])];
  const execDirs = [...new Set(input.executableFiles.map(dirname))];

  const profile = [
    "(version 1)",
    "(deny default)",
    "(deny network*)",
    "",
    ";; Minimal runtime reads. Sensitive project/control roots are explicitly denied below.",
    '(allow file-read* (literal "/"))',
    '(allow file-read* file-write* (literal "/dev/null"))',
    '(allow file-read* (subpath "/System"))',
    '(allow file-read* (subpath "/etc"))',
    '(allow file-read* (subpath "/private/etc"))',
    '(allow file-read* (subpath "/private/var/select"))',
    ...metadataPaths.map((path) => `(allow file-read-metadata (literal "${q(path)}"))`),
    ...input.toolchainReadRoots.map((path) => `(allow file-read* (subpath "${q(path)}"))`),
    ";; Node/V8 reads host sysctl metadata (for example CPU topology) during startup.",
    ";; This is read-only host metadata; it does not grant process creation, signals, or filesystem access.",
    "(allow sysctl-read)",
    ";; Fixed test runners need child processes, while exec targets remain exact-file allowlisted below.",
    "(allow process-fork)",
    "",
    ";; Explicit real-host denies. These stay visible even though deny-default already applies.",
    `(deny file-read* file-write* (subpath "${q(input.controlRoot)}"))`,
    `(deny file-read* file-write* (subpath "${q(input.workspaceRoot)}"))`,
    `(deny file-read* file-write* (subpath "${q(input.canonicalRepo)}"))`,
    `(deny file-read* file-write* (subpath "${q(input.taskWorktree)}"))`,
    `(deny file-read* file-write* (subpath "${q(input.databasePath)}"))`,
    "",
    ";; Exact disposable source/dependencies are read-only; only per-job temp is writable.",
    `(allow file-read* (subpath "${q(input.verifierWorktree)}"))`,
    ...input.dependencyRoots.map((path) => `(allow file-read* (subpath "${q(path)}"))`),
    `(allow file-read* (subpath "${q(input.jobTmp)}"))`,
    `(allow file-write* (subpath "${q(input.jobTmp)}"))`,
    "",
    ";; Exact executable allowlist: process-fork permits child creation, not arbitrary exec targets.",
    ...input.executableFiles.map((path) => `(allow process-exec (literal "${q(path)}"))`),
    "",
    ";; Trusted parent allocates exact IPv4 loopback ports before sandbox launch; all others remain denied.",
    ...input.loopbackPorts.flatMap((port) => [
      `(allow network-bind (local ip "127.0.0.1:${port}"))`,
      `(allow network-inbound (local ip "127.0.0.1:${port}"))`,
      `(allow network-outbound (remote ip "127.0.0.1:${port}"))`,
    ]),
    "",
  ].join("\n");

  const env = Object.freeze({
    PATH: execDirs.join(":"),
    HOME: `${input.jobTmp}/home`,
    LANG: "en_US.UTF-8",
    TMPDIR: `${input.jobTmp}/tmp`,
    XDG_CACHE_HOME: `${input.jobTmp}/cache`,
    CI: "1",
    GRANDE_VERIFIER_LOOPBACK_PORTS: input.loopbackPorts.join(","),
  });

  return { policyVersion: HOST_VERIFIER_POLICY_VERSION, profile, env };
}
