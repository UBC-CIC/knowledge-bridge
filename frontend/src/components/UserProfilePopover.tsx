import { useEffect, useRef, useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { LogOut, UserRound } from "lucide-react";
import { useUser } from "@/providers/user";
import { fetchAuthSession } from "aws-amplify/auth";

type Source = { id: string; name: string; source_url: string | null };

// Module-level cache — survives re-renders and component unmounts within the session.
// Key: userId, Value: { sources, fetchedAt }
const sourcesCache = new Map<string, { sources: Source[]; fetchedAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000;

type UserProfilePopoverProps = {
  isLoggingOut: boolean;
  onLogout: () => void;
};

export default function UserProfilePopover({ isLoggingOut, onLogout }: UserProfilePopoverProps) {
  const { userId, displayName, email } = useUser();
  const [open, setOpen] = useState(false);
  const [sources, setSources] = useState<Source[]>([]);
  const [loadingSources, setLoadingSources] = useState(false);
  const fetchedRef = useRef(false);

  const initials = displayName
    ? displayName.split(" ").map((n: string) => n[0]).join("").slice(0, 2).toUpperCase()
    : email
    ? email[0].toUpperCase()
    : null;

  useEffect(() => {
    if (!open || !userId || fetchedRef.current) return;

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
  }, [open, userId]);

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
        <PopoverContent side="top" align="start" className="w-80 p-3">
          <div className="mb-3">
            <p className="text-sm font-semibold truncate">{displayName || email || ""}</p>
            <p className="text-xs text-muted-foreground truncate">{email || ""}</p>
          </div>
          <Separator className="mb-2" />
          <div className="mb-3">
            <p className="text-xs font-medium text-muted-foreground mb-1">Accessible knowledge bases</p>
            {loadingSources ? (
              <p className="text-xs text-muted-foreground">Loading...</p>
            ) : sources.length === 0 ? (
              <p className="text-xs text-muted-foreground">None assigned</p>
            ) : (
              <ul className="space-y-1">
                {sources.map((s) => (
                  <li key={s.id} className="text-xs truncate text-foreground">
                    {s.source_url ? (
                      <a
                        href={s.source_url}
                        target="_blank"
                        rel="noreferrer"
                        className="hover:underline text-primary"
                      >
                        {s.name}
                      </a>
                    ) : (
                      s.name
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <Separator className="mb-2" />
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
