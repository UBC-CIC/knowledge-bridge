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
import { Check, ChevronDown, Download, Layers, X } from "lucide-react";

// Wong palette + extensions for more groups
const GROUP_COLORS = [
  "#0072B2", "#E69F00", "#009E73", "#D55E00",
  "#CC79A7", "#56B4E9", "#F0E442", "#000000",
];

type TimeSeriesPoint = { date: string; users: number; chat_sessions: number; questions: number };
type Group = { id: string; display_name: string };
type GroupSeries = { group: Group; series: TimeSeriesPoint[] };

// ---------------------------------------------------------------------------
// Searchable multi-select dropdown
// ---------------------------------------------------------------------------
function GroupMultiSelect({
  groups,
  selected,
  onChange,
}: {
  groups: Group[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const filtered = groups.filter(g =>
    g.display_name.toLowerCase().includes(search.toLowerCase())
  );
  const allSelected = groups.every(g => selected.has(g.id));

  const toggle = (id: string) => {
    const next = new Set(selected);
    next.has(id) ? next.delete(id) : next.add(id);
    onChange(next);
  };

  const toggleAll = () => {
    onChange(allSelected ? new Set() : new Set(groups.map(g => g.id)));
  };

  const selectedCount = selected.size;
  const label = selectedCount === 0
    ? "No groups"
    : selectedCount === groups.length
    ? "All groups"
    : `${selectedCount} group${selectedCount > 1 ? "s" : ""}`;

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(v => !v)}
        className="flex items-center gap-2 h-9 px-3 rounded-lg border border-gray-200 bg-white text-sm text-gray-700 shadow-sm hover:border-gray-300 focus:outline-none focus:ring-2 focus:ring-primary/30 min-w-[140px]"
      >
        <span className="flex-1 text-left truncate">{label}</span>
        <ChevronDown size={14} className={`flex-shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="absolute right-0 top-10 z-50 w-64 bg-white border border-gray-200 rounded-xl shadow-xl overflow-hidden">
          {/* Search */}
          <div className="p-2 border-b border-gray-100">
            <input
              autoFocus
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search groups…"
              className="w-full h-8 px-3 text-sm rounded-lg border border-gray-200 focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>

          {/* Select all / Clear */}
          <div className="flex items-center justify-between px-3 py-1.5 border-b border-gray-100">
            <button onClick={toggleAll} className="text-xs text-primary font-medium hover:underline">
              {allSelected ? "Deselect all" : "Select all"}
            </button>
            {selectedCount > 0 && selectedCount < groups.length && (
              <button onClick={() => onChange(new Set(groups.map(g => g.id)))} className="text-xs text-gray-400 hover:text-gray-600 flex items-center gap-1">
                <X size={11} /> Reset
              </button>
            )}
          </div>

          {/* Group list */}
          <div className="max-h-52 overflow-y-auto">
            {filtered.length === 0 ? (
              <p className="px-3 py-3 text-xs text-gray-400">No groups match</p>
            ) : (
              filtered.map(g => (
                <button
                  key={g.id}
                  onClick={() => toggle(g.id)}
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-left hover:bg-gray-50 transition-colors"
                >
                  <div className={`flex-shrink-0 w-4 h-4 rounded border flex items-center justify-center transition-colors ${
                    selected.has(g.id) ? "bg-primary border-primary" : "border-gray-300"
                  }`}>
                    {selected.has(g.id) && <Check size={10} className="text-white" strokeWidth={3} />}
                  </div>
                  <span className="truncate text-gray-700">{g.display_name}</span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chart helpers
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------
export default function Analytics() {
  const [timeRange, setTimeRange] = useState("90d");
  const [isAllTime, setIsAllTime] = useState(false);
  const [daysInput, setDaysInput] = useState(90);

  const [groupId, setGroupId] = useState<string>("all");
  const [groups, setGroups] = useState<Group[]>([]);
  const [overlayMode, setOverlayMode] = useState(false);
  const [selectedGroupIds, setSelectedGroupIds] = useState<Set<string>>(new Set());

  const [timeSeries, setTimeSeries] = useState<TimeSeriesPoint[]>([]);
  const [groupSeries, setGroupSeries] = useState<GroupSeries[]>([]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportToast, setExportToast] = useState<{ type: "success" | "error"; msg: string } | null>(null);
  const exportToastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const groupsFetchedRef = useRef(false);

  const effectiveTimeRange = isAllTime ? "all" : timeRange;

  // Fetch groups once on mount — default all selected
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
          const loaded: Group[] = data.groups ?? [];
          setGroups(loaded);
          setSelectedGroupIds(new Set(loaded.map(g => g.id)));
        }
      } catch { /* non-fatal */ }
    };
    load();
  }, []);

  useEffect(() => {
    if (overlayMode) {
      fetchOverlay();
    } else {
      fetchSingle();
    }
  }, [effectiveTimeRange, groupId, overlayMode, selectedGroupIds]);

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
    const activeGroups = groups.filter(g => selectedGroupIds.has(g.id));
    if (!activeGroups.length) { setGroupSeries([]); setLoading(false); return; }
    try {
      setLoading(true);
      setError(null);
      const headers = await getHeaders();
      const results = await Promise.all(
        activeGroups.map(async (g) => {
          const params = new URLSearchParams({ timeRange: effectiveTimeRange, groupId: g.id });
          const res = await fetch(
            `${import.meta.env.VITE_API_ENDPOINT}/admin/analytics?${params}`,
            { headers }
          );
          if (!res.ok) return { group: g, series: [] as TimeSeriesPoint[] };
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
      const body: Record<string, unknown> = {
        scope: "analytics",
        timeRange: effectiveTimeRange,
        groupId: overlayMode ? Array.from(selectedGroupIds) : groupId,
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

  const commonChartProps = { margin: { top: 10, right: 10, left: -20, bottom: 0 } };
  const commonAxisProps = { axisLine: false, tickLine: false, tick: { fontSize: 12, fill: "#6b7280" } };

  return (
    <div className="space-y-8 max-w-7xl mx-auto animate-in fade-in duration-500">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h2 className="text-3xl font-bold text-gray-900">Analytics</h2>
          <p className="text-gray-500 mt-1">Deep dive into user engagement and content usage.</p>
        </div>

        <div className="flex items-center gap-2 flex-wrap justify-end">
          {/* Single-group dropdown — hidden in overlay mode */}
          {!overlayMode && (
            <select
              value={groupId}
              onChange={(e) => setGroupId(e.target.value)}
              className="h-9 rounded-lg border border-gray-200 bg-white px-3 text-sm text-gray-700 shadow-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
            >
              <option value="all">All Groups</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>{g.display_name}</option>
              ))}
            </select>
          )}

          {/* Compare groups toggle */}
          <button
            onClick={() => setOverlayMode((v) => !v)}
            className={`flex items-center gap-1.5 h-9 px-3 rounded-lg border text-sm font-medium transition-colors shadow-sm ${
              overlayMode
                ? "bg-primary text-white border-primary"
                : "bg-white text-gray-600 border-gray-200 hover:border-gray-300"
            }`}
          >
            <Layers size={14} />
            Compare groups
          </button>

          {/* Multi-select — only in overlay mode */}
          {overlayMode && groups.length > 0 && (
            <GroupMultiSelect
              groups={groups}
              selected={selectedGroupIds}
              onChange={setSelectedGroupIds}
            />
          )}

          {/* Time range */}
          {!isAllTime && (
            <div className="flex items-center bg-white rounded-lg border border-gray-200 px-3 shadow-sm gap-2 h-9">
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
          )}
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
      ) : overlayMode ? (
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
