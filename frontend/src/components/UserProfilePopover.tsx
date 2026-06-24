import { useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { LogOut, UserRound } from "lucide-react";
import { useUser } from "@/providers/user";

type UserProfilePopoverProps = {
  isLoggingOut: boolean;
  onLogout: () => void;
};

export default function UserProfilePopover({ isLoggingOut, onLogout }: UserProfilePopoverProps) {
  const { displayName, email } = useUser();
  const [open, setOpen] = useState(false);

  const initials = displayName
    ? displayName.split(" ").map((n: string) => n[0]).join("").slice(0, 2).toUpperCase()
    : email
    ? email[0].toUpperCase()
    : null;

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
        <PopoverContent side="top" align="start" className="w-72 p-4">
          <div className="mb-3">
            <p className="text-sm font-semibold truncate">{displayName || email || ""}</p>
            <p className="text-xs text-muted-foreground truncate">{email || ""}</p>
          </div>
          <Separator className="mb-3" />
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
