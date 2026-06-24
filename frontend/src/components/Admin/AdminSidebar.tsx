import { useState } from "react";
import { useNavigate } from "react-router";
import {
  LayoutDashboard,
  BarChart3,
  Bot,
  Download,
  MessagesSquare,
  ThumbsUp,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { AuthService } from "@/functions/authService";
import UserProfilePopover from "@/components/UserProfilePopover";

type AdminSidebarProps = {
  activeView: "dashboard" | "analytics" | "system-settings" | "chat-history" | "export-jobs" | "feedback";
  onViewChange: (
    view: "dashboard" | "analytics" | "system-settings" | "chat-history" | "export-jobs" | "feedback"
  ) => void;
};

export default function AdminSidebar({
  activeView,
  onViewChange,
}: AdminSidebarProps) {
  const navigate = useNavigate();
  const [isLoggingOut, setIsLoggingOut] = useState(false);

  const handleLogout = async () => {
    try {
      setIsLoggingOut(true);
      const result = await AuthService.signOut();

      if (result.success) {
        // Redirect to admin login page
        navigate("/landing");
      } else {
        console.error("Logout failed:", result.error);
        navigate("/landing");
      }
    } catch (error) {
      console.error("Logout error:", error);
      navigate("/landing");
    } finally {
      setIsLoggingOut(false);
    }
  };

  return (
    <aside className="w-90 bg-white border-r border-gray-200 flex flex-col justify-between hidden md:flex">
      <div className="p-4 space-y-1">
        <div className="px-3 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
          Menu
        </div>
        <TooltipProvider delayDuration={400}>
          {(
            [
              {
                view: "dashboard",
                label: "Dashboard & Management",
                icon: <LayoutDashboard className="mr-2 h-4 w-4" />,
                description: "Trigger ingestion, manage schedules, and monitor run history.",
              },
              {
                view: "analytics",
                label: "Analytics",
                icon: <BarChart3 className="mr-2 h-4 w-4" />,
                description: "Usage trends, session counts, and activity breakdowns.",
              },
              {
                view: "system-settings",
                label: "System Settings",
                icon: <Bot className="mr-2 h-4 w-4" />,
                description: "Configure the AI assistant's behaviour and system prompt.",
              },
              {
                view: "chat-history",
                label: "Chat History",
                icon: <MessagesSquare className="mr-2 h-4 w-4" />,
                description: "Browse and search all user conversations by group.",
              },
              {
                view: "export-jobs",
                label: "Export Jobs",
                icon: <Download className="mr-2 h-4 w-4" />,
                description: "View and download completed chat export jobs.",
              },
              {
                view: "feedback",
                label: "Feedback",
                icon: <ThumbsUp className="mr-2 h-4 w-4" />,
                description: "Review user ratings and comments on AI responses.",
              },
            ] as const
          ).map(({ view, label, icon, description }) => (
            <Tooltip key={view}>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  className={`w-full justify-start ${
                    activeView === view
                      ? "bg-primary/10 text-primary hover:bg-primary/20 font-medium"
                      : "text-gray-600 hover:text-gray-900"
                  }`}
                  onClick={() => onViewChange(view)}
                >
                  {icon}
                  {label}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right" className="max-w-[200px] text-xs">
                {description}
              </TooltipContent>
            </Tooltip>
          ))}
        </TooltipProvider>
      </div>

      <UserProfilePopover isLoggingOut={isLoggingOut} onLogout={handleLogout} />
    </aside>
  );
}