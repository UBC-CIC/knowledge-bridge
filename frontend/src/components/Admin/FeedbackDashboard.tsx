import { useState, useEffect, useCallback } from "react";
import { DayPicker } from "react-day-picker";
import "react-day-picker/dist/style.css";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
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
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ThumbsDown, ThumbsUp, MessageSquare, ExternalLink, Calendar, ChevronLeft, ChevronRight, User, RefreshCw } from "lucide-react";
import { AuthService } from "@/functions/authService";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Cache — same pattern as ChatHistory
// ---------------------------------------------------------------------------
const CACHE_TTL = 5 * 60 * 1000; // 5 min

const getCached = (key: string) => {
  try {
    const item = localStorage.getItem(key);
    if (!item) return null;
    const parsed = JSON.parse(item);
    if (Date.now() - parsed.timestamp > CACHE_TTL) { localStorage.removeItem(key); return null; }
    return parsed.data;
  } catch { return null; }
};

const clearFeedbackCache = () => {
  Object.keys(localStorage).forEach(k => {
    if (k.startsWith("admin_feedback_")) localStorage.removeItem(k);
  });
};

const setCached = (key: string, data: any) => {
  try {
    localStorage.setItem(key, JSON.stringify({ timestamp: Date.now(), data }));
  } catch {
    // Evict all feedback cache entries and retry once
    Object.keys(localStorage).forEach(k => { if (k.startsWith("admin_feedback_")) localStorage.removeItem(k); });
    try { localStorage.setItem(key, JSON.stringify({ timestamp: Date.now(), data })); } catch { }
  }
};

const CATEGORIES = ["Not helpful", "Inaccurate", "Off-topic", "Other"] as const;
type Category = (typeof CATEGORIES)[number];

// Wong colorblind-safe palette
const CATEGORY_COLORS: Record<Category, string> = {
  "Not helpful": "bg-[#E69F00]/15 text-[#9a6b00] border-[#E69F00]/40",
  "Inaccurate":  "bg-[#D55E00]/15 text-[#923f00] border-[#D55E00]/40",
  "Off-topic":   "bg-[#0072B2]/15 text-[#004f7c] border-[#0072B2]/40",
  "Other":       "bg-gray-100 text-gray-600 border-gray-200",
};

const CATEGORY_BAR_COLORS: Record<Category, string> = {
  "Not helpful": "#E69F00",
  "Inaccurate":  "#D55E00",
  "Off-topic":   "#0072B2",
  "Other":       "#9ca3af",
};

type FeedbackItem = {
  id: string;
  message_id: string;
  chat_session_id: string;
  category: string | null;
  comment: string | null;
  ai_response: string;
  user_question: string | null;
  user_email: string | null;
  user_display_name: string | null;
  created_at: string;
};

type TrendPoint = { day: string; dislikes: number; likes: number };
type CategoryCount = { category: string; count: number };

type DatePreset = "7d" | "30d" | "all" | "custom";

type FeedbackDashboardProps = {
  onNavigateToSession: (sessionId: string, messageId?: string, userLabel?: string) => void;
};

const PAGE_SIZE = 5;

const getPresetRange = (preset: DatePreset): { from: string | null; to: string | null } => {
  const now = new Date();
  if (preset === "7d") {
    const d = new Date(now); d.setDate(d.getDate() - 7);
    return { from: d.toISOString(), to: null };
  }
  if (preset === "30d") {
    const d = new Date(now); d.setDate(d.getDate() - 30);
    return { from: d.toISOString(), to: null };
  }
  return { from: null, to: null };
};

const formatDay = (iso: string) =>
  new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });

const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

const formatPresetLabel = (preset: DatePreset, customRange: { from?: Date; to?: Date }) => {
  if (preset === "7d") return "Last 7 days";
  if (preset === "30d") return "Last 30 days";
  if (preset === "all") return "All time";
  if (customRange.from && customRange.to) {
    return `${customRange.from.toLocaleDateString([], { month: "short", day: "numeric" })} – ${customRange.to.toLocaleDateString([], { month: "short", day: "numeric" })}`;
  }
  return "Custom range";
};

export default function FeedbackDashboard({ onNavigateToSession }: FeedbackDashboardProps) {
  const [trend, setTrend] = useState<TrendPoint[]>([]);
  const [categoryCounts, setCategoryCounts] = useState<CategoryCount[]>([]);
  const [totalLikes, setTotalLikes] = useState(0);
  const [totalDislikes, setTotalDislikes] = useState(0);
  const [feedback, setFeedback] = useState<FeedbackItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [summaryLoading, setSummaryLoading] = useState(true);

  const [datePreset, setDatePreset] = useState<DatePreset>("7d");
  const [customRange, setCustomRange] = useState<{ from?: Date; to?: Date }>({});
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [activeCategory, setActiveCategory] = useState<Category | null>(null);

  const getHeaders = async () => ({
    Authorization: await AuthService.getIdToken(),
    "Content-Type": "application/json",
  });

  const buildDateParams = useCallback(() => {
    if (datePreset === "custom") {
      return {
        from: customRange.from?.toISOString() ?? null,
        to: customRange.to?.toISOString() ?? null,
      };
    }
    return getPresetRange(datePreset);
  }, [datePreset, customRange]);

  const fetchSummary = useCallback(async () => {
    const { from, to } = buildDateParams();
    const cacheKey = `admin_feedback_summary_${from ?? "all"}_${to ?? "all"}`;
    const cached = getCached(cacheKey);
    if (cached) {
      setTrend(cached.trend);
      setCategoryCounts(cached.categories);
      setTotalLikes(cached.totalLikes);
      setTotalDislikes(cached.totalDislikes);
      return;
    }
    setSummaryLoading(true);
    try {
      const params = new URLSearchParams();
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      const headers = await getHeaders();
      const res = await fetch(
        `${import.meta.env.VITE_API_ENDPOINT}/admin/feedback/summary?${params}`,
        { headers }
      );
      if (!res.ok) throw new Error("Failed to fetch summary");
      const data = await res.json();
      setTrend(data.trend ?? []);
      setCategoryCounts(data.categories ?? []);
      setTotalLikes(data.totalLikes ?? 0);
      setTotalDislikes(data.totalDislikes ?? 0);
      setCached(cacheKey, {
        trend: data.trend ?? [],
        categories: data.categories ?? [],
        totalLikes: data.totalLikes ?? 0,
        totalDislikes: data.totalDislikes ?? 0,
      });
    } catch (e) {
      console.error(e);
    } finally {
      setSummaryLoading(false);
    }
  }, [buildDateParams]);

  const fetchFeedback = useCallback(async (pageNum: number) => {
    const { from, to } = buildDateParams();
    const cacheKey = `admin_feedback_list_${from ?? "all"}_${to ?? "all"}_${activeCategory ?? "all"}_p${pageNum}`;
    const cached = getCached(cacheKey);
    if (cached) {
      setTotal(cached.total);
      setFeedback(cached.feedback);
      return;
    }
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      if (activeCategory) params.set("category", activeCategory);
      params.set("limit", String(PAGE_SIZE));
      params.set("offset", String(pageNum * PAGE_SIZE));
      const headers = await getHeaders();
      const res = await fetch(
        `${import.meta.env.VITE_API_ENDPOINT}/admin/feedback?${params}`,
        { headers }
      );
      if (!res.ok) throw new Error("Failed to fetch feedback");
      const data = await res.json();
      setTotal(data.total ?? 0);
      setFeedback(data.feedback ?? []);
      setCached(cacheKey, { total: data.total ?? 0, feedback: data.feedback ?? [] });
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [buildDateParams, activeCategory]);

  // Refetch everything when date range or category changes; reset to page 0
  useEffect(() => {
    setPage(0);
    fetchSummary();
    fetchFeedback(0);
  }, [datePreset, customRange, activeCategory]);

  // Refetch list only when page advances beyond 0 (page 0 is handled above)
  useEffect(() => {
    if (page === 0) return;
    fetchFeedback(page);
  }, [page]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const getCategoryCount = (cat: Category) =>
    categoryCounts.find(c => c.category === cat)?.count ?? 0;

  const handlePresetClick = (preset: DatePreset) => {
    if (preset !== "custom") setCustomRange({});
    setDatePreset(preset);
  };

  const handleRefresh = () => {
    clearFeedbackCache();
    setPage(0);
    fetchSummary();
    fetchFeedback(0);
  };

  const handleCustomRangeSelect = (range: { from?: Date; to?: Date } | undefined) => {
    setCustomRange(range ?? {});
    if (range?.from && range?.to) {
      setDatePreset("custom");
      setCalendarOpen(false);
    }
  };

  return (
    <div className="space-y-8 max-w-6xl mx-auto animate-in fade-in duration-500">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-3xl font-bold text-gray-900">Feedback</h2>
          <p className="text-gray-500 mt-1">Feedback from users on AI responses.</p>
        </div>

        {/* Date filter + refresh */}
        <div className="flex items-center gap-2">
          <button
            onClick={handleRefresh}
            disabled={loading || summaryLoading}
            className="flex items-center gap-2 px-3 py-1.5 bg-white border border-gray-200 rounded-lg text-xs font-medium text-gray-600 hover:bg-gray-50 hover:text-gray-900 transition-colors shadow-sm disabled:opacity-50"
            title="Clear cache and refresh"
          >
            <RefreshCw size={12} className={(loading || summaryLoading) ? "animate-spin text-primary" : ""} />
            Refresh
          </button>
          {(["7d", "30d", "all"] as DatePreset[]).map(p => (
            <button
              key={p}
              onClick={() => handlePresetClick(p)}
              className={cn(
                "px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors",
                datePreset === p
                  ? "bg-primary text-white border-primary"
                  : "bg-white text-gray-600 border-gray-200 hover:border-gray-300"
              )}
            >
              {p === "7d" ? "Last 7 days" : p === "30d" ? "Last 30 days" : "All time"}
            </button>
          ))}
          <Popover open={calendarOpen} onOpenChange={setCalendarOpen}>
            <PopoverTrigger asChild>
              <button
                className={cn(
                  "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors",
                  datePreset === "custom"
                    ? "bg-primary text-white border-primary"
                    : "bg-white text-gray-600 border-gray-200 hover:border-gray-300"
                )}
              >
                <Calendar size={12} />
                {datePreset === "custom" ? formatPresetLabel("custom", customRange) : "Custom"}
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="end">
              <DayPicker
                mode="range"
                selected={customRange as any}
                onSelect={handleCustomRangeSelect as any}
                disabled={{ after: new Date() }}
                numberOfMonths={2}
              />
            </PopoverContent>
          </Popover>
        </div>
      </div>

      {/* Summary stat cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {/* Total Likes */}
        <Card className="border-gray-200 shadow-sm">
          <CardContent className="p-6 flex items-center justify-center h-full min-h-[140px] gap-5">
            <div className="flex items-center justify-center w-14 h-14 rounded-full bg-green-50 flex-shrink-0">
              <ThumbsUp className="h-7 w-7 text-green-600" />
            </div>
            <div>
              <div className="text-5xl font-bold text-green-600 leading-none">{totalLikes}</div>
              <div className="mt-2 text-sm font-semibold text-green-700 tracking-wide">Total Likes</div>
            </div>
          </CardContent>
        </Card>

        {/* Total Dislikes */}
        <Card className="border-gray-200 shadow-sm">
          <CardContent className="p-6 flex items-center justify-center h-full min-h-[140px] gap-5">
            <div className="flex items-center justify-center w-14 h-14 rounded-full bg-red-50 flex-shrink-0">
              <ThumbsDown className="h-7 w-7 text-red-500" />
            </div>
            <div>
              <div className="text-5xl font-bold text-red-500 leading-none">{totalDislikes}</div>
              <div className="mt-2 text-sm font-semibold text-red-600 tracking-wide">Total Dislikes</div>
            </div>
          </CardContent>
        </Card>


        {/* Category breakdown */}
        <Card className="border-gray-200 shadow-sm">
          <CardContent className="p-5 flex flex-col justify-center h-full min-h-[140px]">
            <div className="text-base font-semibold text-gray-700 mb-4">Dislike Reasons</div>
            {summaryLoading ? (
              <div className="flex items-center justify-center h-16">
                <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-primary" />
              </div>
            ) : (
              <div className="space-y-3">
                {CATEGORIES.map(cat => {
                  const count = getCategoryCount(cat);
                  const maxCount = Math.max(...CATEGORIES.map(c => getCategoryCount(c)), 1);
                  const pct = Math.round((count / maxCount) * 100);
                  return (
                    <div key={cat}>
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-sm text-gray-600">{cat}</span>
                        <span className="text-sm font-bold text-gray-800">{count}</span>
                      </div>
                      <div className="w-full h-2 rounded-full bg-gray-100">
                        <div
                          className="h-2 rounded-full transition-all duration-500"
                          style={{ width: `${pct}%`, backgroundColor: CATEGORY_BAR_COLORS[cat] }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Trend chart */}
      <Card className="border-gray-200 shadow-sm">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Ratings over time</CardTitle>
          <CardDescription className="text-xs">{formatPresetLabel(datePreset, customRange)}</CardDescription>
        </CardHeader>
        <CardContent>
          {summaryLoading ? (
            <div className="flex items-center justify-center h-40">
              <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary" />
            </div>
          ) : trend.length === 0 ? (
            <div className="flex items-center justify-center h-40 text-gray-400 text-sm">No data for this period</div>
          ) : (
            <ResponsiveContainer width="100%" height={180}>
              <LineChart data={trend} margin={{ top: 4, right: 16, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis dataKey="day" tickFormatter={formatDay} tick={{ fontSize: 11 }} />
                <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
                <Tooltip
                  labelFormatter={formatDay}
                  contentStyle={{ fontSize: 12 }}
                />
                <Legend
                  wrapperStyle={{ fontSize: 12 }}
                  content={() => (
                    <div className="flex items-center justify-center gap-5 pt-2">
                      <div className="flex items-center gap-1.5">
                        <svg width="24" height="10">
                          <line x1="0" y1="5" x2="24" y2="5" stroke="#ef4444" strokeWidth="2" strokeDasharray="4 2" />
                        </svg>
                        <span style={{ fontSize: 12, color: "#6b7280" }}>Dislikes</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <svg width="24" height="10">
                          <line x1="0" y1="5" x2="24" y2="5" stroke="#22c55e" strokeWidth="2" />
                        </svg>
                        <span style={{ fontSize: 12, color: "#6b7280" }}>Likes</span>
                      </div>
                    </div>
                  )}
                />
                <Line type="monotone" dataKey="dislikes" stroke="#ef4444" strokeWidth={2} strokeDasharray="4 2" dot={{ r: 4 }} name="Dislikes" />
                <Line type="monotone" dataKey="likes" stroke="#22c55e" strokeWidth={2} dot={{ r: 4 }} name="Likes" />
              </LineChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      {/* Feedback list */}
      <Card className="border-gray-200 shadow-sm">
        <CardHeader className="pb-0 border-b">
          <div className="flex items-center justify-between mb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <MessageSquare className="h-4 w-4 text-primary" />
              All feedback
            </CardTitle>
          </div>
          {/* Category filter chips */}
          <div className="flex items-center gap-2 pb-3 flex-wrap">
            <button
              onClick={() => setActiveCategory(null)}
              className={cn(
                "px-3 py-1 rounded-full text-xs font-medium border transition-colors",
                activeCategory === null
                  ? "bg-primary text-white border-primary"
                  : "bg-white text-gray-600 border-gray-200 hover:border-gray-300"
              )}
            >
              All
            </button>
            {CATEGORIES.map(cat => (
              <button
                key={cat}
                onClick={() => setActiveCategory(prev => prev === cat ? null : cat)}
                className={cn(
                  "px-3 py-1 rounded-full text-xs font-medium border transition-colors",
                  activeCategory === cat
                    ? "bg-primary text-white border-primary"
                    : cn("bg-white border-gray-200 hover:border-gray-300", CATEGORY_COLORS[cat])
                )}
              >
                {cat}
              </button>
            ))}
          </div>
        </CardHeader>

        <CardContent className="p-0">
          {loading ? (
            <div className="flex items-center justify-center py-16">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
            </div>
          ) : feedback.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-gray-400 gap-2">
              <ThumbsDown className="h-10 w-10 text-gray-200" />
              <p className="text-sm">No feedback found for this period</p>
            </div>
          ) : (
            <>
              <div className="divide-y divide-gray-100">
                {feedback.map(item => {
                  const cat = (item.category ?? "Other") as Category;
                  const userLabel = item.user_display_name || item.user_email || null;
                  return (
                    <button
                      key={item.id}
                      onClick={() => onNavigateToSession(item.chat_session_id, item.message_id, userLabel ?? undefined)}
                      className="w-full text-left px-5 py-4 hover:bg-gray-50 transition-colors group"
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex-1 min-w-0 space-y-1.5">
                          {item.user_question && (
                            <p className="text-xs text-gray-500 truncate">
                              <span className="font-medium text-gray-400 mr-1">Q:</span>
                              {item.user_question}
                            </p>
                          )}
                          <div className="text-sm text-gray-800 line-clamp-3 prose prose-sm max-w-none prose-p:my-0 prose-headings:my-0 prose-ul:my-0 prose-li:my-0">
                            <span className="font-medium text-gray-400 mr-1 not-prose">A:</span>
                            <ReactMarkdown
                              remarkPlugins={[remarkGfm]}
                              rehypePlugins={[rehypeSanitize]}
                            >
                              {item.ai_response}
                            </ReactMarkdown>
                          </div>
                          {item.comment && (
                            <p className="text-xs text-gray-500 italic">"{item.comment}"</p>
                          )}
                          {userLabel && (
                            <p className="text-xs text-gray-400 flex items-center gap-1">
                              <User size={10} />
                              {userLabel}
                            </p>
                          )}
                        </div>
                        <div className="flex-shrink-0 flex flex-col items-end gap-1.5">
                          <span className={cn("inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border", CATEGORY_COLORS[cat])}>
                            {cat}
                          </span>
                          <span className="text-xs text-gray-400">{formatDate(item.created_at)}</span>
                          <ExternalLink size={12} className="text-gray-300 group-hover:text-primary transition-colors" />
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>

              {/* Pagination */}
              <div className="flex items-center justify-between px-5 py-3 border-t bg-gray-50/50">
                <button
                  onClick={() => setPage(p => p - 1)}
                  disabled={page === 0}
                  className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium border border-gray-200 bg-white text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  <ChevronLeft size={14} /> Prev
                </button>
                <span className="text-xs text-gray-500">
                  Page {page + 1} of {totalPages} &nbsp;·&nbsp; {total} total
                </span>
                <button
                  onClick={() => setPage(p => p + 1)}
                  disabled={page >= totalPages - 1}
                  className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium border border-gray-200 bg-white text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  Next <ChevronRight size={14} />
                </button>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
