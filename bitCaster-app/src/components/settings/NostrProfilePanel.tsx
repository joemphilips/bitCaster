import { useState } from "react";
import { Pencil, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { IdentityProfile } from "@/components/shared/IdentityProfile";
import type { NostrProfile, NostrProfileFetchStatus, SettingsProps } from "@/types/settings";
import { DeferredNostrProfileEditor } from "./DeferredNostrProfileEditor";

interface Props {
  profile: NostrProfile | null;
  status: NostrProfileFetchStatus;
  retry: () => void;
  retrying: boolean;
  load?: SettingsProps["onLoadNostrProfileEdit"];
  save?: SettingsProps["onSaveNostrProfileEdit"];
}

export function NostrProfilePanel({ profile, status, retry, retrying, load, save }: Props) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [opened, setOpened] = useState(false);
  const loading = status === "fetching" || (status === "idle" && !profile);
  return (
    <section aria-label={t("settings.profileTitle")}>
      <IdentityProfile
        status={status}
        profile={{
          displayName: profile?.displayName ?? "",
          avatarUrl: profile?.avatar ?? null,
          bio: profile?.bio,
        }}
        action={
          load && save && !editing ? (
            <button
              type="button"
              data-testid="nostr-profile-edit"
              onClick={() => {
                setOpened(true);
                setEditing(true);
              }}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-blue-600 hover:bg-blue-100 dark:text-blue-400 dark:hover:bg-blue-900/30"
            >
              <Pencil aria-hidden="true" className="h-4 w-4" />
              {t("settings.profileEditAction")}
            </button>
          ) : undefined
        }
      />
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-sm">
        <button
          type="button"
          onClick={retry}
          disabled={retrying || loading}
          className="ml-auto inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-blue-600 hover:bg-blue-50 disabled:opacity-50 dark:text-blue-400 dark:hover:bg-blue-900/20"
        >
          <RefreshCw
            aria-hidden="true"
            className={`h-3.5 w-3.5 ${retrying ? "animate-spin" : ""}`}
          />
          {t("settings.profileRefresh")}
        </button>
      </div>
      {opened && load && save && (
        <DeferredNostrProfileEditor
          load={load}
          save={save}
          editing={editing}
          onEditEnd={() => setEditing(false)}
        />
      )}
    </section>
  );
}
