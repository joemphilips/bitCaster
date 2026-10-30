import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, X } from "lucide-react";
import {
  BrowserProfileError,
  type BrowserProfileEditView,
  type BrowserProfileSaveResult,
} from "@/lib/browserNostrProfile";
import type { NostrProfilePatch } from "@bitcaster/client-sdk/nostrProfile";
import { NostrMediaUploadError } from "@bitcaster/client-sdk/nostrMediaUpload";
import {
  uploadBrowserNostrProfileImage,
  type BrowserProfileImageReceipt,
} from "@/lib/browserNostrProfileMedia";
import { assertNever } from "@/lib/enumDiscipline";

export interface NostrProfileEditorProps {
  readonly upload?: typeof uploadBrowserNostrProfileImage;
  readonly editing?: boolean;
  readonly onEditEnd?: () => void;
  readonly load: (signal: AbortSignal) => Promise<BrowserProfileEditView>;
  readonly save: (
    patch: NostrProfilePatch,
    signal: AbortSignal,
  ) => Promise<BrowserProfileSaveResult>;
}

const fields = ["name", "about", "picture"] as const;
type EditableField = (typeof fields)[number];
const emptyFields = { name: "", about: "", picture: "" };

function saveMessage(result: BrowserProfileSaveResult): string {
  switch (result.status) {
    case "saved":
      return "profileEditSaved";
    case "not-acknowledged":
      return "profileEditNotAcknowledged";
    case "published-retention-failed":
      return "profileEditRetentionFailed";
    case "selection-changed":
      return "profileEditSelectionChanged";
    case "cancelled":
      return result.published ? "profileEditCancelledPublished" : "profileEditCancelled";
    default:
      return assertNever(result.status);
  }
}

export function NostrProfileEditor({
  load,
  save,
  upload = uploadBrowserNostrProfileImage,
  editing = true,
  onEditEnd,
}: NostrProfileEditorProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(emptyFields);
  const baseline = useRef(emptyFields);
  const dirty = useRef(new Set<EditableField>());
  const [busy, setBusy] = useState<"loading" | "saving" | "uploading" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [result, setResult] = useState<BrowserProfileSaveResult | null>(null);
  const operation = useRef<AbortController | null>(null);
  const operationKind = useRef<"loading" | "saving" | "uploading" | null>(null);
  const mounted = useRef(true);
  const imageReceipt = useRef<BrowserProfileImageReceipt | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const releaseImageReceipt = () => {
    imageReceipt.current?.dispose();
    imageReceipt.current = null;
  };

  const showError = (error: unknown) => {
    setResult(null);
    if (error instanceof NostrMediaUploadError) setMessage(`profileImageError.${error.code}`);
    else if (error instanceof BrowserProfileError) setMessage(`profileEditError.${error.code}`);
    else setMessage("profileEditError.cache-unavailable");
  };
  const reload = async () => {
    if (operation.current) return;
    const controller = new AbortController();
    operation.current = controller;
    operationKind.current = "loading";
    setBusy("loading");
    try {
      const view = await load(controller.signal);
      if (!mounted.current || operation.current !== controller) return;
      baseline.current = { ...view.fields };
      setDraft(
        (previous) =>
          Object.fromEntries(
            fields.map((field) => [
              field,
              dirty.current.has(field) ? previous[field] : view.fields[field],
            ]),
          ) as typeof emptyFields,
      );
    } catch (error) {
      if (mounted.current && operation.current === controller) showError(error);
    } finally {
      if (operation.current === controller) {
        operation.current = null;
        operationKind.current = null;
        if (mounted.current) setBusy(null);
      }
    }
  };
  useEffect(() => {
    mounted.current = true;
    if (editing) void reload();
    return () => {
      mounted.current = false;
      releaseImageReceipt();
      operation.current?.abort();
      operation.current = null;
      operationKind.current = null;
    };
    // The parent keys this editor by signer mode and revision. Drafts stay with that identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  const change = (field: EditableField, value: string) => {
    if (field === "picture") releaseImageReceipt();
    if (value === baseline.current[field]) dirty.current.delete(field);
    else dirty.current.add(field);
    setDraft((previous) => ({ ...previous, [field]: value }));
  };
  const uploadImage = async (file: File) => {
    if (operation.current) return;
    const controller = new AbortController();
    operation.current = controller;
    operationKind.current = "uploading";
    setBusy("uploading");
    setMessage(null);
    setResult(null);
    try {
      const receipt = await upload(file, controller.signal);
      if (!mounted.current || operation.current !== controller || controller.signal.aborted) {
        receipt.dispose();
        return;
      }
      try {
        receipt.requireCurrent();
      } catch (error) {
        receipt.dispose();
        throw error;
      }
      change("picture", receipt.url);
      imageReceipt.current = receipt;
    } catch (error) {
      if (mounted.current && operation.current === controller && !controller.signal.aborted)
        showError(error);
    } finally {
      if (operation.current === controller) {
        operation.current = null;
        operationKind.current = null;
        if (mounted.current) setBusy(null);
      }
    }
  };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (operation.current || dirty.current.size === 0) return;
    const patch = Object.fromEntries([...dirty.current].map((field) => [field, draft[field]]));
    const controller = new AbortController();
    operation.current = controller;
    operationKind.current = "saving";
    setBusy("saving");
    setResult(null);
    setMessage(null);
    try {
      imageReceipt.current?.requireCurrent();
      const signal = imageReceipt.current
        ? AbortSignal.any([controller.signal, imageReceipt.current.signal])
        : controller.signal;
      const saved = await save(patch, signal);
      if (!mounted.current || operation.current !== controller) return;
      setResult(saved);
      setMessage(saveMessage(saved));
      if (saved.status === "saved") {
        baseline.current = { ...draft };
        dirty.current.clear();
        onEditEnd?.();
      }
    } catch (error) {
      if (mounted.current && operation.current === controller) showError(error);
    } finally {
      if (operation.current === controller) {
        operation.current = null;
        operationKind.current = null;
        if (mounted.current) setBusy(null);
      }
    }
  };

  return (
    <>
      {editing && (
        <form
          data-testid="nostr-profile-editor"
          onSubmit={(event) => void submit(event)}
          className="mt-5 space-y-3 rounded-lg border border-slate-200 p-4 dark:border-slate-700"
        >
          <h4 className="font-semibold text-slate-900 dark:text-white">
            {t("settings.profileEditTitle")}
          </h4>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {t("settings.profileEditHint")}
          </p>
          {fields.map((field) => {
            const label = t(`settings.profileEditFields.${field}`);
            const inputProps = {
              id: `nostr-profile-${field}`,
              "data-testid": `nostr-profile-${field}`,
              value: draft[field],
              disabled: busy !== null,
              onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
                change(field, event.target.value),
              className:
                "mt-1 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-900 dark:border-slate-600 dark:bg-slate-700/50 dark:text-white disabled:opacity-60",
            };
            return (
              <div key={field}>
                <label
                  htmlFor={inputProps.id}
                  className="text-sm font-medium text-slate-700 dark:text-slate-300"
                >
                  {label}
                </label>
                {field === "picture" && (
                  <div
                    data-testid="profile-image-drop"
                    className="my-2 rounded-lg border border-dashed border-slate-300 p-3 dark:border-slate-600"
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => {
                      event.preventDefault();
                      if (busy !== null) return;
                      if (event.dataTransfer.files.length !== 1) {
                        setResult(null);
                        setMessage("profileImageError.invalid-image");
                        return;
                      }
                      void uploadImage(event.dataTransfer.files[0]!);
                    }}
                  >
                    {draft.picture.startsWith("https://") && (
                      <img
                        src={draft.picture}
                        alt={t("settings.profileImagePreview")}
                        referrerPolicy="no-referrer"
                        className="mb-2 h-16 w-16 rounded-full object-cover"
                      />
                    )}
                    <input
                      ref={fileInput}
                      aria-label={t("settings.profileImageChoose")}
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      disabled={busy !== null}
                      className="hidden"
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        event.target.value = "";
                        if (file) void uploadImage(file);
                      }}
                    />
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => fileInput.current?.click()}
                      className="rounded-lg border px-3 py-2 text-sm disabled:opacity-50"
                    >
                      {t("settings.profileImageChoose")}
                    </button>
                    <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                      {t("settings.profileImageHint")}
                    </p>
                    {busy === "uploading" && (
                      <p role="status">{t("settings.profileImageUploading")}</p>
                    )}
                  </div>
                )}
                {field === "about" ? (
                  <textarea {...inputProps} rows={3} />
                ) : (
                  <input {...inputProps} type="text" />
                )}
              </div>
            );
          })}
          <div className="flex flex-wrap items-center gap-2">
            <button
              data-testid="nostr-profile-save"
              type="submit"
              disabled={busy !== null || dirty.current.size === 0}
              className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              {t("settings.profileEditSave")}
            </button>
            <button
              data-testid="nostr-profile-reload"
              type="button"
              onClick={() => void reload()}
              disabled={busy !== null}
              className="rounded-lg border border-slate-200 px-3 py-2 text-sm dark:border-slate-600"
            >
              {t("settings.profileEditReload")}
            </button>
            <button
              data-testid="nostr-profile-cancel"
              type="button"
              onClick={() => {
                if (operation.current) {
                  operation.current.abort();
                  if (operationKind.current === "uploading") {
                    setMessage("profileImageCancelled");
                  } else if (operationKind.current === "loading") {
                    dirty.current.clear();
                    setDraft({ ...baseline.current });
                    onEditEnd?.();
                  }
                } else {
                  releaseImageReceipt();
                  dirty.current.clear();
                  setDraft({ ...baseline.current });
                  onEditEnd?.();
                }
              }}
              className="rounded-lg px-3 py-2 text-sm text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-700"
            >
              {t("settings.profileEditCancel")}
            </button>
          </div>
        </form>
      )}
      {message && (
        <div
          data-testid="nostr-profile-result"
          role={result?.status === "saved" ? "status" : "alert"}
          className="rounded-lg bg-slate-50 p-3 text-sm text-slate-700 dark:bg-slate-700/50 dark:text-slate-200"
        >
          <div className="flex items-start gap-2">
            <p className="min-w-0 flex-1 select-text">{t(`settings.${message}`)}</p>
            <button
              type="button"
              aria-label={t("settings.profileEditDismiss")}
              onClick={() => {
                setMessage(null);
                setResult(null);
              }}
              className="shrink-0 p-1"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          {result && result.status !== "saved" && (
            <p className="mt-2 select-text">
              {t("settings.profileEditDelivery", {
                accepted: result.acceptedRelays.length,
                rejected: result.rejectedRelays.length,
                uncertain: result.unacknowledgedRelays.length,
                unsent: result.unsentRelays.length,
              })}
            </p>
          )}
        </div>
      )}
    </>
  );
}
