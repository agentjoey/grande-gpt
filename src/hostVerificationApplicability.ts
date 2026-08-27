export const SELF_HOST_REPO_ID = "grande-gpt";

export function isHostVerificationApplicable(repoId: string): boolean {
  return repoId === SELF_HOST_REPO_ID;
}
