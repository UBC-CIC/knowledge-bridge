import { useState, useEffect } from "react";
import { Users, HelpCircle, MessageCircleMore } from "lucide-react";
import { AuthService } from "@/functions/authService";
import MetricCard from "./MetricCard.tsx";
import IngestionPanel from "./IngestionPanel.tsx";

type AnalyticsTotals = {
  users: number;
  chat_sessions: number;
  messages: number;
  questions?: number;
};

export default function DataSourceManagement() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [totals, setTotals] = useState<AnalyticsTotals>({
    users: 0,
    chat_sessions: 0,
    messages: 0,
    questions: 0,
  });

  useEffect(() => {
    const fetchAnalyticsTotals = async () => {
      try {
        setLoading(true);
        setError(null);
        const session = await AuthService.getAuthSession(true);
        const token = session.tokens.idToken;
        const res = await fetch(`${import.meta.env.VITE_API_ENDPOINT}/admin/analytics`, {
          headers: { Authorization: token, "Content-Type": "application/json" },
        });
        if (!res.ok) throw new Error("Failed to fetch analytics");
        const data = (await res.json()) as { totals: AnalyticsTotals };
        setTotals({
          users: data.totals?.users ?? 0,
          chat_sessions: data.totals?.chat_sessions ?? 0,
          messages: data.totals?.messages ?? 0,
          questions: data.totals?.questions ?? 0,
        });
      } catch (e) {
        console.error(e);
        setError("Failed to load analytics");
      } finally {
        setLoading(false);
      }
    };

    fetchAnalyticsTotals();
  }, []);

  return (
    <div className="space-y-8 max-w-7xl mx-auto animate-in fade-in duration-500">
      <div>
        <h2 className="text-3xl font-bold text-gray-900">Admin Dashboard</h2>
        <p className="text-gray-500 mt-1">Platform overview and ingestion management.</p>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg">
          <p className="font-medium">Error loading data</p>
          <p className="text-sm">{error}</p>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <MetricCard
          title="Total Users"
          value={loading ? "..." : totals.users.toLocaleString()}
          icon={<Users className="h-5 w-5 text-primary" />}
          trend="Unique users"
          tooltip="Calculated by counting distinct users with chat sessions."
        />
        <MetricCard
          title="Total Chat Sessions"
          value={loading ? "..." : totals.chat_sessions.toLocaleString()}
          icon={<MessageCircleMore className="h-5 w-5 text-primary" />}
          trend="Total Chat sessions"
          tooltip="Total chat sessions across all users."
        />
        <MetricCard
          title="Total Messages"
          value={loading ? "..." : totals.messages.toLocaleString()}
          icon={<HelpCircle className="h-5 w-5 text-[#3d7a9a]" />}
          trend="Total Messages Exchanged"
          tooltip="Total chat messages exchanged across all sessions."
        />
      </div>

      <IngestionPanel />
    </div>
  );
}
