import { useState, useEffect } from "react";
import { useSearchParams } from "react-router";
import AdminSidebar from "@/components/Admin/AdminSidebar";
import DataSourceManagement from "@/components/Admin/DataSourceManagement";
import Analytics from "@/components/Admin/Analytics";
import SystemSettings from "@/components/Admin/SystemSettings";
import ChatHistory from "@/components/Admin/ChatHistory";
import ExportJobs from "@/components/Admin/ExportJobs";

type View = "dashboard" | "analytics" | "system-settings" | "chat-history" | "export-jobs";

export default function AdminDashboard() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [activeView, setActiveView] = useState<View>(
    (searchParams.get("view") as View) ?? "dashboard"
  );

  useEffect(() => {
    const view = searchParams.get("view") as View | null;
    if (view) {
      setActiveView(view);
      setSearchParams({}, { replace: true });
    }
  }, [searchParams]);

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col font-sans">
      <div className="flex flex-1 overflow-hidden">
        <AdminSidebar activeView={activeView} onViewChange={setActiveView} />

        <main className="flex-1 overflow-y-auto p-6 md:p-8">
          {activeView === "dashboard" && <DataSourceManagement />}
          {activeView === "analytics" && <Analytics />}
          {activeView === "system-settings" && <SystemSettings />}
          {activeView === "chat-history" && <ChatHistory />}
          {activeView === "export-jobs" && <ExportJobs />}
        </main>
      </div>
    </div>
  );
}
