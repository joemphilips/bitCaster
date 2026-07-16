import type {
  DurableRecipientExactSubmission,
  DurableRecipientSubmissionAuthority,
} from "./durableRecipientSubmission.ts";

const submissionAuthorities = new WeakMap<
  DurableRecipientSubmissionAuthority,
  DurableRecipientExactSubmission
>();

export function issueDurableRecipientSubmissionAuthority(
  binding: DurableRecipientExactSubmission,
): DurableRecipientSubmissionAuthority {
  const authority = Object.freeze({
    kind: "durable-recipient-exact-submission" as const,
  });
  submissionAuthorities.set(authority, binding);
  return authority;
}

export function readDurableRecipientSubmissionAuthorityBinding(
  authority: DurableRecipientSubmissionAuthority,
): DurableRecipientExactSubmission {
  const binding = submissionAuthorities.get(authority);
  if (binding === undefined) {
    throw new Error("durable recipient submission authority is invalid");
  }
  return {
    request: structuredClone(binding.request),
    encodedToken: binding.encodedToken,
  };
}
