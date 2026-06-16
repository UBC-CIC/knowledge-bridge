import { useState, useEffect, useRef } from "react";
import AdminSidebar from "@/components/Admin/AdminSidebar";
import DataSourceManagement from "@/components/Admin/DataSourceManagement";
import Analytics from "@/components/Admin/Analytics";
import SystemSettings from "@/components/Admin/SystemSettings";
import ChatHistory from "@/components/Admin/ChatHistory";
import ExportJobs from "@/components/Admin/ExportJobs";
import { AuthService } from "@/functions/authService";
import { Download, X } from "lucide-react";

export default function AdminDashboard() {
  const [activeView, setActiveView] = useState<
    "dashboard" | "analytics" | "system-settings" | "chat-history" | "export-jobs"
  >("dashboard");

  const [toast, setToast] = useState<{ scopeLabel: string } | null>(null);
  const seenIdsRef = useRef<Set<string>>(new Set());
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const showToast = (scopeLabel: string) => {
    setToast({ scopeLabel });
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), 7000);
  };

  const pollExportRuns = async () => {
    try {
      const token = await AuthService.getIdToken();
      const res = await fetch(
        `${import.meta.env.VITE_API_ENDPOINT}/admin/export/runs?limit=10`,
        { headers: { Authorization: token } }
      );
      if (!res.ok) return;
      const data = await res.json();
      for (const run of data.runs ?? []) {
        if (run.status === "completed" && !seenIdsRef.current.has(run.id)) {
          seenIdsRef.current.add(run.id);
          showToast(run.scope_label);
        } else if (run.status !== "processing" && run.status !== "pending") {
          seenIdsRef.current.add(run.id);
        }
      }
    } catch { /* ignore transient errors */ }
  };

  useEffect(() => {
    pollExportRuns(); // initial fetch to seed seenIds without toasting
    const seedOnly = async () => {
      try {
        const token = await AuthService.getIdToken();
        const res = await fetch(
          `${import.meta.env.VITE_API_ENDPOINT}/admin/export/runs?limit=10`,
          { headers: { Authorization: token } }
        );
        if (!res.ok) return;
        const data = await res.json();
        for (const run of data.runs ?? []) {
          seenIdsRef.current.add(run.id);
        }
      } catch { }
    };
    seedOnly();
    pollRef.current = setInterval(pollExportRuns, 30000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    };
  }, []);

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
          {activeView === "export-jobs" && <ExportJobs />}
        </main>
      </div>

      {/* Export completed toast */}
      {toast && (
        <div className="fixed bottom-6 right-6 z-50 flex items-start gap-3 bg-white border border-gray-200 rounded-xl shadow-lg px-4 py-3 max-w-sm animate-in slide-in-from-bottom-4 duration-300">
          <div className="flex-shrink-0 mt-0.5 bg-green-100 rounded-full p-1">
            <Download size={14} className="text-green-600" />
          </div>
          <div className="flex-1 text-sm">
            <p className="font-medium text-gray-900">Export ready</p>
            <p className="text-gray-500 text-xs mt-0.5">
              <span className="font-medium text-gray-700">{toast.scopeLabel}</span> export is done.{" "}
              <button
                className="text-primary underline"
                onClick={() => { setActiveView("export-jobs"); setToast(null); }}
              >
                View download
              </button>
            </p>
          </div>
          <button onClick={() => setToast(null)} className="text-gray-400 hover:text-gray-600 flex-shrink-0">
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  );
}
