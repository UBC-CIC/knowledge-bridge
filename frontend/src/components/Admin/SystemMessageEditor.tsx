import { useEffect, useMemo, useState } from "react";
import {
  Bot,
  ChevronLeft,
  ChevronRight,
  CheckCircle2,
  Save,
  Trash2,
  Power,
  Map,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

export type SystemMessageType =
  | "disclaimer"
  | "guardrails"
  | "system_role"
  | "system_checklist"
  | "system_instructions"
  | "initial_prompt"
  | "detective_phase_prompt"
  | "suggestion_phase_prompt"
  | "welcome_message"
  | "partial_hallucination_warning"
  | "full_hallucination_warning";

export type MessagePlacement =
  | "initial_prompt"
  | "role"
  | "phase_detective"
  | "phase_suggestion"
  | "checklist"
  | "instructions"
  | "guardrails"
  | "ui_only";

export type SystemMessageVersion = {
  id: string;
  type: SystemMessageType;
  content: string;
  character_limit: number;
  version: number;
  is_active: boolean;
  affects_text_generation: boolean;
  created_by_email?: string | null;
  created_at?: string;
};

type Props = {
  type: SystemMessageType;
  title: string;
  description?: string;
  placement: MessagePlacement;
  affectsTextGeneration: boolean;
  versions: SystemMessageVersion[];
  adminEmail?: string | null;

  onCreateVersion: (type: SystemMessageType, newVersion: SystemMessageVersion) => void;
  onDeleteVersion: (type: SystemMessageType, versionId: string) => void;
  onActivateVersion: (type: SystemMessageType, versionId: string) => void;
  onSave: (type: SystemMessageType, content: string) => Promise<SystemMessageVersion>;
  onDelete: (type: SystemMessageType, versionId: string) => Promise<void>;
  onActivate: (type: SystemMessageType, versionId: string) => Promise<void>;
};

type PromptPhase = "DETECTIVE" | "SUGGESTION";

const STACK_ROWS: Array<{
  key: string;
  title: string;
  isActive: (placement: MessagePlacement, selectedPhase: PromptPhase) => boolean;
}> = [
  {
    key: "initial_prompt",
    title: "Initial Prompt",
    isActive: (placement) => placement === "initial_prompt",
  },
  {
    key: "role",
    title: "System Role",
    isActive: (placement) => placement === "role",
  },
  {
    key: "phase",
    title: "Phase Prompt",
    isActive: (placement, selectedPhase) =>
      (placement === "phase_detective" && selectedPhase === "DETECTIVE") ||
      (placement === "phase_suggestion" && selectedPhase === "SUGGESTION"),
  },
  {
    key: "checklist",
    title: "System Checklist",
    isActive: (placement) => placement === "checklist",
  },
  {
    key: "instructions",
    title: "System Instructions",
    isActive: (placement) => placement === "instructions",
  },
  {
    key: "allowed_specializations",
    title: "Allowed Specializations",
    isActive: () => false,
  },
  {
    key: "guardrails",
    title: "Guardrails",
    isActive: (placement) => placement === "guardrails",
  },
];

function formatDate(iso?: string) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function nextVersionNumber(list: SystemMessageVersion[]) {
  const maxV = list.reduce((m, v) => Math.max(m, v.version ?? 0), 0);
  return maxV + 1;
}

function defaultAffectsTextGeneration(type: SystemMessageType) {
  return ![
    "disclaimer",
    "welcome_message",
    "partial_hallucination_warning",
    "full_hallucination_warning",
  ].includes(type);
}

function truncatePreview(text?: string, max = 120) {
  const value = (text ?? "").trim();
  if (!value) return "No active content available.";
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function PlacementStack({
  placement,
  selectedPhase,
}: {
  placement: MessagePlacement;
  selectedPhase: PromptPhase;
}) {
  return (
    <div className="space-y-2">
      {STACK_ROWS.map((row, index) => {
        const isPhaseRow = row.key === "phase";
        const title =
          isPhaseRow
            ? selectedPhase === "DETECTIVE"
              ? "Detective Phase Prompt"
              : "Suggestion Phase Prompt"
            : row.title;

        const active = row.isActive(placement, selectedPhase);

        return (
          <div key={row.key}>
            <div
              className={[
                "rounded-lg border px-3 py-3 transition",
                active
                  ? "border-primary bg-primary/10"
                  : "border-gray-200 bg-gray-50",
              ].join(" ")}
            >
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-medium text-sm text-gray-900">{title}</span>
                {active ? (
                  <span className="text-xs rounded-full bg-primary text-white px-2 py-1">
                    This message
                  </span>
                ) : null}
              </div>
            </div>

            {index < STACK_ROWS.length - 1 ? (
              <div className="flex justify-center py-1">
                <div className="h-4 w-px bg-gray-300" />
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export default function SystemMessageEditor({
  type,
  title,
  description,
  placement,
  affectsTextGeneration,
  versions,
  adminEmail,
  onCreateVersion,
  onDeleteVersion,
  onActivateVersion,
  onSave,
  onDelete,
  onActivate,
}: Props) {
  const sorted = useMemo(() => {
    // Active first, then version desc, then created_at desc
    return [...versions].sort((a, b) => {
      if (a.is_active !== b.is_active) return a.is_active ? -1 : 1;
      if ((b.version ?? 0) !== (a.version ?? 0)) return (b.version ?? 0) - (a.version ?? 0);
      const ad = a.created_at ? new Date(a.created_at).getTime() : 0;
      const bd = b.created_at ? new Date(b.created_at).getTime() : 0;
      return bd - ad;
    });
  }, [versions]);

  const [idx, setIdx] = useState(0);
  const current = sorted[idx];

  // draft content for the textarea
  const [draft, setDraft] = useState(current?.content ?? "");
  const [isDirty, setIsDirty] = useState(false);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const [activating, setActivating] = useState(false);

  const [placementOpen, setPlacementOpen] = useState(false);
  const [placementPhase, setPlacementPhase] = useState<PromptPhase>(
    placement === "phase_suggestion" ? "SUGGESTION" : "DETECTIVE"
  );

  // character limit
  const characterLimit = current?.character_limit ?? 700;
  const currentLength = draft.length;
  const remainingCharacters = characterLimit - currentLength;
  const isOverLimit = currentLength > characterLimit;

  useEffect(() => {
    setDraft(current?.content ?? "");
    setIsDirty(false);
    setSaveError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idx, current?.id]);

  useEffect(() => {
    if (placement === "phase_suggestion") {
      setPlacementPhase("SUGGESTION");
    } else if (placement === "phase_detective") {
      setPlacementPhase("DETECTIVE");
    }
  }, [placement]);

  const canPrev = idx > 0;
  const canNext = idx < sorted.length - 1;

  // Only allow edits when viewing the active version
  const canEdit = !!current?.is_active;

  const handleSave = async () => {
    const trimmed = (draft ?? "").trim();

    if (!trimmed) return;
    if (trimmed.length > characterLimit) {
      setSaveError(`Message exceeds the ${characterLimit}-character limit.`);
      return;
    }

    setSaving(true);
    setSaveError(null);

    try {
      // should return the newly created active version
      const created = await onSave(type, trimmed);

      onCreateVersion(type, created);
      setIdx(0);
      setIsDirty(false);
    } catch (e) {
      console.error(e);

      // fallback
      const localVersion: SystemMessageVersion = {
        id: `local-${type}-v${nextVersionNumber(sorted)}-${Date.now()}`,
        type,
        content: trimmed,
        character_limit: current?.character_limit ?? 700,
        version: nextVersionNumber(sorted),
        is_active: true,
        affects_text_generation: defaultAffectsTextGeneration(type),
        created_by_email: adminEmail ?? undefined,
        created_at: new Date().toISOString(),
      };

      onCreateVersion(type, localVersion);
      setIdx(0);
      setIsDirty(false);

      setSaveError("Saved locally (backend save failed).");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!current?.id) return;
    if (current.is_active) return;

    setDeleting(true);
    setSaveError(null);

    try {
      await onDelete(type, current.id);

      // Remove from parent state
      onDeleteVersion(type, current.id);

      // Move index safely after deletion
      setIdx((prev) => {
        const nextLength = Math.max(sorted.length - 1, 0);
        if (nextLength === 0) return 0;
        return Math.min(prev, nextLength - 1);
      });

      setDeleteOpen(false);
    } catch (e) {
      console.error(e);
      setSaveError("Failed to delete version.");
    } finally {
      setDeleting(false);
    }
  };

  const handleActivate = async () => {
    if (!current?.id) return;
    if (current.is_active) return;

    setActivating(true);
    setSaveError(null);

    try {
      await onActivate(type, current.id);

      // Update parent-local versions state so selected version is active
      onActivateVersion(type, current.id);
    } catch (e) {
      console.error(e);
      setSaveError("Failed to activate version.");
    } finally {
      setActivating(false);
    }
  };

  return (
    <Card className="border-gray-200 shadow-sm w-full">
      <CardHeader className="space-y-2">
        <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-3">
          <div className="space-y-2">
            <CardTitle className="flex items-center gap-2">
              <Bot className="h-5 w-5 text-primary" />
              {title}
            </CardTitle>

            {description ? <CardDescription>{description}</CardDescription> : null}
          </div>

          <Button
            type="button"
            variant="outline"
            onClick={() => setPlacementOpen(true)}
            className="shrink-0"
          >
            <Map className="mr-2 h-4 w-4" />
            Where does this go?
          </Button>
        </div>

        <div className="flex items-center justify-between pt-2">
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setIdx((i) => Math.max(0, i - 1))}
              disabled={!canPrev}
              className="h-8"
            >
              <ChevronLeft className="h-4 w-4 mr-1" />
              Prev
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setIdx((i) => Math.min(sorted.length - 1, i + 1))}
              disabled={!canNext}
              className="h-8"
            >
              Next
              <ChevronRight className="h-4 w-4 ml-1" />
            </Button>
          </div>

          <div className="text-xs text-gray-500">
            This is version{" "}
            <span className="font-medium text-gray-700">{current?.version ?? 1}</span>{" "}
            and you have a total of{" "}
            <span className="font-medium text-gray-700">{sorted.length}</span>{" "}
            version{sorted.length > 1 ? "s " : " "}to choose from
          </div>
        </div>

        {/* Mini “side-scroll” chips */}
        <div className="flex gap-2 overflow-x-auto pb-1">
          {sorted.map((v, i) => (
            <button
              key={v.id}
              type="button"
              onClick={() => setIdx(i)}
              className={[
                "shrink-0 rounded-full border px-3 py-1 text-xs transition",
                i === idx
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-gray-200 bg-white text-gray-600 hover:bg-gray-50",
              ].join(" ")}
              title={`v${v.version}${v.is_active ? " (active)" : ""}`}
            >
              v{v.version}
              {v.is_active ? (
                <CheckCircle2 className="inline-block h-3.5 w-3.5 ml-1 text-green-600" />
              ) : null}
            </button>
          ))}
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Metadata row */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
          <div className="rounded-lg border border-gray-200 p-3 bg-gray-50">
            <Label className="text-gray-500">Active</Label>
            <div className="mt-1 font-medium text-gray-800">
              {current?.is_active ? "Yes" : "No"}
            </div>
          </div>
          <div className="rounded-lg border border-gray-200 p-3 bg-gray-50">
            <Label className="text-gray-500">Created by</Label>
            <div className="mt-1 font-medium text-gray-800">
              {current?.created_by_email ?? "—"}
            </div>
          </div>
          <div className="rounded-lg border border-gray-200 p-3 bg-gray-50">
            <Label className="text-gray-500">Created at</Label>
            <div className="mt-1 font-medium text-gray-800">
              {formatDate(current?.created_at)}
            </div>
          </div>
        </div>

        {/* Content editor */}
        <div className="space-y-2">
          <Label>Message content</Label>

          <div className="space-y-2">
            <textarea
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                setIsDirty(true);
                if (saveError) setSaveError(null);
              }}
              readOnly={!canEdit}
              className={[
                "flex min-h-[240px] w-full rounded-md border px-3 py-2 text-sm ring-offset-background font-mono",
                isOverLimit ? "border-red-300 focus-visible:ring-red-200" : "border-input",
                !canEdit ? "opacity-70 cursor-not-allowed bg-background" : "bg-background",
              ].join(" ")}
            />

            <div className="flex items-center justify-between text-xs">
              <div>
                {isOverLimit ? (
                  <span className="text-red-600 font-medium">
                    Exceeds limit by {Math.abs(remainingCharacters)} character{Math.abs(remainingCharacters) === 1 ? "" : "s"}.
                  </span>
                ) : (
                  <span className="text-gray-500">
                    Limit: {characterLimit} characters
                  </span>
                )}
              </div>

              <div className={isOverLimit ? "text-red-600 font-medium" : "text-gray-500"}>
                {currentLength} / {characterLimit}
              </div>
            </div>
          </div>

          {saveError ? (
            <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2">
              {saveError}
            </p>
          ) : null}

          {!canEdit ? (
            <p className="text-xs text-gray-500">
              Only the active version can be edited. To change history, create a new version via Save.
            </p>
          ) : (
            <p className="text-xs text-gray-500">
              Saving creates a new version and makes it active (rollback-safe).
            </p>
          )}
        </div>

        {/* Save and Delete buttons */}
        <div className="pt-2 flex flex-wrap gap-2">
          <Button
            type="button"
            onClick={handleSave}
            disabled={
              saving ||
              deleting ||
              !canEdit ||
              !isDirty ||
              !(draft ?? "").trim() ||
              isOverLimit
            }
            className="bg-primary hover:bg-primary/90"
          >
            <Save className="mr-2 h-4 w-4" />
            {saving ? "Saving..." : "Save New Version"}
          </Button>

          {!current?.is_active ? (
            <Button
              type="button"
              variant="outline"
              onClick={handleActivate}
              disabled={saving || deleting || activating || !current?.id}
              className="border-green-200 text-green-700 hover:bg-green-50 hover:text-green-800"
            >
              <Power className="mr-2 h-4 w-4" />
              {activating ? "Activating..." : "Activate Version"}
            </Button>
          ) : null}

          {!current?.is_active ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => setDeleteOpen(true)}
              disabled={saving || deleting || activating || !current?.id}
              className="border-red-200 text-red-700 hover:bg-red-50 hover:text-red-800"
            >
              <Trash2 className="mr-2 h-4 w-4" />
              Delete Version
            </Button>
          ) : null}
        </div>
      </CardContent>

      <Dialog open={deleteOpen} onOpenChange={(open) => !deleting && setDeleteOpen(open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Are you sure?</DialogTitle>
            <DialogDescription>
              This will permanently remove version{" "}
              <span className="font-medium">v{current?.version ?? "?"}</span> of{" "}
              <span className="font-medium">{title}</span>.
            </DialogDescription>
          </DialogHeader>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setDeleteOpen(false)}
              disabled={deleting}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={handleDelete}
              disabled={deleting}
              className="bg-red-600 hover:bg-red-700 text-white"
            >
              {deleting ? "Deleting..." : "Yes, Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={placementOpen} onOpenChange={setPlacementOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Map className="h-5 w-5 text-primary" />
              Where does this go?
            </DialogTitle>
            <DialogDescription>
              {affectsTextGeneration
                ? <>See where <span className="font-medium">{title}</span> fits into the overall prompt flow.</>
                : <>This message is shown in the UI and does not affect text generation.</>}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-5">
            {placement !== "ui_only" && (
              <>
                <div className="flex items-center justify-between gap-4">
                  <div className="text-sm font-medium text-gray-800">
                    Prompt position preview
                  </div>

                  <div className="inline-flex rounded-lg border border-gray-200 p-1 bg-gray-50 w-fit">
                    <Button
                      type="button"
                      variant={placementPhase === "DETECTIVE" ? "default" : "ghost"}
                      className={
                        placementPhase === "DETECTIVE"
                          ? "bg-primary hover:bg-primary/90"
                          : ""
                      }
                      onClick={() => setPlacementPhase("DETECTIVE")}
                    >
                      Detective
                    </Button>
                    <Button
                      type="button"
                      variant={placementPhase === "SUGGESTION" ? "default" : "ghost"}
                      className={
                        placementPhase === "SUGGESTION"
                          ? "bg-primary hover:bg-primary/90"
                          : ""
                      }
                      onClick={() => setPlacementPhase("SUGGESTION")}
                    >
                      Suggestion
                    </Button>
                  </div>
                </div>

                {((placement === "phase_detective" && placementPhase === "SUGGESTION") ||
                  (placement === "phase_suggestion" && placementPhase === "DETECTIVE")) && (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                    This message is only used in the{" "}
                    <span className="font-medium">
                      {placement === "phase_detective" ? "Detective" : "Suggestion"}
                    </span>{" "}
                    phase.
                  </div>
                )}

                <PlacementStack
                  placement={placement}
                  selectedPhase={placementPhase}
                />
              </>
            )}

            <div className="rounded-lg border border-gray-200 bg-white px-4 py-3">
              <div className="text-sm font-medium text-gray-900 mb-2">Current active content preview</div>
              <div className="text-sm text-gray-700 whitespace-pre-wrap">
                {truncatePreview(current?.content, 240)}
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setPlacementOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}