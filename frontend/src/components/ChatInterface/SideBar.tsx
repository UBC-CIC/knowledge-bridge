import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useSidebar } from "@/providers/sidebar";
import { useNavigate } from "react-router";
import { Separator } from "@/components/ui/separator";
import { useView } from "@/providers/view";
import { Plus, MessageSquare, LogOut, UserRound } from "lucide-react";
import ChatSessionActionsMenu from "./ChatSessionActionsMenu";
import { AuthService } from "@/functions/authService";
import { useUser } from "@/providers/user";

type SidebarContentProps = {
  setMobileOpen: (open: boolean) => void;
};

function SidebarContent({ setMobileOpen }: SidebarContentProps) {
  const navigate = useNavigate();
  const {
    chatSessions,
    activeChatSessionId,
    setActiveChatSessionId,
    createNewChatSession,
    removeChatSession,
  } = useView();

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

function UserProfile({ isLoggingOut, onLogout }: { isLoggingOut: boolean; onLogout: () => void }) {
  const { displayName, email } = useUser();
  const [open, setOpen] = useState(false);

  const initials = displayName
    ? displayName.split(" ").map((n: string) => n[0]).join("").slice(0, 2).toUpperCase()
    : email
    ? email[0].toUpperCase()
    : null;

  const handleSwitchAccount = () => {
    setOpen(false);
    AuthService.signOut().then(() => {
      const cognitoDomain = "https://cic-kba.auth.ca-central-1.amazoncognito.com";
      const redirectUri = `${window.location.origin}/landing`;
      const url = new URL(`${cognitoDomain}/oauth2/authorize`);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", import.meta.env.VITE_COGNITO_USER_POOL_CLIENT_ID);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("identity_provider", "EntraID");
      url.searchParams.set("prompt", "select_account");
      url.searchParams.set("scope", "openid email profile");
      window.location.href = url.toString();
    });
  };

  return (
    <div className="p-3 border-t border-gray-100">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button className="w-full flex items-center gap-3 rounded-md px-2 py-2 hover:bg-accent/40 transition-colors text-left">
            <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
              {initials ? (
                <span className="text-xs font-semibold text-primary">{initials}</span>
              ) : (
                <UserRound className="h-4 w-4 text-muted-foreground" />
              )}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">
                {displayName || email || "Loading..."}
              </p>
              <p className="text-xs text-muted-foreground truncate">{email || ""}</p>
            </div>
          </button>
        </PopoverTrigger>
        <PopoverContent side="top" align="start" className="w-64 p-3">
          <div className="mb-3">
            <p className="text-sm font-semibold truncate">{displayName || email || ""}</p>
            <p className="text-xs text-muted-foreground truncate">{email || ""}</p>
          </div>
          <Separator className="mb-2" />
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start text-sm"
            onClick={handleSwitchAccount}
          >
            <UserRound className="mr-2 h-4 w-4" />
            Sign in with a different account
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start text-sm text-red-600 hover:text-red-700 hover:bg-red-50"
            onClick={() => { setOpen(false); onLogout(); }}
            disabled={isLoggingOut}
          >
            <LogOut className="mr-2 h-4 w-4" />
            {isLoggingOut ? "Logging out..." : "Logout"}
          </Button>
        </PopoverContent>
      </Popover>
    </div>
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
      <aside className="hidden md:flex flex-col fixed left-0 top-[80px] h-[calc(100vh-80px)] w-64 flex-shrink-0 border bg-muted justify-between">
        <div className="flex-1 overflow-auto px-4 pt-[10px]">
          <SidebarContent setMobileOpen={setMobileOpen} />
        </div>
        <UserProfile isLoggingOut={isLoggingOut} onLogout={handleLogout} />
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
          className={`pt-[70px] absolute left-0 flex flex-col h-full w-64 bg-muted border-r p-4 transform transition-transform ${
            mobileOpen ? "translate-x-0" : "-translate-x-full"
          }`}
        >
          <div className="flex-1 overflow-auto">
            <SidebarContent setMobileOpen={setMobileOpen} />
          </div>
          <UserProfile isLoggingOut={isLoggingOut} onLogout={handleLogout} />
        </div>
      </div>
    </>
  );
}
