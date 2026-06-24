import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useSidebar } from "@/providers/sidebar";
import { useNavigate } from "react-router";
import { Separator } from "@/components/ui/separator";
import { useView } from "@/providers/view";
import { ChevronLeft, ChevronRight, ExternalLink, FolderOpen, Plus, MessageSquare } from "lucide-react";
import ChatSessionActionsMenu from "./ChatSessionActionsMenu";
import { AuthService } from "@/functions/authService";
import UserProfilePopover from "@/components/UserProfilePopover";
import { useUser } from "@/providers/user";
import { fetchAuthSession } from "aws-amplify/auth";

type Source = { id: string; name: string; source_url: string | null };

const sourcesCache = new Map<string, { sources: Source[]; fetchedAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000;
const PAGE_SIZE = 5;

type SidebarContentProps = {
  setMobileOpen: (open: boolean) => void;
};

function SidebarContent({ setMobileOpen }: SidebarContentProps) {
  const navigate = useNavigate();
  const { userId } = useUser();
  const {
    chatSessions,
    activeChatSessionId,
    setActiveChatSessionId,
    createNewChatSession,
    removeChatSession,
  } = useView();

  const [sources, setSources] = useState<Source[]>([]);
  const [loadingSources, setLoadingSources] = useState(false);
  const [sourcePage, setSourcePage] = useState(0);
  const fetchedRef = useRef(false);

  useEffect(() => {
    if (!userId || fetchedRef.current) return;

    const cached = sourcesCache.get(userId);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      setSources(cached.sources);
      fetchedRef.current = true;
      return;
    }

    const load = async () => {
      setLoadingSources(true);
      try {
        const token = (await fetchAuthSession()).tokens?.idToken?.toString();
        const res = await fetch(
          `${import.meta.env.VITE_API_ENDPOINT}/user/${userId}/accessible_sources`,
          { headers: { Authorization: token! } }
        );
        if (res.ok) {
          const data = await res.json();
          sourcesCache.set(userId, { sources: data.sources, fetchedAt: Date.now() });
          setSources(data.sources);
          fetchedRef.current = true;
        }
      } catch {
        // non-fatal
      } finally {
        setLoadingSources(false);
      }
    };

    load();
  }, [userId]);

  const totalPages = Math.ceil(sources.length / PAGE_SIZE);
  const pagedSources = sources.slice(sourcePage * PAGE_SIZE, (sourcePage + 1) * PAGE_SIZE);

  const handleNewChat = async () => {
    const newSession = await createNewChatSession();
    if (newSession) {
      navigate(`/chat`);
      setMobileOpen(false);
    }
  };

  const handleSelectSession = (sessionId: string) => {
    setActiveChatSessionId(sessionId);
    navigate(`/chat`);
    setMobileOpen(false);
  };

  return (
    <>
      {/* SharePoint Lists */}
      <div className="mb-4">
        <h3 className="px-3 text-xs font-semibold text-muted-foreground tracking-wide mb-2">
          SHAREPOINT LISTS
        </h3>
        <div className="pl-2 border-l-2 border-muted space-y-1">
          {loadingSources ? (
            <p className="px-3 text-xs text-muted-foreground">Loading...</p>
          ) : sources.length === 0 ? (
            <p className="px-3 text-xs text-muted-foreground">None assigned</p>
          ) : (
            <>
              {pagedSources.map((s) =>
                s.source_url ? (
                  <a
                    key={s.id}
                    href={s.source_url}
                    target="_blank"
                    rel="noreferrer"
                    title={s.name}
                    className="flex items-center gap-2 rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground hover:bg-accent/30 transition-colors group"
                  >
                    <FolderOpen className="h-3.5 w-3.5 flex-shrink-0" />
                    <span className="flex-1 truncate">{s.name}</span>
                    <ExternalLink className="h-3 w-3 opacity-0 group-hover:opacity-100 flex-shrink-0 transition-opacity" />
                  </a>
                ) : (
                  <div
                    key={s.id}
                    title={s.name}
                    className="flex items-center gap-2 px-3 py-1.5 text-sm text-muted-foreground"
                  >
                    <FolderOpen className="h-3.5 w-3.5 flex-shrink-0" />
                    <span className="truncate">{s.name}</span>
                  </div>
                )
              )}
              {totalPages > 1 && (
                <div className="flex items-center justify-between px-3 pt-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    disabled={sourcePage === 0}
                    onClick={() => setSourcePage((p) => p - 1)}
                  >
                    <ChevronLeft className="h-3.5 w-3.5" />
                  </Button>
                  <span className="text-xs text-muted-foreground">
                    {sourcePage + 1} / {totalPages}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    disabled={sourcePage === totalPages - 1}
                    onClick={() => setSourcePage((p) => p + 1)}
                  >
                    <ChevronRight className="h-3.5 w-3.5" />
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      <Separator className="mb-4" />

      {/* Chats */}
      <div className="mb-2">
        <div className="flex items-center justify-between mb-2">
          <h3 className="px-3 text-xs font-semibold text-muted-foreground tracking-wide">
            CHATS
          </h3>
          <Button
            variant="link"
            size="icon"
            onClick={handleNewChat}
            className="text-muted-foreground hover:text-foreground cursor-pointer h-6 w-6"
            title="New chat"
          >
            <Plus className="h-4 w-4" />
          </Button>
        </div>

        <div className="pl-2 border-l-2 border-muted space-y-1 max-h-[300px] overflow-y-auto">
          {chatSessions.map((session, index) => (
            <div
              key={session.id}
              className={`flex items-center gap-1 rounded-md transition-colors ${
                activeChatSessionId === session.id ? "bg-accent/60" : "hover:bg-accent/30"
              }`}
            >
              <Button
                variant="link"
                onClick={() => handleSelectSession(session.id)}
                className={`flex-1 justify-start px-3 py-2 text-sm rounded-md transition-colors ${
                  activeChatSessionId === session.id
                    ? "text-foreground font-medium"
                    : "text-muted-foreground hover:text-foreground hover:underline"
                }`}
              >
                <MessageSquare className="h-4 w-4 mr-2 flex-shrink-0" />
                <span className="truncate">
                  {session.name || `Chat ${chatSessions.length - index}`}
                </span>
              </Button>

              <div className="pr-1">
                <ChatSessionActionsMenu
                  chatSessionId={session.id}
                  chatSessionName={session.name || ""}
                  displayName={session.name || `Chat ${chatSessions.length - index}`}
                  userId={session.user_id}
                  isActive={activeChatSessionId === session.id}
                  onDeleted={async () => {
                    removeChatSession(session.id);
                  }}
                />
              </div>
            </div>
          ))}
        </div>
      </div>
      <Separator className="mb-4" />
    </>
  );
}


export default function SideBar() {
  const { mobileOpen, setMobileOpen } = useSidebar();
  const navigate = useNavigate();
  const [isLoggingOut, setIsLoggingOut] = useState(false);

  const handleLogout = async () => {
    setIsLoggingOut(true);
    await AuthService.signOut();
    navigate("/landing");
  };

  return (
    <>
      {/* Desktop sidebar */}
      <aside className="hidden md:flex flex-col fixed left-0 top-[80px] h-[calc(100vh-80px)] w-90 flex-shrink-0 border bg-muted justify-between">
        <div className="flex-1 overflow-auto px-4 pt-[10px]">
          <SidebarContent setMobileOpen={setMobileOpen} />
        </div>
        <UserProfilePopover isLoggingOut={isLoggingOut} onLogout={handleLogout} />
      </aside>

      {/* Mobile sidebar */}
      <div
        className={`md:hidden pt-[10px] fixed inset-0 z-40 transition-opacity ${
          mobileOpen ? "visible" : "pointer-events-none invisible"
        }`}
        inert={!mobileOpen ? true : undefined}
      >
        <div
          className={`absolute inset-0 bg-black/40 ${mobileOpen ? "opacity-100" : "opacity-0"}`}
          onClick={() => setMobileOpen(false)}
        />
        <div
          className={`pt-[70px] absolute left-0 flex flex-col h-full w-90 bg-muted border-r p-4 transform transition-transform ${
            mobileOpen ? "translate-x-0" : "-translate-x-full"
          }`}
        >
          <div className="flex-1 overflow-auto">
            <SidebarContent setMobileOpen={setMobileOpen} />
          </div>
          <UserProfilePopover isLoggingOut={isLoggingOut} onLogout={handleLogout} />
        </div>
      </div>
    </>
  );
}
