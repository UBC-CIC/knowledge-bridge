import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { detectPII } from "@coffeeandfun/remove-pii";

import AIChatMessage from "@/components/ChatInterface/AIChatMessage";
import UserChatMessage from "@/components/ChatInterface/UserChatMessage";
import { useView } from "@/providers/view";
import { AiChatInput } from "@/components/ChatInterface/userInput";
import { useWebSocket } from "@/hooks/useWebSocket";
import type { Message } from "@/types/Chat";
import { useUser } from "@/providers/user";
import { AuthService } from "@/functions/authService";

type MaxCharactersResponse = {
  max_characters_per_user_message?: number;
};

const DEFAULT_MAX_CHARACTERS_PER_USER_MESSAGE = 50000;

const WELCOME_PROMPT = `Hello! Please act as the Specialization Explorer.
1. Introduce yourself briefly.
2. Ask the student these 1 of these starter questions, and use some variation of these in the later responses to complete the checklist:
   - What are your academic interests?
   - Which course or department do you like most at UBC Science?
   - Do you want to pursue research or enter industry after graduation?
3. Be friendly and inviting.`;

const getToken = () => AuthService.getIdToken();

export default function AIChatPage() {
  const { setCurrentMessages, setActiveChatName } = useView();

  const hasStartedRef = useRef(false);
  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [initialMessageLoadTime, setInitialMessageLoadTime] = useState<number | null>(null);

  const { activeChatSessionId, chatSessions, updateChatSessionName } = useView();
  const [isLoadingHistory, setIsLoadingHistory] = useState(true);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingMessageId, setStreamingMessageId] = useState<string | null>(null);

  const [isTokenLimitReached, setIsTokenLimitReached] = useState(false);
  const [tokenResetTime, setTokenResetTime] = useState<string | null>(null);

  const [maxCharactersPerUserMessage, setMaxCharactersPerUserMessage] = useState(
    DEFAULT_MAX_CHARACTERS_PER_USER_MESSAGE
  );

  const formatResetTime = (isoString: string) => {
    try {
      const date = new Date(isoString);
      return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    } catch {
      return null;
    }
  };

  const { userId } = useUser();
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const activeChatNameDisplay = useMemo(() => {
    if (!activeChatSessionId) return null;
    const activeIndex = chatSessions.findIndex((s) => s.id === activeChatSessionId);
    if (activeIndex === -1) return null;
    const activeSession = chatSessions[activeIndex];
    if (activeSession.name?.trim()) return activeSession.name;
    return `Chat ${chatSessions.length - activeIndex}`;
  }, [activeChatSessionId, chatSessions]);

  useEffect(() => {
    setCurrentMessages(messages);
    setActiveChatName(activeChatNameDisplay);
  }, [messages, activeChatNameDisplay, setCurrentMessages, setActiveChatName]);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  useEffect(() => {
    if (!isLoadingHistory && initialMessageLoadTime === null) {
      setInitialMessageLoadTime(Date.now());
    }
  }, [isLoadingHistory, initialMessageLoadTime]);

  // WebSocket token — refreshed on demand via Amplify (no polling loop needed)
  const [webSocketToken, setWebSocketToken] = useState<string | null>(null);

  const baseWebSocketUrl = useMemo(() => import.meta.env.VITE_WEBSOCKET_URL, []);
  const webSocketUrl = useMemo(() => {
    if (!baseWebSocketUrl || !webSocketToken) return null;
    try {
      const url = new URL(baseWebSocketUrl);
      url.searchParams.set("token", webSocketToken);
      return url.toString();
    } catch (error) {
      console.error("[WebSocket] Invalid base URL:", error);
      return null;
    }
  }, [baseWebSocketUrl, webSocketToken]);

  // Fetch initial WebSocket token on mount
  useEffect(() => {
    getToken()
      .then((token) => setWebSocketToken(token))
      .catch((err) => console.error("[WebSocket] Failed to fetch initial token:", err));
  }, []);

  const handleWebSocketMessage = useCallback(
    (message: any) => {
      switch (message.type) {
        case "start":
          setIsStreaming(true);
          if (streamingMessageId) {
            setMessages((prev) =>
              prev.map((msg) =>
                msg.id === streamingMessageId ? { ...msg, isTyping: true } : msg
              )
            );
          }
          break;

        case "chunk":
          if (message.content && streamingMessageId) {
            setMessages((prev) =>
              prev.map((msg) =>
                msg.id === streamingMessageId
                  ? { ...msg, text: msg.text + message.content, isTyping: false }
                  : msg
              )
            );
          }
          break;

        case "complete":
          setIsStreaming(false);
          setStreamingMessageId(null);
          if (streamingMessageId) {
            setMessages((prev) =>
              prev.map((msg) =>
                msg.id === streamingMessageId
                  ? {
                      ...msg,
                      sources_used: message.sources || [],
                      warning: message.warning || null,
                      isTyping: false,
                    }
                  : msg
              )
            );
          }
          if (message.session_name && activeChatSessionId) {
            updateChatSessionName(activeChatSessionId, message.session_name);
          }
          if (message.token_usage?.remaining === 0) {
            setIsTokenLimitReached(true);
            if (message.token_usage.reset_at) {
              setTokenResetTime(formatResetTime(message.token_usage.reset_at));
            }
          }
          break;

        case "error":
          setIsStreaming(false);
          setStreamingMessageId(null);
          if (message.error === "TOKEN_LIMIT_EXCEEDED") {
            setIsTokenLimitReached(true);
            if (message.token_usage?.reset_at) {
              setTokenResetTime(formatResetTime(message.token_usage.reset_at));
            }
          }
          if (streamingMessageId) {
            setMessages((prev) =>
              prev.map((msg) =>
                msg.id === streamingMessageId
                  ? { ...msg, text: message.message || "An error occurred", isTyping: false }
                  : msg
              )
            );
          }
          break;
      }
    },
    [streamingMessageId, activeChatSessionId, updateChatSessionName]
  );

  const {
    sendMessage: sendWebSocketMessage,
    isConnected,
    connectionState,
    forceReconnect,
  } = useWebSocket(webSocketUrl, {
    onMessage: handleWebSocketMessage,
    onConnect: () => {
      console.log("[WebSocket] Connected");
    },
    onDisconnect: () => {
      console.log("[WebSocket] Disconnected");
    },
    onError: (error) => {
      console.error("[WebSocket] Error:", error);
    },
  });

  const fetchMaxCharactersPerUserMessage = async () => {
    try {
      const token = await getToken();
      const response = await fetch(
        `${import.meta.env.VITE_API_ENDPOINT}/system-settings/max-characters-per-user-message`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!response.ok) throw new Error("Failed to fetch max_characters_per_user_message");
      const data: MaxCharactersResponse = await response.json();
      setMaxCharactersPerUserMessage(
        data.max_characters_per_user_message ?? DEFAULT_MAX_CHARACTERS_PER_USER_MESSAGE
      );
    } catch (error) {
      console.error("Failed to fetch max user message length:", error);
      setMaxCharactersPerUserMessage(DEFAULT_MAX_CHARACTERS_PER_USER_MESSAGE);
    }
  };

  useEffect(() => {
    fetchMaxCharactersPerUserMessage();
  }, []);

  useEffect(() => {
    if (!activeChatSessionId) return;

    hasStartedRef.current = false;

    const loadChatHistory = async () => {
      setIsLoadingHistory(true);
      try {
        const token = await getToken();
        const response = await fetch(
          `${import.meta.env.VITE_API_ENDPOINT}/user/${userId}/chat_sessions/${activeChatSessionId}/chat_history`,
          { headers: { Authorization: `Bearer ${token}` } }
        );

        if (!response.ok) throw new Error("Failed to load chat history");

        interface ChatMessageRow {
          id: string;
          chat_session_id: string;
          sender: "user" | "AI";
          content: string;
          sources?: any;
          warning?: string | null;
          created_at: string;
        }

        const data: { messages: ChatMessageRow[] } = await response.json();
        const rawMessages = data.messages || [];
        const startIndex =
          rawMessages.length > 0 && rawMessages[0].content === WELCOME_PROMPT ? 1 : 0;

        const chatMessages: Message[] = rawMessages.slice(startIndex).map((m) => {
          let parsedSources: any[] = [];
          if (m.sender === "AI" && m.sources) {
            if (Array.isArray(m.sources)) {
              parsedSources = m.sources;
            } else if (typeof m.sources === "string") {
              try {
                const parsed = JSON.parse(m.sources);
                parsedSources = Array.isArray(parsed) ? parsed : [parsed];
              } catch {
                parsedSources = [m.sources];
              }
            } else {
              parsedSources = [m.sources];
            }
          }
          return {
            id: m.id,
            sender: m.sender === "AI" ? ("bot" as const) : ("user" as const),
            text: m.content,
            sources_used: parsedSources,
            warning: (m as any).warning ?? null,
            rating: (m as any).rating ?? null,
            time: new Date(m.created_at).getTime(),
          };
        });

        chatMessages.sort((a, b) => a.time - b.time);
        setMessages(chatMessages);
      } catch (error) {
        console.error("Failed to load chat history:", error);
      } finally {
        setIsLoadingHistory(false);
      }
    };

    loadChatHistory();
  }, [activeChatSessionId, userId]);

  const startConversation = useCallback(async () => {
    if (hasStartedRef.current) return;
    if (!activeChatSessionId) return;

    hasStartedRef.current = true;

    const botMsg: Message = {
      id: `${Date.now() + 1}-${Math.random().toString(36).slice(2, 9)}`,
      sender: "bot",
      text: "",
      sources_used: [],
      time: Date.now() + 1,
      isTyping: true,
    };

    setMessages((m) => [...m, botMsg]);
    setStreamingMessageId(botMsg.id);
    setIsStreaming(true);

    if (isConnected && webSocketUrl) {
      console.log("[WebSocket] Starting conversation via WebSocket");
      const success = sendWebSocketMessage({
        action: "generate_text",
        query: WELCOME_PROMPT,
        chat_session_id: activeChatSessionId,
        user_id: userId,
        is_intro_message: true,
      });

      if (!success) {
        console.warn("[WebSocket] Start conversation failed. Attempting reconnect...");
        forceReconnect();
      }
    } else {
      console.log("[WebSocket] Fallback: Starting conversation via HTTP API...");
      try {
        const token = await getToken();
        const response = await fetch(
          `${import.meta.env.VITE_API_ENDPOINT}/chat_sessions/${activeChatSessionId}/text_generation`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
              query: WELCOME_PROMPT,
              chat_session_id: activeChatSessionId,
              user_id: userId,
              is_intro_message: true,
            }),
          }
        );

        if (!response.ok) {
          if (response.status === 429) {
            const errData = await response.json();
            if (errData.error === "TOKEN_LIMIT_EXCEEDED") {
              setIsTokenLimitReached(true);
              if (errData.token_usage?.reset_at) {
                setTokenResetTime(formatResetTime(errData.token_usage.reset_at));
              }
              throw new Error(errData.message || "Token limit exceeded");
            }
          }
          throw new Error("Failed to generate response");
        }

        const data = await response.json();

        if (data.token_usage?.remaining === 0) {
          setIsTokenLimitReached(true);
          if (data.token_usage.reset_at) {
            setTokenResetTime(formatResetTime(data.token_usage.reset_at));
          }
        }

        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === botMsg.id
              ? {
                  ...msg,
                  text: data.response || "Sorry, I couldn't generate a response.",
                  sources_used: data.sources || [],
                  warning: data.warning || null,
                  isTyping: false,
                }
              : msg
          )
        );

        if (data.session_name && activeChatSessionId) {
          updateChatSessionName(activeChatSessionId, data.session_name);
        }
      } catch (error) {
        console.error("Error starting conversation:", error);
        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === botMsg.id
              ? { ...msg, text: "Sorry, there was an error processing your request.", isTyping: false }
              : msg
          )
        );
      } finally {
        setIsStreaming(false);
        setStreamingMessageId(null);
      }
    }
  }, [activeChatSessionId, userId, isConnected, webSocketUrl, sendWebSocketMessage, forceReconnect, updateChatSessionName]);

  useEffect(() => {
    if (!isLoadingHistory && messages.length === 0 && activeChatSessionId && !hasStartedRef.current) {
      startConversation();
    }
  }, [isLoadingHistory, messages.length, activeChatSessionId, startConversation]);

  async function sendMessage() {
    if (isStreaming) return;

    const text = message.trim();
    if (!text) return;
    if (!activeChatSessionId) return;

    const userMsg: Message = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      sender: "user",
      text,
      time: Date.now(),
      hasPII: detectPII(text).hasPII,
    };

    const botMsg: Message = {
      id: `${Date.now() + 1}-${Math.random().toString(36).slice(2, 9)}`,
      sender: "bot",
      text: "",
      sources_used: [],
      time: Date.now() + 1,
      isTyping: true,
    };

    setMessages((m) => [...m, userMsg, botMsg]);
    setStreamingMessageId(botMsg.id);
    setIsStreaming(true);
    setMessage("");

    if (isConnected && webSocketUrl) {
      const success = sendWebSocketMessage({
        action: "generate_text",
        query: text,
        chat_session_id: activeChatSessionId,
        user_id: userId,
      });

      if (success) {
        console.log("[WebSocket] Message sent successfully.");
        return;
      } else {
        console.warn("[WebSocket] Message send failed. Attempting reconnect...");
        forceReconnect();
      }
    } else {
      console.warn(`[WebSocket] Not connected (state: ${connectionState}). Falling back to HTTP.`);
    }

    console.log("[WebSocket] Fallback: Sending message via HTTP API...");

    setMessages((prev) =>
      prev.map((msg) => (msg.id === botMsg.id ? { ...msg, isTyping: true } : msg))
    );

    try {
      const token = await getToken();
      const response = await fetch(
        `${import.meta.env.VITE_API_ENDPOINT}/chat_sessions/${activeChatSessionId}/text_generation`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            query: text,
            chat_session_id: activeChatSessionId,
            user_id: userId,
          }),
        }
      );

      if (!response.ok) {
        if (response.status === 429) {
          const errData = await response.json();
          if (errData.error === "TOKEN_LIMIT_EXCEEDED") {
            setIsTokenLimitReached(true);
            if (errData.token_usage?.reset_at) {
              setTokenResetTime(formatResetTime(errData.token_usage.reset_at));
            }
            throw new Error(errData.message || "Token limit exceeded");
          }
        }
        throw new Error("Failed to generate response");
      }

      const data = await response.json();

      if (data.token_usage?.remaining === 0) {
        setIsTokenLimitReached(true);
        if (data.token_usage.reset_at) {
          setTokenResetTime(formatResetTime(data.token_usage.reset_at));
        }
      }

      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === botMsg.id
            ? {
                ...msg,
                text: data.response || "Sorry, I couldn't generate a response.",
                sources_used: data.sources || [],
                warning: data.warning || null,
                isTyping: false,
              }
            : msg
        )
      );

      if (data.session_name && activeChatSessionId) {
        updateChatSessionName(activeChatSessionId, data.session_name);
      }
    } catch (error) {
      console.error("Error generating text:", error);
      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === botMsg.id
            ? { ...msg, text: "Sorry, there was an error processing your request.", isTyping: false }
            : msg
        )
      );
    } finally {
      setIsStreaming(false);
      setStreamingMessageId(null);
    }
  }

  const lastBotMessageId = useMemo(() => {
    if (isStreaming) return null;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].sender === "bot") return messages[i].id;
    }
    return null;
  }, [messages, isStreaming]);

  const handleRate = async (messageId: string, is_positive: boolean, comment?: string) => {
    try {
      const token = await getToken();
      await fetch(
        `${import.meta.env.VITE_API_ENDPOINT}/user/${userId}/chat_sessions/${activeChatSessionId}/messages/${messageId}/rating`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ is_positive, comment: comment ?? null }),
        }
      );
      setMessages((prev) =>
        prev.map((m) =>
          m.id === messageId
            ? { ...m, rating: { is_positive, comment: comment ?? null } }
            : m
        )
      );
    } catch (error) {
      console.error("Failed to submit rating:", error);
    }
  };

  function messageFormatter(message: Message) {
    if (message.sender === "user") {
      return (
        <UserChatMessage key={message.id} text={message.text} hasPII={message.hasPII} />
      );
    } else {
      return (
        <AIChatMessage
          key={message.id}
          text={message.text}
          sources={message.sources_used}
          warning={message.warning}
          isTyping={message.isTyping}
          messageId={message.id}
          isLastBotMessage={message.id === lastBotMessageId}
          existingRating={message.rating ?? null}
          onRate={handleRate}
        />
      );
    }
  }

  return (
    <div className="flex flex-col h-full min-h-0 w-full">
      {messages.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-center pb-12 w-full max-w-2xl 2xl:max-w-3xl mx-auto px-4">
          <h1 className="text-4xl font-bold mb-4 leading-tight max-w-full break-words">
            What can I help with?
          </h1>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto overscroll-contain chat-scrollbar w-full">
          <div className="w-full max-w-2xl 2xl:max-w-3xl mx-auto flex flex-col gap-4 pt-4 pb-2 px-4">
            {isLoadingHistory ? (
              <div className="flex items-center justify-center py-8">
                <p className="text-muted-foreground">Loading chat history...</p>
              </div>
            ) : (
              <>
                {messages.map((m) => messageFormatter(m))}
                <div ref={messagesEndRef} className="h-4 shrink-0" />
              </>
            )}
          </div>
        </div>
      )}

      <div className="shrink-0 w-full border-t border-border/100 bg-background pt-6 pb-6 md:pb-5">
        <div className="w-full px-4">
          <div className="mb-2 flex items-center gap-3">
            <div className="flex-1 min-w-0">
              <div className="w-full max-w-2xl 2xl:max-w-3xl mx-auto">
                <AiChatInput
                  value={message}
                  onChange={(val: string) => setMessage(val)}
                  maxLength={maxCharactersPerUserMessage}
                  placeholder={
                    isTokenLimitReached
                      ? `Daily limit reached. Resets at ${tokenResetTime || "soon"}`
                      : isStreaming
                      ? "CUCCIO Assistant is thinking..."
                      : "Message CUCCIO Assistant..."
                  }
                  onSend={sendMessage}
                  disabled={isTokenLimitReached || isStreaming}
                />
              </div>
            </div>
          </div>

          <div className="text-center">
            <p className="text-xs text-muted-foreground">
              AI can make mistakes. Check important info.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
