import { createContext, useContext } from "react";

export type ChatSession = {
  id: string;
  name: string;
  user_id: string;
  context?: unknown;
  created_at: string;
  metadata?: unknown;
};

export type ViewContextType = {
  loading: boolean;
  error: Error | null;

  // Chat session management
  chatSessions: ChatSession[];
  activeChatSessionId: string | null;
  setActiveChatSessionId: (id: string | null) => void;
  isLoadingChatSessions: boolean;
  createNewChatSession: () => Promise<ChatSession | null>;
  refreshChatSessions: () => Promise<void>;
  updateChatSessionName: (sessionId: string, name: string) => void;
  removeChatSession: (sessionId: string) => void;
  renameChatSession: (sessionId: string, name: string) => Promise<ChatSession | null>;

  // Current chat data for export
  currentMessages: any[];
  setCurrentMessages: (messages: any[]) => void;
  activeChatName: string | null;
  setActiveChatName: (name: string | null) => void;
};

export const ViewContext = createContext<
  ViewContextType | undefined
>(undefined);

export function useView() {
  const context = useContext(ViewContext);
  if (!context) {
    throw new Error("useView must be used within ViewProvider");
  }
  return context;
}
