import { useState } from "react";
import { useNavigate } from "react-router";
import {
  LayoutDashboard,
  BarChart3,
  LogOut,
  Bot,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { AuthService } from "@/functions/authService";

type AdminSidebarProps = {
  activeView: "dashboard" | "analytics" | "system-settings" | "chat-history";
  onViewChange: (
    view: "dashboard" | "analytics" | "system-settings" | "chat-history"
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
        navigate("/admin/login");
      } else {
        console.error("Logout failed:", result.error);
        // Still redirect even if there's an error
        navigate("/admin/login");
      }
    } catch (error) {
      console.error("Logout error:", error);
      // Redirect anyway to ensure user is logged out from UI
      navigate("/admin/login");
    } finally {
      setIsLoggingOut(false);
    }
  };

  return (
    <aside className="w-64 bg-white border-r border-gray-200 flex flex-col justify-between hidden md:flex">
      <div className="p-4 space-y-1">
        <div className="px-3 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
          Menu
        </div>
        <Button
          variant="ghost"
          className={`w-full justify-start ${activeView === "dashboard"
            ? "bg-primary/10 text-primary hover:bg-primary/20 font-medium"
            : "text-gray-600 hover:text-gray-900"
            }`}
          onClick={() => onViewChange("dashboard")}
        >
          <LayoutDashboard className="mr-2 h-4 w-4" />
          Dashboard & Management
        </Button>
        <Button
          variant="ghost"
          className={`w-full justify-start ${activeView === "analytics"
            ? "bg-primary/10 text-primary hover:bg-primary/20 font-medium"
            : "text-gray-600 hover:text-gray-900"
            }`}
          onClick={() => onViewChange("analytics")}
        >
          <BarChart3 className="mr-2 h-4 w-4" />
          Analytics
        </Button>
        <Button
          variant="ghost"
          className={`w-full justify-start ${activeView === "system-settings"
            ? "bg-primary/10 text-primary hover:bg-primary/20 font-medium"
            : "text-gray-600 hover:text-gray-900"
            }`}
          onClick={() => onViewChange("system-settings")}
        >
          <Bot className="mr-2 h-4 w-4" />
          System Settings
        </Button>
        <Button
          variant="ghost"
          className={`w-full justify-start ${activeView === "chat-history"
            ? "bg-primary/10 text-primary hover:bg-primary/20 font-medium"
            : "text-gray-600 hover:text-gray-900"
            }`}
          onClick={() => onViewChange("chat-history")}
        >
          <Bot className="mr-2 h-4 w-4" />
          Chat History
        </Button>
      </div>

      <div className="p-4 border-t border-gray-100">
        <Button
          variant="ghost"
          className="w-full justify-start text-red-600 hover:text-red-700 hover:bg-red-50"
          onClick={handleLogout}
          disabled={isLoggingOut}
        >
          <LogOut className="mr-2 h-4 w-4" />
          {isLoggingOut ? "Logging out..." : "Logout"}
        </Button>
      </div>
    </aside>
  );
}