import { useState, useEffect } from "react";
import { Outlet, useNavigate } from "react-router";
import { ViewProvider } from "@/providers/ViewContext";
import { SidebarProvider } from "@/providers/SidebarContext";
import SideBar from "@/components/ChatInterface/SideBar";
import type { ChatSession } from "@/providers/view";
import { useUser } from "@/providers/user";
import { Button } from "@/components/ui/button";
import { AuthService } from "@/functions/authService";

const DEFAULT_WELCOME_MESSAGE =
  "Welcome to the CUCCIO Knowledge Base Assistant. Click below to start a new conversation.";
const DEFAULT_DISCLAIMER = "AI can make mistakes. Check important info.";

export default function HomePage() {
  const { userId, isLoading: isLoadingUser } = useUser();
  const navigate = useNavigate();

  const [chatSessions, setChatSessions] = useState<ChatSession[]>([]);
  const [activeChatSessionId, setActiveChatSessionId] = useState<string | null>(null);
  const [currentMessages, setCurrentMessages] = useState<any[]>([]);
  const [activeChatName, setActiveChatName] = useState<string | null>(null);
  const [isLoadingChatSessions, setIsLoadingChatSessions] = useState(true);
  const [welcomeMessage, setWelcomeMessage] = useState<string>(DEFAULT_WELCOME_MESSAGE);
  const [isLoadingWelcome, setIsLoadingWelcome] = useState(true);
  const [disclaimer, setDisclaimer] = useState<string>(DEFAULT_DISCLAIMER);
  const [isLoadingDisclaimer, setIsLoadingDisclaimer] = useState(true);

  const getToken = () => AuthService.getIdToken();

  const normalizeChatSession = (session: any): ChatSession => ({
    id: session.id,
    name:
      typeof session.name === "string"
        ? session.name
        : typeof session.title === "string"
          ? session.title
          : "",
    user_id: session.user_id,
    context: session.context,
    created_at: session.created_at,
    metadata: session.metadata,
  });

  const fetchSystemMessage = async (
    messageType: string,
    fallback: string,
    setter: (val: string) => void
  ) => {
    try {
      const token = await getToken();
      const response = await fetch(
        `${import.meta.env.VITE_API_ENDPOINT}/system_message/${messageType}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
        }
      );
      if (!response.ok) throw new Error(`Failed to fetch ${messageType}`);
      const data: { message?: string } = await response.json();
      setter(data.message?.trim() || fallback);
    } catch (err) {
      console.error(`Error fetching ${messageType}:`, err);
      setter(fallback);
    }
  };

  const fetchChatSessions = async () => {
    if (!userId) {
      setIsLoadingChatSessions(false);
      return;
    }

    setIsLoadingChatSessions(true);
    try {
      const token = await getToken();
      const response = await fetch(
        `${import.meta.env.VITE_API_ENDPOINT}/chat_sessions/user/${userId}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
        }
      );
      if (!response.ok) throw new Error("Failed to fetch chat sessions");
      const sessions: unknown = await response.json();
      setChatSessions(Array.isArray(sessions) ? sessions.map(normalizeChatSession) : []);
    } catch (err) {
      console.error("Error fetching chat sessions:", err);
    } finally {
      setIsLoadingChatSessions(false);
    }
  };

  useEffect(() => {
    if (isLoadingUser) return;

    setIsLoadingWelcome(true);
    setIsLoadingDisclaimer(true);

    Promise.all([
      fetchSystemMessage("welcome_message", DEFAULT_WELCOME_MESSAGE, setWelcomeMessage),
      fetchSystemMessage("disclaimer", DEFAULT_DISCLAIMER, setDisclaimer),
    ]).finally(() => {
      setIsLoadingWelcome(false);
      setIsLoadingDisclaimer(false);
    });

    fetchChatSessions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, isLoadingUser]);

  const createNewChatSession = async (): Promise<ChatSession | null> => {
    if (!userId) return null;

    try {
      const token = await getToken();
      const createResponse = await fetch(
        `${import.meta.env.VITE_API_ENDPOINT}/chat_sessions`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({}),
        }
      );
      if (!createResponse.ok) throw new Error("Failed to create chat session");
      const newSession = normalizeChatSession(await createResponse.json());
      setChatSessions((prev) => [newSession, ...prev]);
      setActiveChatSessionId(newSession.id);
      return newSession;
    } catch (err) {
      console.error("Error creating chat session:", err);
      return null;
    }
  };

  const refreshChatSessions = async () => {
    await fetchChatSessions();
  };

  const updateChatSessionName = (sessionId: string, name: string) => {
    setChatSessions((prev) =>
      prev.map((session) =>
        session.id === sessionId ? { ...session, name } : session
      )
    );
  };

  const removeChatSession = (sessionId: string) => {
    setChatSessions((prev) => prev.filter((session) => session.id !== sessionId));
    setActiveChatSessionId((current) => (current === sessionId ? null : current));
  };

  const renameChatSession = async (
    sessionId: string,
    name: string
  ): Promise<ChatSession | null> => {
    if (!userId) return null;
    const trimmedName = name.trim();
    if (!trimmedName) return null;

    try {
      const token = await getToken();
      const url = `${import.meta.env.VITE_API_ENDPOINT}/chat_sessions/${sessionId}`;
      const response = await fetch(url, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ title: trimmedName }),
      });
      if (!response.ok) throw new Error("Failed to rename chat session");
      const updatedSession = normalizeChatSession(await response.json());
      setChatSessions((prev) =>
        prev.map((session) =>
          session.id === sessionId ? { ...session, ...updatedSession } : session
        )
      );
      return updatedSession;
    } catch (err) {
      console.error("Error renaming chat session:", err);
      return null;
    }
  };

  const handleStartNewConversation = async () => {
    const session = await createNewChatSession();
    if (session) {
      navigate("/chat");
    }
  };

  if (isLoadingUser || isLoadingChatSessions) {
    return (
      <div className="flex flex-col min-h-screen bg-background">
        <div className="pt-[70px] flex-1 flex items-center justify-center">
          <div className="text-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto mb-4"></div>
            <p className="text-muted-foreground">Loading...</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <ViewProvider
      value={{
        loading: false,
        error: null,
        chatSessions,
        activeChatSessionId,
        setActiveChatSessionId,
        isLoadingChatSessions,
        createNewChatSession,
        refreshChatSessions,
        updateChatSessionName,
        removeChatSession,
        renameChatSession,
        currentMessages,
        setCurrentMessages,
        activeChatName,
        setActiveChatName,
      }}
    >
      <SidebarProvider>
        <div className="flex flex-col h-full bg-background overflow-hidden">
          <SideBar />
          <div className="md:ml-64 flex flex-col flex-1 min-h-0">
            <main
              className={`flex-1 flex flex-col items-center max-w-screen px-4 min-h-0 ${
                activeChatSessionId ? "justify-start overflow-hidden" : "justify-center"
              }`}
            >
              {!activeChatSessionId ? (
                <div className="w-full max-w-2xl text-center">
                  <h1 className="text-3xl md:text-4xl font-bold mb-4 leading-tight">
                    CUCCIO Assistant
                  </h1>
                  <p className="text-base md:text-lg text-muted-foreground mb-8 whitespace-pre-line">
                    {isLoadingWelcome ? "Loading..." : welcomeMessage}
                  </p>
                  <Button
                    size="lg"
                    onClick={handleStartNewConversation}
                    className="px-8"
                    disabled={isLoadingWelcome}
                  >
                    Start a new conversation
                  </Button>
                  <p className="mt-4 text-xs text-muted-foreground">
                    {isLoadingDisclaimer ? "" : disclaimer}
                  </p>
                </div>
              ) : (
                <Outlet />
              )}
            </main>
          </div>
        </div>
      </SidebarProvider>
    </ViewProvider>
  );
}


