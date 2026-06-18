import { Menu, X } from "lucide-react";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { useSidebar } from "@/providers/sidebar";
import { Link, useLocation, useNavigate } from "react-router";
import { useUser } from "@/providers/user";
import NotificationBell from "@/components/Admin/NotificationBell";
import NotificationPanel from "@/components/Admin/NotificationPanel";
import type { Notification } from "@/types/notifications";

type Mode = "student" | "admin";

type NotificationProps = {
  notifications: Notification[];
  total: number;
  panelOpen: boolean;
  expanded: boolean;
  setExpanded: (v: boolean) => void;
  openPanel: () => void;
  closePanel: () => void;
  deleteNotification: (id: string) => void;
  clearAll: () => void;
  onNavigateToExports: () => void;
};

type Props = {
  notificationProps?: NotificationProps;
};

export default function Header({ notificationProps }: Props) {
  const { mobileOpen, toggleMobile } = useSidebar();
  const location = useLocation();
  const navigate = useNavigate();
  const { role } = useUser();

  const mode: Mode = location.pathname.startsWith("/admin") ? "admin" : "student";

  const handleModeChange = (newMode: Mode) => {
    if (newMode === "admin") {
      navigate("/admin/dashboard");
    } else {
      navigate("/");
    }
  };

  const canSwitchModes = role === "admin";

  return (
    <header className="fixed top-0 left-0 w-full bg-primary text-white h-[80px] flex items-center px-6 shadow-md z-50">
      <div className="w-full flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            onClick={toggleMobile}
            aria-label="Toggle menu"
            aria-expanded={mobileOpen}
            className="md:hidden p-2 rounded-md hover:bg-white/10"
          >
            {mobileOpen ? (
              <X className="h-5 w-5 text-white" />
            ) : (
              <Menu className="h-5 w-5 text-white" />
            )}
          </button>

          <Link
            to="/"
            className="flex items-center gap-2 hover:opacity-80 transition-opacity"
            aria-label="Navigate to home"
          >
            <h1 className="text-xl font-semibold text-white">
              CUCCIO Assistant
            </h1>
          </Link>
        </div>

        <div className="flex items-center gap-2">
          {canSwitchModes && notificationProps && (
            <div className="relative">
              <NotificationBell
                total={notificationProps.total}
                onClick={notificationProps.openPanel}
              />
              {notificationProps.panelOpen && (
                <NotificationPanel
                  notifications={notificationProps.notifications}
                  total={notificationProps.total}
                  expanded={notificationProps.expanded}
                  onSetExpanded={notificationProps.setExpanded}
                  onClose={notificationProps.closePanel}
                  onClearAll={notificationProps.clearAll}
                  onDelete={notificationProps.deleteNotification}
                  onNavigateToExports={notificationProps.onNavigateToExports}
                />
              )}
            </div>
          )}

          {canSwitchModes && (
            <Select value={mode} onValueChange={(v) => handleModeChange(v as Mode)}>
              <SelectTrigger className="w-fit border-primary-foreground bg-transparent text-white [&_svg:not([class*='text-'])]:text-primary-foreground hover:bg-white/10">
                <SelectValue placeholder="Select mode" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="student">Mode: User</SelectItem>
                <SelectItem value="admin">Mode: Admin</SelectItem>
              </SelectContent>
            </Select>
          )}
        </div>
      </div>
    </header>
  );
}
