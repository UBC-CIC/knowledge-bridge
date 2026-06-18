import { Outlet, useLocation, useNavigate } from "react-router";
import Header from "@/components/Header";
import { SidebarProvider } from "@/providers/SidebarContext";
import { useNotifications } from "@/hooks/useNotifications";
import { useUser } from "@/providers/user";

export default function AppLayout() {
    const { pathname } = useLocation();
    const navigate = useNavigate();
    const isAdminRoute = pathname.startsWith("/admin");
    const { role } = useUser();

    const notifications = useNotifications(role);

    return (
        <SidebarProvider>
            <div
                className={isAdminRoute
                    ? "flex min-h-screen flex-col bg-background"
                    : "flex h-screen flex-col bg-background overflow-hidden"
                }
            >
                <Header
                    notificationProps={role === "admin" ? {
                        ...notifications,
                        onNavigateToExports: () => navigate("/admin/dashboard?view=export-jobs"),
                    } : undefined}
                />
                <div className="pt-[80px] flex-1 min-h-0">
                    <Outlet />
                </div>
            </div>
        </SidebarProvider>
    );
}
