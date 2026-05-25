import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { detectPII } from "@coffeeandfun/remove-pii";

import AIChatMessage from "@/components/ChatInterface/AIChatMessage";
import UserChatMessage from "@/components/ChatInterface/UserChatMessage";
import { useView } from "@/providers/view";
import { AiChatInput } from "@/components/ChatInterface/userInput";
import { useWebSocket } from "@/hooks/useWebSocket";
import type { Message } from "@/types/Chat";
import { useUser } from "@/providers/user";

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

export default function AIChatPage() {
  const { setCurrentMessages, setActiveChatName } = useView();


  // State
  const hasStartedRef = useRef(false);
  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [initialMessageLoadTime, setInitialMessageLoadTime] = useState<
    number | null
  >(null);

  const {
    activeChatSessionId,
    chatSessions,
    updateChatSessionName,
  } = useView();
  const [isLoadingHistory, setIsLoadingHistory] = useState(true);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingMessageId, setStreamingMessageId] = useState<string | null>(
    null
  );

  const [isTokenLimitReached, setIsTokenLimitReached] = useState(false);
  const [tokenResetTime, setTokenResetTime] = useState<string | null>(null);

  const [maxCharactersPerUserMessage, setMaxCharactersPerUserMessage] = useState(
    DEFAULT_MAX_CHARACTERS_PER_USER_MESSAGE
  );

  const formatResetTime = (isoString: string) => {
    try {
      const date = new Date(isoString);
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch {
      return null;
    }
  };

  const { userId } = useUser();
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const activeChatNameDisplay = useMemo(() => {
    if (!activeChatSessionId) {
      return null;
    }

    const activeIndex = chatSessions.findIndex(
      (session) => session.id === activeChatSessionId
    );

    if (activeIndex === -1) {
      return null;
    }

    const activeSession = chatSessions[activeIndex];
    if (activeSession.name?.trim()) {
      return activeSession.name;
    }

    // Match the same fallback label shown in the sidebar.
    return `Chat ${chatSessions.length - activeIndex}`;
  }, [activeChatSessionId, chatSessions]);

  // Update context with current messages and chat name
  useEffect(() => {
    setCurrentMessages(messages);
    setActiveChatName(activeChatNameDisplay);
  }, [messages, activeChatNameDisplay, setCurrentMessages, setActiveChatName]);

  // Auto-scroll to bottom when messages change or when typing starts
  const scrollToBottom = useCallback(() => {
    // "end" aligns the bottom of the element with the bottom of the scrollable area
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  // Capture the initial messages load time to avoid autoplaying historical messages
  useEffect(() => {
    if (!isLoadingHistory && initialMessageLoadTime === null) {
      setInitialMessageLoadTime(Date.now());
    }
  }, [isLoadingHistory, initialMessageLoadTime]);

  const [webSocketToken, setWebSocketToken] = useState<string | null>(null);

  // WebSocket configuration
  const baseWebSocketUrl = useMemo(
    () => import.meta.env.VITE_WEBSOCKET_URL,
    []
  );
  const webSocketUrl = useMemo(() => {
    if (!baseWebSocketUrl || !webSocketToken) {
      return null;
    }

    try {
      const url = new URL(baseWebSocketUrl);
      url.searchParams.set("token", webSocketToken);
      return url.toString();
    } catch (error) {
      console.error("[WebSocket] Invalid base URL:", error);
      return null;
    }
  }, [baseWebSocketUrl, webSocketToken]);

  useEffect(() => {
    if (!baseWebSocketUrl) {
      console.warn("[WebSocket] Base URL not configured");
      return;
    }
  }, [baseWebSocketUrl, webSocketToken]);

  useEffect(() => {
    const apiEndpoint = import.meta.env.VITE_API_ENDPOINT;
    if (!apiEndpoint) {
      console.warn(
        "[WebSocket] API endpoint not configured; skipping token fetch"
      );
      return;
    }

    let isActive = true;
    let refreshTimeoutId: number | undefined;
    const refreshDelayMs = 14 * 60 * 1000;
    const retryDelayMs = 30 * 1000;

    async function fetchToken() {
      if (!isActive) {
        return;
      }

      try {
        const response = await fetch(`${apiEndpoint}/user/publicToken`);
        if (!response.ok) {
          throw new Error(
            `Token request failed with status ${response.status}`
          );
        }

        const { token } = await response.json();
        if (!isActive) {
          return;
        }

        setWebSocketToken(token);
        scheduleNext(refreshDelayMs);
      } catch (error) {
        console.error("[WebSocket] Failed to fetch streaming token:", error);
        if (!isActive) {
          return;
        }

        setWebSocketToken(null);
        scheduleNext(retryDelayMs);
      }
    }

    function scheduleNext(delay: number) {
      if (!isActive) {
        return;
      }

      if (refreshTimeoutId !== undefined) {
        window.clearTimeout(refreshTimeoutId);
      }

      refreshTimeoutId = window.setTimeout(
        fetchToken,
        delay
      ) as unknown as number;
    }

    fetchToken();

    return () => {
      isActive = false;
      if (refreshTimeoutId !== undefined) {
        window.clearTimeout(refreshTimeoutId);
      }
    };
  }, []);

  // WebSocket message handlers - memoized to prevent unnecessary reconnections
  const handleWebSocketMessage = useCallback(
    (message: any) => {

      switch (message.type) {
        case "start":
          setIsStreaming(true);
          // Update the streaming message to show typing indicator
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
                  ? {
                      ...msg,
                      text: msg.text + message.content,
                      isTyping: false,
                    }
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
          // Handle session name update
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
          if (message.error === 'TOKEN_LIMIT_EXCEEDED') {
            setIsTokenLimitReached(true);
            if (message.token_usage?.reset_at) {
              setTokenResetTime(formatResetTime(message.token_usage.reset_at));
            }
          }
          if (streamingMessageId) {
            setMessages((prev) =>
              prev.map((msg) =>
                msg.id === streamingMessageId
                  ? {
                      ...msg,
                      text: message.message || "An error occurred",
                      isTyping: false,
                    }
                  : msg
              )
            );
          }
          break;
      }
    },
    [streamingMessageId, activeChatSessionId, updateChatSessionName]
  ); // Only recreate when streamingMessageId changes

  const {
    sendMessage: sendWebSocketMessage,
    isConnected,
    connectionState,
    forceReconnect,
  } = useWebSocket(webSocketUrl, {
    onMessage: handleWebSocketMessage,
    onConnect: () => {
      console.log("[WebSocket] Connected");
      console.log("Streaming: ", isStreaming);
    },
    onDisconnect: () => {
      console.log("[WebSocket] Disconnected");
      console.log("Streaming: ", isStreaming);
    },
    onError: (error) => {
      console.error("[WebSocket] Error:", error);
      console.log("Streaming: ", isStreaming);
    },
  });

  const fetchMaxCharactersPerUserMessage = async () => {
    try {
      const tokenResponse = await fetch(
        `${import.meta.env.VITE_API_ENDPOINT}/user/publicToken`
      );
      if (!tokenResponse.ok) {
        throw new Error("Failed to get public token");
      }

      const { token } = await tokenResponse.json();

      const response = await fetch(
        `${import.meta.env.VITE_API_ENDPOINT}/system-settings/max-characters-per-user-message`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      );

      if (!response.ok) {
        throw new Error("Failed to fetch max_characters_per_user_message");
      }

      const data: MaxCharactersResponse = await response.json();

      setMaxCharactersPerUserMessage(
        data.max_characters_per_user_message ??
          DEFAULT_MAX_CHARACTERS_PER_USER_MESSAGE
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
    if (!activeChatSessionId) {
      return;
    }

    // Reset the started ref whenever the active session changes
    // This fixes the bug where AI doesn't start a new conversation after a previous one
    hasStartedRef.current = false;

    const loadChatHistory = async () => {
      setIsLoadingHistory(true);
      try {
        // Get public token
        const tokenResponse = await fetch(
          `${import.meta.env.VITE_API_ENDPOINT}/user/publicToken`
        );
        if (!tokenResponse.ok) throw new Error("Failed to get public token");
        const { token } = await tokenResponse.json();

        const response = await fetch(
          `${import.meta.env.VITE_API_ENDPOINT}/user/${userId}/chat_sessions/${activeChatSessionId}/chat_history`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
            },
          }
        );

        if (!response.ok) throw new Error("Failed to load chat history");

        interface ChatMessageRow {
          id: string;
          chat_session_id: string;
          sender: "user" | "AI";
          content: string;
          sources?: any; // jsonb
          warning?: string | null;
          created_at: string; // ISO
        }

        const data: { messages: ChatMessageRow[] } = await response.json();

        const rawMessages = data.messages || [];
        // Optimized check: Skip first message ONLY if it matches the system prompt
        const startIndex = (rawMessages.length > 0 && rawMessages[0].content === WELCOME_PROMPT) ? 1 : 0;

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
            time: new Date(m.created_at).getTime(),
          };
        });

        // Ensure order (backend already orders, but safe)
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

    // Create bot message placeholder for streaming
    const botMsg: Message = {
      id: `${Date.now() + 1}-${Math.random().toString(36).slice(2, 9)}`,
      sender: "bot",
      text: "",
      sources_used: [],
      time: Date.now() + 1,
      isTyping: true, // Start with typing indicator
    };

    // Add ONLY bot message (no user message)
    setMessages((m) => [...m, botMsg]);
    setStreamingMessageId(botMsg.id);
    setIsStreaming(true);

    const promptText = WELCOME_PROMPT;

    // Try WebSocket streaming first, fallback to HTTP if not connected
    if (isConnected && webSocketUrl) {
      console.log("[WebSocket] Starting conversation via WebSocket");
      const success = sendWebSocketMessage({
        action: "generate_text",
        query: promptText,
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
        const tokenResponse = await fetch(`${import.meta.env.VITE_API_ENDPOINT}/user/publicToken`);
        const { token } = await tokenResponse.json();

        const response = await fetch(
          `${import.meta.env.VITE_API_ENDPOINT}/chat_sessions/${activeChatSessionId}/text_generation`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
              query: promptText,
              chat_session_id: activeChatSessionId,
              user_id: userId,
              is_intro_message: true,
            }),
          }
        );

        if (!response.ok) {
          if (response.status === 429) {
            const errData = await response.json();
            if (errData.error === 'TOKEN_LIMIT_EXCEEDED') {
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
              ? {
                  ...msg,
                  text: "Sorry, there was an error processing your request.",
                  isTyping: false,
                }
              : msg
          )
        );
      } finally {
        setIsStreaming(false);
        setStreamingMessageId(null);
      }
    }
  }, [activeChatSessionId, userId, isConnected, webSocketUrl, sendWebSocketMessage, forceReconnect, updateChatSessionName]);

  // Auto-start conversation if history is empty
  useEffect(() => {
    if (!isLoadingHistory && messages.length === 0 && activeChatSessionId && !hasStartedRef.current) {
      startConversation();
    }
  }, [isLoadingHistory, messages.length, activeChatSessionId, startConversation]);

  async function sendMessage() {
    if (isStreaming) return;

    let text = message.trim();
    if (!text) return;

    // Ensure we have an active chat session
    if (!activeChatSessionId) return;

    // Create user message for AI generation
    const userMsg: Message = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      sender: "user",
      text,
      time: Date.now(),
      hasPII: detectPII(text).hasPII,
    };

    // Create bot message placeholder for streaming
    const botMsg: Message = {
      id: `${Date.now() + 1}-${Math.random().toString(36).slice(2, 9)}`,
      sender: "bot",
      text: "",
      sources_used: [],
      time: Date.now() + 1,
      isTyping: true, // Start with typing indicator
    };

    // Add user and bot messages
    setMessages((m) => [...m, userMsg, botMsg]);
    setStreamingMessageId(botMsg.id);
    setIsStreaming(true);

    // Clear the input box text immediately 
    setMessage("");

    // Try WebSocket streaming first, fallback to HTTP if not connected
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
        console.warn(
          "[WebSocket] Message send failed. Attempting reconnect..."
        );
        forceReconnect();
      }
    } else {
      console.warn(
        `[WebSocket] Not connected (state: ${connectionState}). Falling back to HTTP.`
      );
    }

    // Fallback to HTTP API if WebSocket is not available
    console.log("[WebSocket] Fallback: Sending message via HTTP API...");

    // Show typing indicator for HTTP fallback
    setMessages((prev) =>
      prev.map((msg) =>
        msg.id === botMsg.id ? { ...msg, isTyping: true } : msg
      )
    );

    try {
      // Get fresh token for the request
      const tokenResponse = await fetch(
        `${import.meta.env.VITE_API_ENDPOINT}/user/publicToken`
      );
      const { token } = await tokenResponse.json();
      const response = await fetch(
        `${import.meta.env.VITE_API_ENDPOINT
        }/chat_sessions/${activeChatSessionId}/text_generation`,
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

      // Update the bot message with the complete response
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

      // Handle session name update for HTTP fallback
      if (data.session_name && activeChatSessionId) {
        updateChatSessionName(activeChatSessionId, data.session_name);
      }
    } catch (error) {
      console.error("Error generating text:", error);
      // Update the bot message with error
      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === botMsg.id
            ? {
                ...msg,
                text: "Sorry, there was an error processing your request.",
                isTyping: false,
              }
            : msg
        )
      );
    } finally {
      setIsStreaming(false);
      setStreamingMessageId(null);
    }
  }



  function messageFormatter(message: Message) {
    if (message.sender === "user") {
      return (
        <UserChatMessage
          key={message.id}
          text={message.text}
          hasPII={message.hasPII}
        />
      );
    } else {
    return (
      <AIChatMessage
        key={message.id}
        text={message.text}
        sources={message.sources_used}
        warning={message.warning}
        isTyping={message.isTyping}
      />
    );
    }
  }

  return (
    <div className="flex flex-col h-full min-h-0 w-full">
      {messages.length === 0 ? (
        // Empty state (Centered)
        <div className="flex-1 flex flex-col items-center justify-center text-center pb-12 w-full max-w-2xl 2xl:max-w-3xl mx-auto px-4">
          <h1 className="text-4xl font-bold mb-4 leading-tight max-w-full break-words">
            What can I help with?
          </h1>
        </div>
      ) : (
        // Scrollable messages area (Full width for edge scrollbar)
        <div className="flex-1 overflow-y-auto overscroll-contain chat-scrollbar w-full">
          <div className="w-full max-w-2xl 2xl:max-w-3xl mx-auto flex flex-col gap-4 pt-4 pb-2 px-4">
            {isLoadingHistory ? (
              <div className="flex items-center justify-center py-8">
                <p className="text-muted-foreground">Loading chat history...</p>
              </div>
            ) : (
              <>
                {messages.map((m) => messageFormatter(m))}
                {/* Keep the ref right at the bottom of the scrollable list */}
                <div ref={messagesEndRef} className="h-4 shrink-0" />
              </>
            )}
          </div>
        </div>
      )}

      {/* Statically bolted input area at the bottom */}
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
                      ? "Specialization Explorer is thinking..."
                      : "Message Specialization Explorer..."
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
