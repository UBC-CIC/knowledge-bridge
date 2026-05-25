import { useState, useMemo } from "react";
import { MoreVertical, Pencil, Trash2, Download } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useView } from "@/providers/view";

type ChatSessionActionsMenuProps = {
  chatSessionId: string;
  chatSessionName: string;
  displayName: string;
  userId: string;
  isActive: boolean;
  onDeleted: () => void;
};

export default function ChatSessionActionsMenu({
  chatSessionId,
  chatSessionName,
  displayName,
  userId,
  isActive,
  onDeleted,
}: ChatSessionActionsMenuProps) {
  const { renameChatSession, currentMessages, activeChatName } = useView();
  const [isRenameOpen, setIsRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState(chatSessionName);
  const [isSavingRename, setIsSavingRename] = useState(false);

  const canExportChat = useMemo(
    () =>
      isActive &&
      currentMessages.some(
        (m) => !m.isGuidedQuestion && typeof m.text === "string" && m.text.trim()
      ),
    [isActive, currentMessages]
  );

  const handleExportChat = () => {
    const exportableMessages = currentMessages.filter(
      (m) => !m.isGuidedQuestion && typeof m.text === "string" && m.text.trim()
    );

    if (exportableMessages.length === 0) {
      return;
    }

    const transcript = exportableMessages
      .map((m) => {
        const speaker = m.sender === "user" ? "[USER]" : "[Specialization Explorer]";
        return `${speaker}: ${m.text.trim()}`;
      })
      .join("\r\n====================\r\n");

    const sanitizeFileName = (name: string) =>
      name
        .replace(/[<>:\"\/\\|?*\x00-\x1F]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 120);

    const baseName =
      sanitizeFileName(activeChatName || "chat-export") || "chat-export";
    const blob = new Blob([transcript], { type: "text/plain;charset=utf-8" });
    const blobUrl = window.URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = blobUrl;
    link.download = `${baseName}.txt`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.URL.revokeObjectURL(blobUrl);
  };

  const openRenameDialog = () => {
    setRenameValue(chatSessionName);
    setIsRenameOpen(true);
  };

  const handleRename = async () => {
    const trimmedName = renameValue.trim();
    if (!trimmedName || trimmedName === chatSessionName.trim()) {
      setIsRenameOpen(false);
      return;
    }

    setIsSavingRename(true);
    const updatedSession = await renameChatSession(chatSessionId, trimmedName);
    setIsSavingRename(false);

    if (updatedSession) {
      setIsRenameOpen(false);
    }
  };

  const handleDelete = async () => {
    if (!window.confirm(`Delete \"${displayName}\"?`)) {
      return;
    }

    try {
      const tokenResp = await fetch(`${import.meta.env.VITE_API_ENDPOINT}/user/publicToken`);
      if (!tokenResp.ok) {
        throw new Error("Failed to acquire public token");
      }

      const tokenData = await tokenResp.json();
      const token = tokenData.token as string;

      const url = new URL(`${import.meta.env.VITE_API_ENDPOINT}/chat_sessions/${chatSessionId}`);
      url.searchParams.set("user_id", userId);

      const response = await fetch(url.toString(), {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (!response.ok) {
        throw new Error("Failed to delete chat session");
      }

      onDeleted();
    } catch (error) {
      console.error("Error deleting chat session:", error);
      alert("Failed to delete chat session. Please try again.");
    }
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground"
            aria-label={`Chat options for ${displayName}`}
          >
            <MoreVertical className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={6} className="w-44">
          {isActive && (
            <DropdownMenuItem onSelect={handleExportChat} disabled={!canExportChat}>
              <Download className="h-4 w-4" />
              Export chat
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={openRenameDialog}>
            <Pencil className="h-4 w-4" />
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onSelect={handleDelete}>
            <Trash2 className="h-4 w-4" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={isRenameOpen} onOpenChange={setIsRenameOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Rename chat</DialogTitle>
            <DialogDescription>
              Pick a name that will help you find this conversation later.
            </DialogDescription>
          </DialogHeader>

          <div className="py-2">
            <Input
              value={renameValue}
              onChange={(event) => setRenameValue(event.target.value)}
              placeholder={displayName}
              autoFocus
              maxLength={120}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void handleRename();
                }
              }}
            />
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setIsRenameOpen(false)}
              disabled={isSavingRename}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => void handleRename()}
              disabled={isSavingRename || !renameValue.trim()}
            >
              {isSavingRename ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
