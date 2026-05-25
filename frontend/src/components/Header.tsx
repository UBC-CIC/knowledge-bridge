import { useEffect, useState } from "react";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { Menu, X } from "lucide-react";
import { useSidebar } from "@/providers/sidebar";
import { Link, useLocation, useNavigate } from "react-router";
import { useUser } from "@/providers/user";
import logoImage from "@/assets/KBA-logo.png";

type Mode = "student" | "admin";
type UserRole = "student" | "admin" | null;

type UserProfile = {
  id: string;
  email: string | null;
  display_name?: string | null;
  role?: string;
  created_at?: string;
  last_seen_at?: string;
  messages_sent?: number;
  messages_window_started_at?: string | null;
  metadata?: Record<string, unknown> | null;
};

export default function Header() {
  const { mobileOpen, toggleMobile } = useSidebar();
  const location = useLocation();
  const navigate = useNavigate();
  const { userId, isLoading: isLoadingUser } = useUser();

  const [userRole, setUserRole] = useState<UserRole>(null);

  const mode: Mode = location.pathname.startsWith("/admin") ? "admin" : "student";

  const handleModeChange = (newMode: Mode) => {
    if (newMode === "admin") {
      navigate("/admin/login");
    } else {
      navigate("/");
    }
  };

  const getPublicToken = async () => {
    const tokenResponse = await fetch(
      `${import.meta.env.VITE_API_ENDPOINT}/user/publicToken`
    );

    if (!tokenResponse.ok) {
      throw new Error("Failed to get public token");
    }

    return tokenResponse.json() as Promise<{ token: string }>;
  };

  const fetchUserProfile = async (id: string): Promise<UserProfile | null> => {
    try {
      const { token } = await getPublicToken();

      const response = await fetch(
        `${import.meta.env.VITE_API_ENDPOINT}/user/${id}`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
        }
      );

      if (!response.ok) {
        throw new Error("Failed to fetch user profile");
      }

      return (await response.json()) as UserProfile;
    } catch (err) {
      console.error("Error fetching user profile:", err);
      return null;
    }
  };

  useEffect(() => {
    const loadRole = async () => {
      if (isLoadingUser) return;

      if (!userId) {
        setUserRole(null);
        return;
      }

      const profile = await fetchUserProfile(userId);
      const role = profile?.role;

      if (role === "admin") {
        setUserRole("admin");
      } else {
        setUserRole("student");
      }
    };

    loadRole();
  }, [userId, isLoadingUser]);

  const canSwitchModes = userRole === "admin";

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
            <img src={logoImage} alt="Specialization Explorer AI Logo" className="h-10 w-auto" />
            <h1 className="text-xl font-semibold text-white">
              Specialization Explorer AI
            </h1>
          </Link>
        </div>

        {canSwitchModes ? (
          <Select value={mode} onValueChange={(v) => handleModeChange(v as Mode)}>
            <SelectTrigger className="w-fit border-primary-foreground bg-transparent text-white [&_svg:not([class*='text-'])]:text-primary-foreground hover:bg-white/10">
              <SelectValue placeholder="Select mode" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="student">Mode: Student</SelectItem>
              <SelectItem value="admin">Mode: Admin</SelectItem>
            </SelectContent>
          </Select>
        ) : null}
      </div>
    </header>
  );
}

// {/* Header */}
//       <header className="bg-gradient-to-r from-primary to-accent text-white h-[70px] flex items-center px-6 shadow-md z-10">
//         <div className="flex items-center gap-2">
//           <img src={logoImage} alt="Specialization Explorer AI Logo" className="h-10 w-auto" />
//           <h1 className="text-xl font-semibold">Specialization Explorer AI Admin</h1>
//         </div>
//       </header>
