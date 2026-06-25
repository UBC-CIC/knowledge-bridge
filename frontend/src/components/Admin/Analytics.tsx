import { useState, useEffect, useRef } from "react";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import { AuthService } from "@/functions/authService";
import { Download, Layers } from "lucide-react";

// Wong palette + extensions for more groups
const GROUP_COLORS = [
  "#0072B2", "#E69F00", "#009E73", "#D55E00",
  "#CC79A7", "#56B4E9", "#F0E442", "#000000",
];

type TimeSeriesPoint = { date: string; users: number; chat_sessions: number; questions: number };
type Group = { id: string; display_name: string };
type GroupSeries = { group: Group; series: TimeSeriesPoint[] };

type ChartCardProps = { title: string; subtitle: string; children: React.ReactNode };

function ChartCard({ title, subtitle, children }: ChartCardProps) {
  return (
    <Card className="border-gray-200 shadow-sm overflow-hidden">
      <CardHeader className="pb-2 border-b border-gray-50 bg-gray-50/50">
        <CardTitle className="text-base font-semibold text-gray-900">{title}</CardTitle>
        <CardDescription className="text-xs">{subtitle}</CardDescription>
      </CardHeader>
      <CardContent className="p-6 h-[300px]">{children}</CardContent>
    </Card>
  );
}

function CustomTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-white border border-gray-200 p-3 rounded-lg shadow-xl text-sm">
      <p className="font-semibold text-gray-900 mb-2">{label}</p>
      {payload.map((entry: any, i: number) => (
        <div key={i} className="flex items-center gap-2 text-xs text-gray-600 mb-1">
          <div className="w-2 h-2 rounded-full" style={{ backgroundColor: entry.color }} />
          <span className="capitalize">{entry.name}:</span>
          <span className="font-bold text-gray-900">{entry.value}</span>
        </div>
      ))}
    </div>
  );
}

export default function Analytics() {
  const [timeRange, setTimeRange] = useState("90d");
  const [isAllTime, setIsAllTime] = useState(false);
  const [daysInput, setDaysInput] = useState(90);

  const [groupId, setGroupId] = useState<string>("all");
  const [groups, setGroups] = useState<Group[]>([]);
  const [overlayMode, setOverlayMode] = useState(false);

  // Single-group mode data
  const [timeSeries, setTimeSeries] = useState<TimeSeriesPoint[]>([]);
  // Overlay mode data — one entry per group
  const [groupSeries, setGroupSeries] = useState<GroupSeries[]>([]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportToast, setExportToast] = useState<{ type: "success" | "error"; msg: string } | null>(null);
  const exportToastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const groupsFetchedRef = useRef(false);

  const effectiveTimeRange = isAllTime ? "all" : timeRange;

  // Fetch groups once on mount
  useEffect(() => {
    if (groupsFetchedRef.current) return;
    groupsFetchedRef.current = true;
    const load = async () => {
      try {
        const token = await AuthService.getIdToken();
        const res = await fetch(
          `${import.meta.env.VITE_API_ENDPOINT}/admin/entra_groups?limit=50`,
          { headers: { Authorization: token } }
        );
        if (res.ok) {
          const data = await res.json();
          setGroups(data.groups ?? []);
        }
      } catch { /* non-fatal */ }
    };
    load();
  }, []);

  // Fetch analytics whenever filters change
  useEffect(() => {
    if (overlayMode && groupId === "all") {
      fetchOverlay();
    } else {
      fetchSingle();
    }
  }, [effectiveTimeRange, groupId, overlayMode]);

  const getHeaders = async () => ({
    Authorization: await AuthService.getIdToken(),
    "Content-Type": "application/json",
  });

  const fetchSingle = async () => {
    try {
      setLoading(true);
      setError(null);
      const headers = await getHeaders();
      const params = new URLSearchParams({ timeRange: effectiveTimeRange });
      if (groupId !== "all") params.set("groupId", groupId);
      const res = await fetch(
        `${import.meta.env.VITE_API_ENDPOINT}/admin/analytics?${params}`,
        { headers }
      );
      if (!res.ok) throw new Error("Failed to fetch analytics data");
      const data = await res.json();
      setTimeSeries(data.timeSeries ?? []);
    } catch (err) {
      console.error(err);
      setError("Failed to load analytics data");
    } finally {
      setLoading(false);
    }
  };

  const fetchOverlay = async () => {
    if (!groups.length) { setLoading(false); return; }
    try {
      setLoading(true);
      setError(null);
      const headers = await getHeaders();
      const results = await Promise.all(
        groups.map(async (g) => {
          const params = new URLSearchParams({ timeRange: effectiveTimeRange, groupId: g.id });
          const res = await fetch(
            `${import.meta.env.VITE_API_ENDPOINT}/admin/analytics?${params}`,
            { headers }
          );
          if (!res.ok) return { group: g, series: [] };
          const data = await res.json();
          return { group: g, series: data.timeSeries ?? [] };
        })
      );
      setGroupSeries(results);
    } catch (err) {
      console.error(err);
      setError("Failed to load analytics data");
    } finally {
      setLoading(false);
    }
  };

  const handleExport = async () => {
    try {
      setExporting(true);
      const headers = await getHeaders();
      const body: Record<string, string> = {
        scope: "analytics",
        timeRange: effectiveTimeRange,
        groupId: overlayMode ? "all" : groupId,
      };
      const res = await fetch(
        `${import.meta.env.VITE_API_ENDPOINT}/admin/export/trigger`,
        { method: "POST", headers, body: JSON.stringify(body) }
      );
      if (!res.ok) throw new Error("Failed to queue export");
      if (exportToastTimer.current) clearTimeout(exportToastTimer.current);
      setExportToast({ type: "success", msg: "Export queued — check Export Jobs when ready." });
      exportToastTimer.current = setTimeout(() => setExportToast(null), 6000);
    } catch (err) {
      console.error(err);
      if (exportToastTimer.current) clearTimeout(exportToastTimer.current);
      setExportToast({ type: "error", msg: "Failed to queue analytics export." });
      exportToastTimer.current = setTimeout(() => setExportToast(null), 6000);
    } finally {
      setExporting(false);
    }
  };

  // Merge overlay series onto a shared date axis
  const mergedOverlay = (() => {
    const dateMap = new Map<string, Record<string, number>>();
    groupSeries.forEach(({ group, series }) => {
      series.forEach((pt) => {
        if (!dateMap.has(pt.date)) dateMap.set(pt.date, { date: pt.date as any });
        const row = dateMap.get(pt.date)!;
        row[`users_${group.id}`] = pt.users;
        row[`sessions_${group.id}`] = pt.chat_sessions;
        row[`questions_${group.id}`] = pt.questions;
      });
    });
    return Array.from(dateMap.values()).sort((a, b) =>
      String(a.date) < String(b.date) ? -1 : 1
    );
  })();

  const renderOverlayLines = (metric: "users" | "sessions" | "questions") =>
    groupSeries.map(({ group }, i) => (
      <Line
        key={group.id}
        type="monotone"
        dataKey={`${metric}_${group.id}`}
        name={group.display_name}
        stroke={GROUP_COLORS[i % GROUP_COLORS.length]}
        strokeWidth={2}
        dot={false}
        activeDot={{ r: 5, strokeWidth: 0 }}
      />
    ));

  const commonChartProps = {
    margin: { top: 10, right: 10, left: -20, bottom: 0 },
  };
  const commonAxisProps = {
    axisLine: false,
    tickLine: false,
    tick: { fontSize: 12, fill: "#6b7280" },
  };

  return (
    <div className="space-y-8 max-w-7xl mx-auto animate-in fade-in duration-500">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h2 className="text-3xl font-bold text-gray-900">Analytics</h2>
          <p className="text-gray-500 mt-1">Deep dive into user engagement and content usage.</p>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {/* Group dropdown */}
          <select
            value={groupId}
            onChange={(e) => {
              setGroupId(e.target.value);
              if (e.target.value !== "all") setOverlayMode(false);
            }}
            className="h-9 rounded-lg border border-gray-200 bg-white px-3 text-sm text-gray-700 shadow-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
          >
            <option value="all">All Groups</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>{g.display_name}</option>
            ))}
          </select>

          {/* Overlay toggle — only when All Groups selected */}
          {groupId === "all" && (
            <button
              onClick={() => setOverlayMode((v) => !v)}
              title="Compare groups side by side"
              className={`flex items-center gap-1.5 h-9 px-3 rounded-lg border text-sm font-medium transition-colors shadow-sm ${
                overlayMode
                  ? "bg-primary text-white border-primary"
                  : "bg-white text-gray-600 border-gray-200 hover:border-gray-300"
              }`}
            >
              <Layers size={14} />
              Compare groups
            </button>
          )}

          {/* Time range */}
          {!isAllTime ? (
            <div className="flex items-center bg-white rounded-lg border border-gray-200 p-1 px-3 shadow-sm gap-2">
              <span className="text-sm font-medium text-gray-700 whitespace-nowrap">Last</span>
              <Input
                type="number"
                min={1}
                max={365}
                className="h-7 w-16 text-center"
                value={daysInput}
                onChange={(e) => {
                  const val = parseInt(e.target.value);
                  if (!isNaN(val) && val > 0) {
                    const days = Math.min(Math.max(1, val), 365);
                    setDaysInput(days);
                    setTimeRange(`${days}d`);
                  }
                }}
              />
              <span className="text-sm font-medium text-gray-700 whitespace-nowrap">Days</span>
            </div>
          ) : null}
          <button
            onClick={() => setIsAllTime((v) => !v)}
            className={`h-9 px-3 rounded-lg border text-sm font-medium transition-colors shadow-sm ${
              isAllTime
                ? "bg-primary text-white border-primary"
                : "bg-white text-gray-600 border-gray-200 hover:border-gray-300"
            }`}
          >
            All time
          </button>

          {/* Export */}
          <button
            onClick={handleExport}
            disabled={exporting}
            className="flex items-center gap-1.5 h-9 px-3 rounded-lg border border-gray-200 bg-white text-sm font-medium text-gray-600 hover:bg-gray-50 hover:text-gray-900 transition-colors shadow-sm disabled:opacity-50"
          >
            <Download size={14} />
            {exporting ? "Queuing…" : "Export CSV"}
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg">
          <p className="font-medium">Error</p>
          <p className="text-sm">{error}</p>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary" />
        </div>
      ) : overlayMode && groupId === "all" ? (
        // Overlay mode — one line per group on each chart
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <ChartCard title="Users" subtitle="Active users by group over time">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={mergedOverlay} {...commonChartProps}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />
                <XAxis dataKey="date" {...commonAxisProps} dy={10} />
                <YAxis {...commonAxisProps} />
                <Tooltip content={<CustomTooltip />} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                {renderOverlayLines("users")}
              </LineChart>
            </ResponsiveContainer>
          </ChartCard>

          <ChartCard title="Chat Sessions" subtitle="Sessions by group over time">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={mergedOverlay} {...commonChartProps}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />
                <XAxis dataKey="date" {...commonAxisProps} dy={10} />
                <YAxis {...commonAxisProps} />
                <Tooltip content={<CustomTooltip />} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                {renderOverlayLines("sessions")}
              </LineChart>
            </ResponsiveContainer>
          </ChartCard>

          <ChartCard title="Questions" subtitle="Questions asked by group over time">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={mergedOverlay} {...commonChartProps}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />
                <XAxis dataKey="date" {...commonAxisProps} dy={10} />
                <YAxis {...commonAxisProps} />
                <Tooltip content={<CustomTooltip />} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                {renderOverlayLines("questions")}
              </LineChart>
            </ResponsiveContainer>
          </ChartCard>
        </div>
      ) : (
        // Single-group (or all) mode
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <ChartCard
            title="Total Users"
            subtitle={groupId === "all" ? "Total active users over time" : `Active users in ${groups.find(g => g.id === groupId)?.display_name ?? groupId}`}
          >
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={timeSeries} {...commonChartProps}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />
                <XAxis dataKey="date" {...commonAxisProps} dy={10} />
                <YAxis {...commonAxisProps} />
                <Tooltip content={<CustomTooltip />} />
                <Line type="monotone" dataKey="users" stroke="rgb(0, 85, 183)" strokeWidth={3} dot={false} activeDot={{ r: 6, strokeWidth: 0 }} />
              </LineChart>
            </ResponsiveContainer>
          </ChartCard>

          <ChartCard
            title="Total Chat Sessions"
            subtitle={groupId === "all" ? "Chat sessions created over time" : `Sessions in ${groups.find(g => g.id === groupId)?.display_name ?? groupId}`}
          >
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={timeSeries} {...commonChartProps}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />
                <XAxis dataKey="date" {...commonAxisProps} dy={10} />
                <YAxis {...commonAxisProps} />
                <Tooltip content={<CustomTooltip />} />
                <Line type="monotone" dataKey="chat_sessions" stroke="rgb(0, 110, 220)" strokeWidth={3} dot={false} activeDot={{ r: 6, strokeWidth: 0 }} />
              </LineChart>
            </ResponsiveContainer>
          </ChartCard>

          <ChartCard
            title="Total Questions"
            subtitle={groupId === "all" ? "Questions asked to the AI" : `Questions in ${groups.find(g => g.id === groupId)?.display_name ?? groupId}`}
          >
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={timeSeries} {...commonChartProps}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />
                <XAxis dataKey="date" {...commonAxisProps} dy={10} />
                <YAxis {...commonAxisProps} />
                <Tooltip content={<CustomTooltip />} />
                <Line type="monotone" dataKey="questions" stroke="rgb(50, 140, 240)" strokeWidth={3} dot={false} activeDot={{ r: 6, strokeWidth: 0 }} />
              </LineChart>
            </ResponsiveContainer>
          </ChartCard>
        </div>
      )}

      {/* Export toast */}
      {exportToast && (
        <div className={`fixed bottom-6 right-6 z-50 flex items-center gap-3 border rounded-xl shadow-lg px-4 py-3 max-w-sm animate-in slide-in-from-bottom-4 duration-300 ${
          exportToast.type === "success" ? "bg-white border-gray-200 text-gray-800" : "bg-red-50 border-red-200 text-red-800"
        }`}>
          <span className="text-sm">{exportToast.msg}</span>
        </div>
      )}
    </div>
  );
}
