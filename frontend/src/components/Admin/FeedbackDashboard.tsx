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
import { ThumbsDown, ThumbsUp, MessageSquare, ExternalLink, Calendar, ChevronLeft, ChevronRight, User } from "lucide-react";
import { AuthService } from "@/functions/authService";
import { cn } from "@/lib/utils";

const CATEGORIES = ["Not helpful", "Inaccurate", "Off-topic", "Other"] as const;
type Category = (typeof CATEGORIES)[number];

const CATEGORY_COLORS: Record<Category, string> = {
  "Not helpful": "bg-orange-100 text-orange-700 border-orange-200",
  "Inaccurate":  "bg-red-100 text-red-700 border-red-200",
  "Off-topic":   "bg-purple-100 text-purple-700 border-purple-200",
  "Other":       "bg-gray-100 text-gray-700 border-gray-200",
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
    setSummaryLoading(true);
    try {
      const { from, to } = buildDateParams();
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
    } catch (e) {
      console.error(e);
    } finally {
      setSummaryLoading(false);
    }
  }, [buildDateParams]);

  const fetchFeedback = useCallback(async (pageNum: number) => {
    setLoading(true);
    try {
      const { from, to } = buildDateParams();
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
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [buildDateParams, activeCategory]);

  // Refetch everything when date range or category changes
  useEffect(() => {
    setPage(0);
    fetchSummary();
    fetchFeedback(0);
  }, [datePreset, customRange, activeCategory]);

  // Refetch list when page changes (but not summary)
  useEffect(() => {
    fetchFeedback(page);
  }, [page]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const getCategoryCount = (cat: Category) =>
    categoryCounts.find(c => c.category === cat)?.count ?? 0;

  const handlePresetClick = (preset: DatePreset) => {
    if (preset !== "custom") setCustomRange({});
    setDatePreset(preset);
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
          <p className="text-gray-500 mt-1">Negative feedback from users on AI responses.</p>
        </div>

        {/* Date filter */}
        <div className="flex items-center gap-2">
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
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
        <Card className="border-gray-200 shadow-sm col-span-1">
          <CardContent className="p-4">
            <div className="text-2xl font-bold text-green-600">{totalLikes}</div>
            <div className="mt-1 flex items-center gap-1 text-xs text-green-600 font-medium">
              <ThumbsUp size={11} /> Likes
            </div>
          </CardContent>
        </Card>
        <Card className="border-gray-200 shadow-sm col-span-1">
          <CardContent className="p-4">
            <div className="text-2xl font-bold text-red-600">{totalDislikes}</div>
            <div className="mt-1 flex items-center gap-1 text-xs text-red-600 font-medium">
              <ThumbsDown size={11} /> Dislikes
            </div>
          </CardContent>
        </Card>
        {CATEGORIES.map(cat => (
          <Card key={cat} className="border-gray-200 shadow-sm col-span-1">
            <CardContent className="p-4">
              <div className="text-2xl font-bold text-gray-900">{getCategoryCount(cat)}</div>
              <div className={cn("mt-1 inline-flex items-center px-1.5 py-0.5 rounded-full text-xs font-medium border", CATEGORY_COLORS[cat])}>
                {cat}
              </div>
            </CardContent>
          </Card>
        ))}
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
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Line type="monotone" dataKey="likes" stroke="#22c55e" strokeWidth={2} dot={{ r: 3 }} name="Likes" />
                <Line type="monotone" dataKey="dislikes" stroke="#ef4444" strokeWidth={2} dot={{ r: 3 }} name="Dislikes" />
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
