import { useState } from "react";
import AdminSidebar from "@/components/Admin/AdminSidebar";
import DataSourceManagement from "@/components/Admin/DataSourceManagement";
import Analytics from "@/components/Admin/Analytics";
import SystemSettings from "@/components/Admin/SystemSettings";
import ChatHistory from "@/components/Admin/ChatHistory";

// --- Components ---

export default function AdminDashboard() {
  const [activeView, setActiveView] = useState<
    "dashboard" | "analytics" | "system-settings" | "chat-history"
  >("dashboard");

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col font-sans">
      <div className="flex flex-1 overflow-hidden">
        <AdminSidebar activeView={activeView} onViewChange={setActiveView} />

        {/* Main Content */}
        <main className="flex-1 overflow-y-auto p-6 md:p-8">
          {activeView === "dashboard" && <DataSourceManagement />}
          {activeView === "analytics" && <Analytics />}
          {activeView === "system-settings" && <SystemSettings />}
          {activeView === "chat-history" && <ChatHistory />}
        </main>
      </div>
    </div>
  );
}
