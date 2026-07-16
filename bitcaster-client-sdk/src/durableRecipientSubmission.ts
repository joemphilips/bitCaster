import type { DurableRecipientDeliveryRequest } from "./durableRecipientDelivery.ts";
import { readDurableRecipientSubmissionAuthorityBinding } from "./durableRecipientSubmissionAuthority.ts";

export interface DurableRecipientSubmissionAuthority {
  readonly kind: "durable-recipient-exact-submission";
}

export interface DurableRecipientExactSubmission {
  request: DurableRecipientDeliveryRequest;
  encodedToken: string;
}

export function readDurableRecipientSubmissionAuthority(
  authority: DurableRecipientSubmissionAuthority,
): DurableRecipientExactSubmission {
  return readDurableRecipientSubmissionAuthorityBinding(authority);
}
