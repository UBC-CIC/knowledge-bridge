import { useState, useEffect, useCallback } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { ThumbsDown, MessageSquare, ExternalLink } from "lucide-react";
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
  created_at: string;
};

type TrendPoint = { day: string; count: number };
type CategoryCount = { category: string; count: number };

type FeedbackDashboardProps = {
  onNavigateToSession: (sessionId: string, messageId?: string) => void;
};

const LIMIT = 50;

const sevenDaysAgo = () => {
  const d = new Date();
  d.setDate(d.getDate() - 7);
  return d.toISOString();
};

const formatDay = (iso: string) =>
  new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });

const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

export default function FeedbackDashboard({ onNavigateToSession }: FeedbackDashboardProps) {
  const [trend, setTrend] = useState<TrendPoint[]>([]);
  const [categoryCounts, setCategoryCounts] = useState<CategoryCount[]>([]);
  const [feedback, setFeedback] = useState<FeedbackItem[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [activeCategory, setActiveCategory] = useState<Category | null>(null);

  const from = sevenDaysAgo();

  const getHeaders = async () => ({
    Authorization: await AuthService.getIdToken(),
    "Content-Type": "application/json",
  });

  const fetchSummary = useCallback(async () => {
    try {
      const headers = await getHeaders();
      const res = await fetch(
        `${import.meta.env.VITE_API_ENDPOINT}/admin/feedback/summary?from=${encodeURIComponent(from)}`,
        { headers }
      );
      if (!res.ok) throw new Error("Failed to fetch feedback summary");
      const data = await res.json();
      setTrend(data.trend ?? []);
      setCategoryCounts(data.categories ?? []);
    } catch (e) {
      console.error(e);
    }
  }, []);

  const fetchFeedback = useCallback(async (newOffset: number, append: boolean) => {
    newOffset === 0 ? setLoading(true) : setLoadingMore(true);
    try {
      const headers = await getHeaders();
      const res = await fetch(
        `${import.meta.env.VITE_API_ENDPOINT}/admin/feedback?from=${encodeURIComponent(from)}&limit=${LIMIT}&offset=${newOffset}`,
        { headers }
      );
      if (!res.ok) throw new Error("Failed to fetch feedback");
      const data = await res.json();
      setTotal(data.total ?? 0);
      setFeedback(prev => append ? [...prev, ...(data.feedback ?? [])] : (data.feedback ?? []));
      setOffset(newOffset);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, []);

  useEffect(() => {
    fetchSummary();
    fetchFeedback(0, false);
  }, []);

  const getCategoryCount = (cat: Category) =>
    categoryCounts.find(c => c.category === cat)?.count ?? 0;

  const filteredFeedback = activeCategory
    ? feedback.filter(f => f.category === activeCategory)
    : feedback;

  return (
    <div className="space-y-8 max-w-6xl mx-auto animate-in fade-in duration-500">
      <div>
        <h2 className="text-3xl font-bold text-gray-900">Feedback</h2>
        <p className="text-gray-500 mt-1">Last 7 days of negative feedback.</p>
      </div>

      {/* Category stat cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {CATEGORIES.map(cat => (
          <button
            key={cat}
            onClick={() => setActiveCategory(prev => prev === cat ? null : cat)}
            className={cn(
              "text-left p-4 rounded-xl border transition-all shadow-sm hover:shadow-md",
              activeCategory === cat
                ? "ring-2 ring-primary border-primary bg-primary/5"
                : "bg-white border-gray-200 hover:border-gray-300"
            )}
          >
            <div className="text-2xl font-bold text-gray-900">{getCategoryCount(cat)}</div>
            <div className={cn("mt-1.5 inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border", CATEGORY_COLORS[cat])}>
              {cat}
            </div>
          </button>
        ))}
      </div>

      {/* 7-day trend chart */}
      <Card className="border-gray-200 shadow-sm">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <ThumbsDown className="h-4 w-4 text-red-500" />
            Dislikes per day
          </CardTitle>
          <CardDescription className="text-xs">Last 7 days</CardDescription>
        </CardHeader>
        <CardContent>
          {trend.length === 0 ? (
            <div className="flex items-center justify-center h-32 text-gray-400 text-sm">No data yet</div>
          ) : (
            <ResponsiveContainer width="100%" height={160}>
              <LineChart data={trend} margin={{ top: 4, right: 16, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis dataKey="day" tickFormatter={formatDay} tick={{ fontSize: 11 }} />
                <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
                <Tooltip
                  labelFormatter={formatDay}
                  formatter={(v: number) => [v, "Dislikes"]}
                  contentStyle={{ fontSize: 12 }}
                />
                <Line
                  type="monotone"
                  dataKey="count"
                  stroke="hsl(var(--primary))"
                  strokeWidth={2}
                  dot={{ r: 3 }}
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      {/* Feedback list */}
      <Card className="border-gray-200 shadow-sm">
        <CardHeader className="pb-3 border-b">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base flex items-center gap-2">
                <MessageSquare className="h-4 w-4 text-primary" />
                All feedback
                {activeCategory && (
                  <span className={cn("ml-1 px-2 py-0.5 rounded-full text-xs font-medium border", CATEGORY_COLORS[activeCategory])}>
                    {activeCategory}
                  </span>
                )}
              </CardTitle>
              <CardDescription className="text-xs mt-0.5">
                {activeCategory
                  ? "Filtered by category — click the card above to clear"
                  : "Click a row to jump to that message in Chat History"}
              </CardDescription>
            </div>
            {activeCategory && (
              <button
                onClick={() => setActiveCategory(null)}
                className="text-xs text-primary hover:underline"
              >
                Clear filter
              </button>
            )}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <div className="flex items-center justify-center py-16">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
            </div>
          ) : filteredFeedback.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-gray-400 gap-2">
              <ThumbsDown className="h-10 w-10 text-gray-200" />
              <p className="text-sm">No feedback found</p>
            </div>
          ) : (
            <>
              <div className="divide-y divide-gray-100">
                {filteredFeedback.map(item => {
                  const cat = (item.category ?? "Other") as Category;
                  return (
                    <button
                      key={item.id}
                      onClick={() => onNavigateToSession(item.chat_session_id, item.message_id)}
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
                          <p className="text-sm text-gray-800 line-clamp-2">
                            <span className="font-medium text-gray-400 mr-1">A:</span>
                            {item.ai_response}
                          </p>
                          {item.comment && (
                            <p className="text-xs text-gray-500 italic">"{item.comment}"</p>
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

              {!activeCategory && offset + LIMIT < total && (
                <div className="px-5 py-4 border-t">
                  <button
                    onClick={() => fetchFeedback(offset + LIMIT, true)}
                    disabled={loadingMore}
                    className="w-full text-xs text-primary hover:underline disabled:opacity-40"
                  >
                    {loadingMore ? "Loading…" : `Load more (${feedback.length} / ${total})`}
                  </button>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
