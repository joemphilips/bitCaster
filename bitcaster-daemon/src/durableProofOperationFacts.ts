import {
  resolveDurableCustodyProofOperationFacts,
  type ResolveDurableCustodyProofOperationFactsInput,
} from '@bitcaster-market/client-sdk/durableCustodyProofOperation'
import type { DurableProofOperationFacts } from '@bitcaster-market/client-sdk/durableCustody'

export async function resolveDaemonDurableProofOperationFacts(
  input: ResolveDurableCustodyProofOperationFactsInput,
): Promise<DurableProofOperationFacts> {
  return resolveDurableCustodyProofOperationFacts(input)
}
