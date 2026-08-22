export type HostVerifierFailureClass = "candidate" | "infrastructure" | "integrity";

export type HostVerifierIntegrityReason =
  | "receipt_result_binding_mismatch"
  | "policy_rejection"
  | "verifier_identity_mismatch"
  | "sha_mismatch"
  | "unrecognized_verifier_result";

export interface HostVerifierIntegrityFailure {
  failureClass: "integrity";
  reason: HostVerifierIntegrityReason | string;
  jobId: string | null;
}

export function readHostVerifierFailureClass(value: unknown): HostVerifierFailureClass | null {
  return value === "candidate" || value === "infrastructure" || value === "integrity" ? value : null;
}
