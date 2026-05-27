import React from "react";
import { Button } from "@/components/ui/button";
import { Trash2 } from "lucide-react";
import { AuthService } from "@/functions/authService";

type DeleteChatButtonProps = {
  chatSessionId: string;
  userId?: string;
  onDeleted?: () => void;
};

export default function DeleteChatButton({ chatSessionId, userId, onDeleted }: DeleteChatButtonProps) {
  const handleDelete = async (e?: React.MouseEvent) => {
    try { e?.stopPropagation(); } catch { }
    if (!confirm("Are you sure you want to delete this chat session?")) return;

    try {
      const session = await AuthService.getAuthSession(true);
      const token = session?.tokens?.idToken as string;

      const url = new URL(`${import.meta.env.VITE_API_ENDPOINT}/chat_sessions/${chatSessionId}`);
      if (userId) url.searchParams.set("user_id", userId);

      const response = await fetch(url.toString(), {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!response.ok) throw new Error("Failed to delete chat session");
      if (onDeleted) onDeleted();
    } catch (err) {
      console.error("Error deleting chat session:", err);
      alert("Failed to delete chat session. Please try again.");
    }
  };

  return (
    <Button type="button" variant="ghost" size="icon" onClick={(e) => handleDelete(e)} title="Delete chat session">
      <Trash2 className="h-4 w-4" />
    </Button>
  );
}
