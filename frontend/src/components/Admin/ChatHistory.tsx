import { useState, useEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import rehypeSanitize from "rehype-sanitize";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Bot, User, MessageSquare, ChevronDown, ChevronRight, Clock, RefreshCw, ThumbsUp, ThumbsDown, Info, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AuthService } from "@/functions/authService";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------
const CACHE_TTL: Record<string, number> = {
    groups:      60 * 60 * 1000,  // 1 hour  — only changes when Glue runs
    group_users: 15 * 60 * 1000,  // 15 min  — changes on user sign-in
    sessions:     5 * 60 * 1000,  // 5 min   — new sessions created continuously
    messages:     5 * 60 * 1000,  // 5 min   — messages are append-only
};

const getTtl = (key: string): number => {
    if (key.startsWith("admin_chat_groups_")) return CACHE_TTL.groups;
    if (key.startsWith("admin_chat_group_users_")) return CACHE_TTL.group_users;
    if (key.startsWith("admin_chat_sessions_")) return CACHE_TTL.sessions;
    return CACHE_TTL.messages;
};

const clearAdminCache = () => {
    Object.keys(localStorage).forEach(key => {
        if (key.startsWith("admin_chat_")) localStorage.removeItem(key);
    });
};

const getCached = (key: string) => {
    try {
        const item = localStorage.getItem(key);
        if (!item) return null;
        const parsed = JSON.parse(item);
        if (Date.now() - parsed.timestamp > getTtl(key)) { localStorage.removeItem(key); return null; }
        return parsed.data;
    } catch { return null; }
};

const setCached = (key: string, data: any) => {
    try {
        localStorage.setItem(key, JSON.stringify({ timestamp: Date.now(), data }));
    } catch {
        clearAdminCache();
        try { localStorage.setItem(key, JSON.stringify({ timestamp: Date.now(), data })); } catch { }
    }
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type EntraGroup = {
    id: string;
    display_name: string;
    member_count: number;
};

type GroupUser = {
    id: string;
    email: string;
    display_name: string;
    last_seen_at?: string;
};

type ChatSession = {
    id: string;
    user_id: string;
    title: string;
    created_at: string;
    last_active_at: string;
};

type ChatMessage = {
    id: string;
    chat_session_id: string;
    sender: "user" | "AI" | "system";
    content: string;
    created_at: string;
    sources?: any[];
    rating?: { is_positive: boolean; comment: string | null } | null;
};

type PaginationState = { offset: number; total: number; hasMore: boolean };


const UNASSIGNED_ID = "__unassigned__";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export default function ChatHistory() {
    // Groups
    const [groups, setGroups] = useState<EntraGroup[]>([]);
    const [groupsPagination, setGroupsPagination] = useState<PaginationState>({ offset: 0, total: 0, hasMore: false });
    const [loadingGroups, setLoadingGroups] = useState(false);
    const [loadingMoreGroups, setLoadingMoreGroups] = useState(false);
    const [expandedGroupIds, setExpandedGroupIds] = useState<Set<string>>(new Set());

    // Users per group — keyed by groupId
    const [groupUsers, setGroupUsers] = useState<Record<string, GroupUser[]>>({});
    const [groupUsersPagination, setGroupUsersPagination] = useState<Record<string, PaginationState>>({});
    const [loadingGroupUsers, setLoadingGroupUsers] = useState<Record<string, boolean>>({});
    const [expandedUserKeys, setExpandedUserKeys] = useState<Set<string>>(new Set()); // `${groupId}:${userId}`

    // Sessions per user — keyed by userId (shared across groups, sessions are same)
    const [userSessions, setUserSessions] = useState<Record<string, ChatSession[]>>({});
    const [userSessionsPagination, setUserSessionsPagination] = useState<Record<string, PaginationState>>({});
    const [loadingUserSessions, setLoadingUserSessions] = useState<Record<string, boolean>>({});

    // Messages
    const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [loadingMessages, setLoadingMessages] = useState(false);

    // Export
    const [triggeringExport, setTriggeringExport] = useState<string | null>(null);
    const [exportToast, setExportToast] = useState(false);
    const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const GROUP_LIMIT = 20;
    const USER_LIMIT = 10;
    const SESSION_LIMIT = 20;

    useEffect(() => { fetchGroups(0, false); }, []);
    useEffect(() => () => { if (toastTimerRef.current) clearTimeout(toastTimerRef.current); }, []);

    const getAuthHeaders = async () => ({
        Authorization: await AuthService.getIdToken(),
        "Content-Type": "application/json",
    });

    // ---------------------------------------------------------------------------
    // Fetch groups (paginated, append on load-more)
    // ---------------------------------------------------------------------------
    const fetchGroups = async (offset: number, append: boolean, forceRefresh = false) => {
        const cacheKey = `admin_chat_groups_${offset}`;
        if (!forceRefresh && !append) {
            const cached = getCached(cacheKey);
            if (cached) {
                setGroups(cached.groups);
                setGroupsPagination(cached.pagination);
                return;
            }
        }

        offset === 0 ? setLoadingGroups(true) : setLoadingMoreGroups(true);
        try {
            const headers = await getAuthHeaders();
            const res = await fetch(
                `${import.meta.env.VITE_API_ENDPOINT}/admin/entra_groups?limit=${GROUP_LIMIT}&offset=${offset}`,
                { headers }
            );
            if (!res.ok) throw new Error("Failed to fetch groups");
            const data = await res.json();
            const pagination: PaginationState = {
                offset,
                total: data.total,
                hasMore: offset + data.groups.length < data.total,
            };
            setGroups(prev => append ? [...prev, ...data.groups] : data.groups);
            setGroupsPagination(pagination);
            if (!append) setCached(cacheKey, { groups: data.groups, pagination });
        } catch (e) {
            console.error(e);
        } finally {
            setLoadingGroups(false);
            setLoadingMoreGroups(false);
        }
    };

    // ---------------------------------------------------------------------------
    // Fetch users in a group (paginated, append on load-more)
    // ---------------------------------------------------------------------------
    const fetchGroupUsers = async (groupId: string, offset: number, append: boolean, forceRefresh = false) => {
        const cacheKey = `admin_chat_group_users_${groupId}_${offset}`;
        if (!forceRefresh && !append) {
            const cached = getCached(cacheKey);
            if (cached) {
                setGroupUsers(prev => ({ ...prev, [groupId]: append ? [...(prev[groupId] ?? []), ...cached.users] : cached.users }));
                setGroupUsersPagination(prev => ({ ...prev, [groupId]: cached.pagination }));
                return;
            }
        }

        const url = groupId === UNASSIGNED_ID
            ? `${import.meta.env.VITE_API_ENDPOINT}/admin/entra_groups/unassigned/users?limit=${USER_LIMIT}&offset=${offset}`
            : `${import.meta.env.VITE_API_ENDPOINT}/admin/entra_groups/${groupId}/users?limit=${USER_LIMIT}&offset=${offset}`;

        setLoadingGroupUsers(prev => ({ ...prev, [groupId]: true }));
        try {
            const headers = await getAuthHeaders();
            const res = await fetch(url, { headers });
            if (!res.ok) throw new Error("Failed to fetch group users");
            const data = await res.json();
            const pagination: PaginationState = {
                offset,
                total: data.total,
                hasMore: offset + data.users.length < data.total,
            };
            setGroupUsers(prev => ({ ...prev, [groupId]: append ? [...(prev[groupId] ?? []), ...data.users] : data.users }));
            setGroupUsersPagination(prev => ({ ...prev, [groupId]: pagination }));
            if (!append) setCached(cacheKey, { users: data.users, pagination });
        } catch (e) {
            console.error(e);
        } finally {
            setLoadingGroupUsers(prev => ({ ...prev, [groupId]: false }));
        }
    };

    // ---------------------------------------------------------------------------
    // Fetch sessions for a user
    // ---------------------------------------------------------------------------
    const fetchUserSessions = async (userId: string, offset: number, append: boolean, forceRefresh = false) => {
        const cacheKey = `admin_chat_sessions_${userId}_${offset}`;
        if (!forceRefresh && !append) {
            const cached = getCached(cacheKey);
            if (cached) {
                setUserSessions(prev => ({ ...prev, [userId]: append ? [...(prev[userId] ?? []), ...cached.sessions] : cached.sessions }));
                setUserSessionsPagination(prev => ({ ...prev, [userId]: cached.pagination }));
                return;
            }
        }

        setLoadingUserSessions(prev => ({ ...prev, [userId]: true }));
        try {
            const headers = await getAuthHeaders();
            const res = await fetch(
                `${import.meta.env.VITE_API_ENDPOINT}/admin/users/${userId}/chat_sessions?limit=${SESSION_LIMIT}&offset=${offset}`,
                { headers }
            );
            if (!res.ok) throw new Error("Failed to fetch sessions");
            const data = await res.json();
            const sessions = Array.isArray(data) ? data : [];
            // The existing endpoint doesn't return total — infer hasMore from returned count
            const pagination: PaginationState = {
                offset,
                total: -1, // unknown
                hasMore: sessions.length === SESSION_LIMIT,
            };
            setUserSessions(prev => ({ ...prev, [userId]: append ? [...(prev[userId] ?? []), ...sessions] : sessions }));
            setUserSessionsPagination(prev => ({ ...prev, [userId]: pagination }));
            if (!append) setCached(cacheKey, { sessions, pagination });
        } catch (e) {
            console.error(e);
        } finally {
            setLoadingUserSessions(prev => ({ ...prev, [userId]: false }));
        }
    };

    // ---------------------------------------------------------------------------
    // Fetch messages for a session
    // ---------------------------------------------------------------------------
    const fetchMessages = async (sessionId: string, forceRefresh = false) => {
        const cacheKey = `admin_chat_messages_${sessionId}`;
        if (!forceRefresh) {
            const cached = getCached(cacheKey);
            if (cached) { setMessages(cached); return; }
        }

        setLoadingMessages(true);
        try {
            const headers = await getAuthHeaders();
            const res = await fetch(
                `${import.meta.env.VITE_API_ENDPOINT}/admin/chat_sessions/${sessionId}/messages?limit=200&offset=0`,
                { headers }
            );
            if (!res.ok) throw new Error("Failed to fetch messages");
            const data = await res.json();
            const msgs = (Array.isArray(data) ? data : []).map((msg: any) => ({
                ...msg,
                sources: typeof msg.sources === "string" ? JSON.parse(msg.sources) : (msg.sources ?? []),
            }));
            setMessages(msgs);
            setCached(cacheKey, msgs);
        } catch (e) {
            console.error(e);
        } finally {
            setLoadingMessages(false);
        }
    };

    // ---------------------------------------------------------------------------
    // Interaction handlers
    // ---------------------------------------------------------------------------
    const toggleGroup = (groupId: string) => {
        setExpandedGroupIds(prev => {
            const next = new Set(prev);
            if (next.has(groupId)) {
                next.delete(groupId);
            } else {
                next.add(groupId);
                if (!groupUsers[groupId]) fetchGroupUsers(groupId, 0, false);
            }
            return next;
        });
    };

    const toggleUser = (groupId: string, userId: string) => {
        const key = `${groupId}:${userId}`;
        setExpandedUserKeys(prev => {
            const next = new Set(prev);
            if (next.has(key)) {
                next.delete(key);
            } else {
                next.add(key);
                if (!userSessions[userId]) fetchUserSessions(userId, 0, false);
            }
            return next;
        });
    };

    const handleSessionSelect = (sessionId: string) => {
        setSelectedSessionId(sessionId);
        setMessages([]);
        fetchMessages(sessionId);
    };

    const handleRefresh = () => {
        clearAdminCache();
        setGroups([]);
        setGroupUsers({});
        setUserSessions({});
        setMessages([]);
        setExpandedGroupIds(new Set());
        setExpandedUserKeys(new Set());
        setSelectedSessionId(null);
        fetchGroups(0, false, true);
    };

    // ---------------------------------------------------------------------------
    // Export
    // ---------------------------------------------------------------------------
    const triggerExport = async (scope: 'all' | 'group' | 'user', scopeId?: string) => {
        const key = scope + (scopeId ?? '');
        setTriggeringExport(key);
        try {
            const headers = await getAuthHeaders();
            const res = await fetch(
                `${import.meta.env.VITE_API_ENDPOINT}/admin/export/trigger`,
                {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({ scope, ...(scopeId ? { scope_id: scopeId } : {}) }),
                }
            );
            if (!res.ok) throw new Error("Failed to trigger export");
            setExportToast(true);
            if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
            toastTimerRef.current = setTimeout(() => setExportToast(false), 6000);
        } catch (e) {
            console.error(e);
        } finally {
            setTriggeringExport(null);
        }
    };

    // ---------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------
    const formatDate = (d?: string) => {
        if (!d) return "";
        return new Date(d).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    };

    const formatSource = (source: any) => {
        const uri = source?.source_url || source?.url || source?.uri || (typeof source === "string" ? source : "");
        const title = source?.title || "";
        const content = source?.content || "";
        const isSafe = uri && (uri.startsWith("https://") || uri.startsWith("http://"));
        return (
            <div className="flex flex-col gap-1 w-full text-left">
                {title && <div className="text-[11px] font-semibold text-gray-800">{title}</div>}
                {uri && (
                    <div className="break-all text-[11px] font-medium text-primary">
                        <a href={isSafe ? uri : "#"} target="_blank" rel="noopener noreferrer" className="hover:underline">{uri}</a>
                    </div>
                )}
                {content && <div className="text-[11px] text-gray-500 italic pl-2 border-l-2 border-gray-200">"{content}"</div>}
            </div>
        );
    };

    // ---------------------------------------------------------------------------
    // Render
    // ---------------------------------------------------------------------------
    return (
        <div className="space-y-8 max-w-7xl mx-auto animate-in fade-in duration-500 flex flex-col h-[calc(100vh-8rem)]">
            <div className="flex-shrink-0 flex items-center justify-between">
                <div>
                    <h2 className="text-3xl font-bold text-gray-900">Chat History</h2>
                    <p className="text-gray-500 mt-1">Browse conversations by Entra group.</p>
                </div>
                <div className="flex items-center gap-2">
                    <button
                        onClick={() => triggerExport('all')}
                        disabled={triggeringExport === 'all'}
                        className="flex items-center gap-2 px-4 py-2 bg-white border border-gray-200 rounded-lg text-sm font-medium text-gray-600 hover:bg-gray-50 hover:text-gray-900 transition-colors shadow-sm disabled:opacity-50"
                    >
                        <Download size={16} className={triggeringExport === 'all' ? "animate-pulse text-primary" : ""} />
                        Export All
                    </button>
                    <button
                        onClick={handleRefresh}
                        className="flex items-center gap-2 px-4 py-2 bg-white border border-gray-200 rounded-lg text-sm font-medium text-gray-600 hover:bg-gray-50 hover:text-gray-900 transition-colors shadow-sm"
                    >
                        <RefreshCw size={16} className={loadingGroups ? "animate-spin text-primary" : ""} />
                        Refresh Data
                    </button>
                </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 flex-1 min-h-0">

                {/* Left column: Groups → Users → Sessions */}
                <Card className="md:col-span-1 border-gray-200 shadow-sm flex flex-col overflow-hidden h-full">
                    <CardHeader className="flex-shrink-0 border-b pb-4">
                        <CardTitle className="flex items-center gap-2 text-lg">
                            <User className="h-5 w-5 text-primary" />
                            Groups & Users
                        </CardTitle>
                        <CardDescription className="text-xs">
                            Expand a group to see its members and their sessions.
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="flex-1 overflow-y-auto p-0">
                        {loadingGroups ? (
                            <div className="text-center text-gray-500 py-10">Loading groups…</div>
                        ) : groups.length === 0 ? (
                            <div className="text-center text-gray-500 py-10">No groups found. Run the Glue ingestion job first.</div>
                        ) : (
                            <div className="p-3 space-y-2">
                                {groups.map(group => (
                                    <GroupRow
                                        key={group.id}
                                        group={group}
                                        expanded={expandedGroupIds.has(group.id)}
                                        onToggle={() => toggleGroup(group.id)}
                                        users={groupUsers[group.id] ?? []}
                                        usersPagination={groupUsersPagination[group.id]}
                                        loadingUsers={!!loadingGroupUsers[group.id]}
                                        onLoadMoreUsers={() => {
                                            const p = groupUsersPagination[group.id];
                                            if (p) fetchGroupUsers(group.id, p.offset + USER_LIMIT, true);
                                        }}
                                        expandedUserKeys={expandedUserKeys}
                                        onToggleUser={(userId) => toggleUser(group.id, userId)}
                                        userSessions={userSessions}
                                        userSessionsPagination={userSessionsPagination}
                                        loadingUserSessions={loadingUserSessions}
                                        onLoadMoreSessions={(userId) => {
                                            const p = userSessionsPagination[userId];
                                            if (p) fetchUserSessions(userId, p.offset + SESSION_LIMIT, true);
                                        }}
                                        selectedSessionId={selectedSessionId}
                                        onSelectSession={handleSessionSelect}
                                        formatDate={formatDate}
                                        onExportGroup={(groupId) => triggerExport('group', groupId)}
                                        onExportUser={(userId) => triggerExport('user', userId)}
                                        exportingKey={triggeringExport}
                                    />
                                ))}

                                {/* Load more groups */}
                                {groupsPagination.hasMore && (
                                    <button
                                        onClick={() => fetchGroups(groupsPagination.offset + GROUP_LIMIT, true)}
                                        disabled={loadingMoreGroups}
                                        className="w-full text-xs text-primary hover:underline py-2 disabled:opacity-40"
                                    >
                                        {loadingMoreGroups ? "Loading…" : `Load more groups (${groups.length} / ${groupsPagination.total})`}
                                    </button>
                                )}

                                {/* Unassigned virtual group — always shown at the bottom */}
                                <GroupRow
                                    key={UNASSIGNED_ID}
                                    group={{ id: UNASSIGNED_ID, display_name: "Unassigned", member_count: groupUsersPagination[UNASSIGNED_ID]?.total ?? 0 }}
                                    expanded={expandedGroupIds.has(UNASSIGNED_ID)}
                                    onToggle={() => toggleGroup(UNASSIGNED_ID)}
                                    users={groupUsers[UNASSIGNED_ID] ?? []}
                                    usersPagination={groupUsersPagination[UNASSIGNED_ID]}
                                    loadingUsers={!!loadingGroupUsers[UNASSIGNED_ID]}
                                    onLoadMoreUsers={() => {
                                        const p = groupUsersPagination[UNASSIGNED_ID];
                                        if (p) fetchGroupUsers(UNASSIGNED_ID, p.offset + USER_LIMIT, true);
                                    }}
                                    expandedUserKeys={expandedUserKeys}
                                    onToggleUser={(userId) => toggleUser(UNASSIGNED_ID, userId)}
                                    userSessions={userSessions}
                                    userSessionsPagination={userSessionsPagination}
                                    loadingUserSessions={loadingUserSessions}
                                    onLoadMoreSessions={(userId) => {
                                        const p = userSessionsPagination[userId];
                                        if (p) fetchUserSessions(userId, p.offset + SESSION_LIMIT, true);
                                    }}
                                    selectedSessionId={selectedSessionId}
                                    onSelectSession={handleSessionSelect}
                                    formatDate={formatDate}
                                    exportingKey={triggeringExport}
                                    isVirtual
                                />
                            </div>
                        )}
                    </CardContent>
                </Card>

                {/* Right column: Conversation viewer */}
                <Card className="md:col-span-2 border-gray-200 shadow-sm flex flex-col overflow-hidden h-full">
                    <CardHeader className="flex-shrink-0 border-b pb-4 bg-gray-50/50">
                        <CardTitle className="text-lg flex items-center gap-2">
                            <Bot className="h-5 w-5 text-primary" />
                            Conversation
                        </CardTitle>
                        <CardDescription className="text-xs">
                            {selectedSessionId ? "Transcript of selected session." : "Select a session to view the transcript."}
                        </CardDescription>
                    </CardHeader>

                    <CardContent className="flex-1 overflow-y-auto p-6 md:p-8 bg-white relative">
                        {!selectedSessionId ? (
                            <div className="flex h-full flex-col items-center justify-center text-gray-400 gap-4">
                                <MessageSquare className="h-12 w-12 text-gray-200" />
                                <p className="text-lg">Select a chat session to view the conversation</p>
                            </div>
                        ) : loadingMessages ? (
                            <div className="flex h-full items-center justify-center">
                                <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-primary" />
                            </div>
                        ) : messages.length === 0 ? (
                            <div className="flex h-full items-center justify-center text-gray-400">
                                <p className="text-lg">This session has no messages yet.</p>
                            </div>
                        ) : (
                            <div className="space-y-6">
                                {messages.map((msg, idx) => {
                                    const isUser = msg.sender.toLowerCase() === "user";
                                    return (
                                        <div key={msg.id || idx} className={cn("flex flex-col max-w-[85%]", isUser ? "ml-auto" : "mr-auto")}>
                                            <div className={cn("flex items-center gap-2 mb-1 text-xs", isUser ? "justify-end text-gray-500" : "text-gray-500")}>
                                                <span className="font-semibold">{isUser ? "User" : "Assistant"}</span>
                                                <span className="text-xs opacity-75">{formatDate(msg.created_at)}</span>
                                            </div>
                                            <div className={cn(
                                                "p-5 rounded-2xl shadow-sm text-[15px] leading-relaxed",
                                                isUser
                                                    ? "bg-primary text-primary-foreground rounded-tr-sm"
                                                    : "bg-gray-50 border border-gray-200 text-gray-800 rounded-tl-sm shadow-md"
                                            )}>
                                                {isUser ? (
                                                    <span className="whitespace-pre-wrap">{msg.content}</span>
                                                ) : (
                                                    <ReactMarkdown
                                                        remarkPlugins={[remarkGfm]}
                                                        rehypePlugins={[rehypeSanitize, rehypeHighlight]}
                                                        components={{
                                                            h1: ({ ...props }) => <h1 className="text-xl font-bold mb-4 mt-6" {...props} />,
                                                            h2: ({ ...props }) => <h2 className="text-lg font-bold mb-3 mt-5" {...props} />,
                                                            h3: ({ ...props }) => <h3 className="text-base font-bold mb-2 mt-4" {...props} />,
                                                            p: ({ ...props }) => <p className="mb-4 last:mb-0" {...props} />,
                                                            ul: ({ ...props }) => <ul className="list-disc pl-5 mb-4" {...props} />,
                                                            ol: ({ ...props }) => <ol className="list-decimal pl-5 mb-4" {...props} />,
                                                            li: ({ ...props }) => <li className="mb-1" {...props} />,
                                                            a: ({ ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline" />,
                                                            code: ({ className, children, ...props }: any) => {
                                                                const isInline = !(/language-(\w+)/.exec(className || "")) && props.inline;
                                                                return isInline
                                                                    ? <code className="px-1 py-0.5 bg-muted rounded text-xs" {...props}>{children}</code>
                                                                    : <code className="block p-2 bg-muted rounded-md text-xs overflow-auto" {...props}>{children}</code>;
                                                            },
                                                            pre: ({ ...props }) => <pre className="bg-muted p-2 rounded-md overflow-auto text-xs my-2" {...props} />,
                                                            blockquote: ({ ...props }) => <blockquote className="pl-4 border-l-4 border-muted italic my-4" {...props} />,
                                                            table: ({ ...props }) => <div className="overflow-x-auto"><table className="border-collapse border border-muted text-xs w-full my-4" {...props} /></div>,
                                                            th: ({ ...props }) => <th className="border border-muted px-2 py-1 bg-muted" {...props} />,
                                                            td: ({ ...props }) => <td className="border border-muted px-2 py-1" {...props} />,
                                                        }}
                                                    >
                                                        {msg.content}
                                                    </ReactMarkdown>
                                                )}
                                            </div>
                                            {msg.sender === "AI" && msg.rating && (
                                                <div className="mt-2 flex items-center gap-2 text-xs text-gray-500">
                                                    <span className="font-medium text-gray-400">User's Rating:</span>
                                                    <div className={cn(
                                                        "inline-flex items-center gap-1 px-2 py-0.5 rounded-full font-medium border",
                                                        msg.rating.is_positive
                                                            ? "bg-green-50 text-green-700 border-green-200"
                                                            : "bg-red-50 text-red-600 border-red-200"
                                                    )}>
                                                        {msg.rating.is_positive ? <ThumbsUp size={10} /> : <ThumbsDown size={10} />}
                                                        {msg.rating.is_positive ? "Helpful" : "Not helpful"}
                                                    </div>
                                                    {msg.rating.comment && (
                                                        <span className="text-gray-500 italic">"{msg.rating.comment}"</span>
                                                    )}
                                                </div>
                                            )}
                                            {msg.sender === "AI" && msg.sources && msg.sources.length > 0 && (
                                                <div className="mt-2 w-full">
                                                    <details className="w-full group">
                                                        <summary className="cursor-pointer text-xs text-blue-600 hover:text-blue-800 font-medium select-none flex items-center gap-1">
                                                            <ChevronRight size={14} className="group-open:rotate-90 transition-transform" />
                                                            View Sources ({msg.sources.length})
                                                        </summary>
                                                        <div className="mt-2 space-y-2 pl-4 border-l-2 border-blue-100">
                                                            {msg.sources.map((source, sIdx) => (
                                                                <div key={sIdx} className="bg-gray-50 p-2 rounded border border-gray-100">
                                                                    {formatSource(source)}
                                                                </div>
                                                            ))}
                                                        </div>
                                                    </details>
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </CardContent>
                </Card>
            </div>

        </div>
    );
}

// ---------------------------------------------------------------------------
// GroupRow sub-component
// ---------------------------------------------------------------------------
type GroupRowProps = {
    group: EntraGroup;
    expanded: boolean;
    onToggle: () => void;
    users: GroupUser[];
    usersPagination?: PaginationState;
    loadingUsers: boolean;
    onLoadMoreUsers: () => void;
    expandedUserKeys: Set<string>;
    onToggleUser: (userId: string) => void;
    userSessions: Record<string, ChatSession[]>;
    userSessionsPagination: Record<string, PaginationState>;
    loadingUserSessions: Record<string, boolean>;
    onLoadMoreSessions: (userId: string) => void;
    selectedSessionId: string | null;
    onSelectSession: (sessionId: string) => void;
    formatDate: (d?: string) => string;
    isVirtual?: boolean;
    onExportGroup?: (groupId: string) => void;
    onExportUser?: (userId: string) => void;
    exportingKey?: string | null;
};

function GroupRow({
    group, expanded, onToggle,
    users, usersPagination, loadingUsers, onLoadMoreUsers,
    expandedUserKeys, onToggleUser,
    userSessions, userSessionsPagination, loadingUserSessions, onLoadMoreSessions,
    selectedSessionId, onSelectSession, formatDate, isVirtual, onExportGroup, onExportUser, exportingKey,
}: GroupRowProps) {
    const [showId, setShowId] = useState(false);
    const tooltipRef = useRef<HTMLDivElement>(null);

    return (
        <div className="w-full bg-white border border-gray-100 rounded-xl overflow-hidden shadow-sm transition-all hover:shadow-md">
            {/* Group header */}
            <div className="flex items-center justify-between p-4 hover:bg-gray-50 transition-colors">
                <button onClick={onToggle} className="flex items-center gap-2 flex-1 text-left min-w-0">
                    {expanded ? <ChevronDown size={16} className="text-gray-400 flex-shrink-0" /> : <ChevronRight size={16} className="text-gray-400 flex-shrink-0" />}
                    <span className="font-semibold text-sm text-gray-900 truncate">{group.display_name}</span>
                    <span className="text-xs text-gray-400 flex-shrink-0">({group.member_count})</span>
                </button>
                {/* Export + (i) tooltip — hidden for virtual groups */}
                {!isVirtual && (
                    <div className="flex items-center gap-1 flex-shrink-0 ml-2">
                        {onExportGroup && (
                            <button
                                onClick={(e) => { e.stopPropagation(); onExportGroup(group.id); }}
                                disabled={exportingKey === 'group' + group.id}
                                className="p-1 text-gray-300 hover:text-primary transition-colors disabled:opacity-40"
                                aria-label="Export group chats"
                                title="Export group chats"
                            >
                                <Download size={14} className={exportingKey === 'group' + group.id ? "animate-pulse" : ""} />
                            </button>
                        )}
                        <div className="relative" ref={tooltipRef}>
                            <button
                                onMouseEnter={() => setShowId(true)}
                                onMouseLeave={() => setShowId(false)}
                                className="p-1 text-gray-300 hover:text-gray-500 transition-colors"
                                aria-label="Show group ID"
                            >
                                <Info size={14} />
                            </button>
                            {showId && (
                                <div className="absolute right-0 top-6 z-50 bg-gray-900 text-white text-[10px] rounded px-2 py-1 whitespace-nowrap shadow-lg">
                                    {group.id}
                                </div>
                            )}
                        </div>
                    </div>
                )}
            </div>

            {/* Users list */}
            {expanded && (
                <div className="bg-gray-50/70 border-t border-gray-100 p-2 space-y-1">
                    {loadingUsers && users.length === 0 ? (
                        <div className="text-xs text-center text-gray-500 py-2">Loading users…</div>
                    ) : users.length === 0 ? (
                        <div className="text-xs text-center text-gray-400 py-2">No members found.</div>
                    ) : (
                        <>
                            {users.map(user => (
                                <UserRow
                                    key={`${group.id}:${user.id}`}
                                    groupId={group.id}
                                    user={user}
                                    expanded={expandedUserKeys.has(`${group.id}:${user.id}`)}
                                    onToggle={() => onToggleUser(user.id)}
                                    sessions={userSessions[user.id] ?? []}
                                    sessionsPagination={userSessionsPagination[user.id]}
                                    loadingSessions={!!loadingUserSessions[user.id]}
                                    onLoadMoreSessions={() => onLoadMoreSessions(user.id)}
                                    selectedSessionId={selectedSessionId}
                                    onSelectSession={onSelectSession}
                                    formatDate={formatDate}
                                    onExport={onExportUser}
                                    exportingKey={exportingKey}
                                />
                            ))}
                            {usersPagination?.hasMore && (
                                <button
                                    onClick={onLoadMoreUsers}
                                    disabled={loadingUsers}
                                    className="w-full text-[11px] text-primary hover:underline py-1.5 disabled:opacity-40"
                                >
                                    {loadingUsers ? "Loading…" : `Load more users (${users.length} / ${usersPagination.total})`}
                                </button>
                            )}
                        </>
                    )}
                </div>
            )}
        </div>
    );
}

// ---------------------------------------------------------------------------
// UserRow sub-component
// ---------------------------------------------------------------------------
type UserRowProps = {
    groupId: string;
    user: GroupUser;
    expanded: boolean;
    onToggle: () => void;
    sessions: ChatSession[];
    sessionsPagination?: PaginationState;
    loadingSessions: boolean;
    onLoadMoreSessions: () => void;
    selectedSessionId: string | null;
    onSelectSession: (sessionId: string) => void;
    formatDate: (d?: string) => string;
    onExport?: (userId: string) => void;
    exportingKey?: string | null;
};

function UserRow({
    user, expanded, onToggle,
    sessions, sessionsPagination, loadingSessions, onLoadMoreSessions,
    selectedSessionId, onSelectSession, formatDate, onExport, exportingKey,
}: UserRowProps) {
    return (
        <div className="rounded-lg border border-gray-100 bg-white overflow-hidden">
            <div className="flex items-center">
                <button
                    onClick={onToggle}
                    className="flex-1 flex items-center gap-2 px-3 py-2.5 hover:bg-gray-50 transition-colors text-left min-w-0"
                >
                    {expanded ? <ChevronDown size={13} className="text-gray-400 flex-shrink-0" /> : <ChevronRight size={13} className="text-gray-400 flex-shrink-0" />}
                    <User size={13} className="text-gray-400 flex-shrink-0" />
                    <span className="text-xs font-medium text-gray-700 truncate">{user.email}</span>
                </button>
                {onExport && (
                    <button
                        onClick={(e) => { e.stopPropagation(); onExport(user.id); }}
                        disabled={exportingKey === 'user' + user.id}
                        className="flex-shrink-0 px-2 py-2.5 text-gray-300 hover:text-primary transition-colors disabled:opacity-40"
                        aria-label="Export user chats"
                        title="Export user chats"
                    >
                        <Download size={12} className={exportingKey === 'user' + user.id ? "animate-pulse" : ""} />
                    </button>
                )}
            </div>

            {expanded && (
                <div className="border-t border-gray-100 bg-gray-50/50 px-3 py-2 space-y-1">
                    {loadingSessions && sessions.length === 0 ? (
                        <div className="text-[11px] text-gray-400 py-1">Loading sessions…</div>
                    ) : sessions.length === 0 ? (
                        <div className="text-[11px] text-gray-400 py-1">No sessions.</div>
                    ) : (
                        <>
                            {sessions.map((session, idx) => (
                                <button
                                    key={session.id}
                                    onClick={() => onSelectSession(session.id)}
                                    className={cn(
                                        "w-full text-left px-2.5 py-2 rounded-lg border transition-all text-[11px]",
                                        selectedSessionId === session.id
                                            ? "bg-white border-primary shadow-sm ring-1 ring-primary/20 text-primary"
                                            : "bg-white border-gray-200 hover:border-primary/40 text-gray-600"
                                    )}
                                >
                                    <div className="flex items-center gap-1.5 mb-0.5">
                                        <MessageSquare size={10} className="flex-shrink-0" />
                                        <span className="font-medium truncate">{session.title || `Chat ${idx + 1}`}</span>
                                    </div>
                                    <div className="flex items-center gap-1 text-[10px] text-gray-400 pl-3.5">
                                        <Clock size={9} />
                                        {formatDate(session.created_at)}
                                    </div>
                                </button>
                            ))}
                            {sessionsPagination?.hasMore && (
                                <button
                                    onClick={onLoadMoreSessions}
                                    disabled={loadingSessions}
                                    className="w-full text-[10px] text-primary hover:underline py-1 disabled:opacity-40"
                                >
                                    {loadingSessions ? "Loading…" : "Load more sessions"}
                                </button>
                            )}
                        </>
                    )}
                </div>
            )}
        </div>
    );
}
