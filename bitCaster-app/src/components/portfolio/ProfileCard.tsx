import type { UserProfile } from "@/types/portfolio";
import { IdentityProfile } from "@/components/shared/IdentityProfile";

import type { NostrProfileFetchStatus } from "@/types/settings";

export function ProfileCard({
  profile,
  status,
}: {
  profile: UserProfile;
  status?: NostrProfileFetchStatus;
}) {
  return <IdentityProfile profile={profile} status={status} />;
}
