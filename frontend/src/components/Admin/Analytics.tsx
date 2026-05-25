import { useState, useEffect } from "react";
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
  ResponsiveContainer,
} from "recharts";
import { AuthService } from "@/functions/authService";

type TimeSeriesData = {
  date: string;
  users: number;
  chat_sessions: number;
  questions: number;
};

type AnalyticsData = {
  timeSeries: TimeSeriesData[];
};

type ChartCardProps = {
  title: string;
  subtitle: string;
  children: React.ReactNode;
};

function ChartCard({ title, subtitle, children }: ChartCardProps) {
  return (
    <Card className="border-gray-200 shadow-sm overflow-hidden">
      <CardHeader className="pb-2 border-b border-gray-50 bg-gray-50/50">
        <CardTitle className="text-base font-semibold text-gray-900">
          {title}
        </CardTitle>
        <CardDescription className="text-xs">{subtitle}</CardDescription>
      </CardHeader>
      <CardContent className="p-6 h-[300px]">{children}</CardContent>
    </Card>
  );
}

function CustomTooltip({ active, payload, label }: any) {
  if (active && payload && payload.length) {
    return (
      <div className="bg-white border border-gray-200 p-3 rounded-lg shadow-xl text-sm">
        <p className="font-semibold text-gray-900 mb-2">{label}</p>
        {payload.map((entry: any, index: number) => (
          <div
            key={index}
            className="flex items-center gap-2 text-xs text-gray-600 mb-1"
          >
            <div
              className="w-2 h-2 rounded-full"
              style={{ backgroundColor: entry.color || entry.fill }}
            />
            <span className="capitalize">{entry.name}:</span>
            <span className="font-bold text-gray-900">{entry.value}</span>
          </div>
        ))}
      </div>
    );
  }
  return null;
}

export default function Analytics() {
  const [timeRange, setTimeRange] = useState("90d");
  const [analyticsData, setAnalyticsData] = useState<AnalyticsData>({
    timeSeries: [],
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchAnalytics();
  }, [timeRange]);

  const fetchAnalytics = async () => {
    try {
      setLoading(true);
      setError(null);

      const session = await AuthService.getAuthSession(true);
      const token = session.tokens.idToken;

      const analyticsUrl = `${import.meta.env.VITE_API_ENDPOINT}/admin/analytics?timeRange=${timeRange}`;

      const res = await fetch(analyticsUrl, {
        headers: {
          Authorization: token,
          "Content-Type": "application/json",
        },
      });

      if (!res.ok) throw new Error("Failed to fetch analytics data");

      const data = await res.json();
      setAnalyticsData(data);
    } catch (err) {
      console.error("Error fetching analytics:", err);
      setError("Failed to load analytics data");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-8 max-w-7xl mx-auto animate-in fade-in duration-500">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h2 className="text-3xl font-bold text-gray-900">Analytics</h2>
          <p className="text-gray-500 mt-1">
            Deep dive into student engagement and content usage.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center bg-white rounded-lg border border-gray-200 p-1 px-3 shadow-sm gap-2">
            <span className="text-sm font-medium text-gray-700 whitespace-nowrap">
              Last
            </span>
            <Input
              type="number"
              min={1}
              max={365}
              className="h-8 w-20 text-center"
              defaultValue={90}
              onChange={(e) => {
                const val = parseInt(e.target.value);
                if (!isNaN(val) && val > 0) {
                  // Cap at 365, min 1
                  const days = Math.min(Math.max(1, val), 365);
                  setTimeRange(`${days}d`);
                }
              }}
            />
            <span className="text-sm font-medium text-gray-700 whitespace-nowrap">
              Days
            </span>
          </div>
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
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary"></div>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Total Users Chart */}
          <ChartCard
            title="Total Users"
            subtitle="Total active students over time"
          >
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={analyticsData.timeSeries}
                margin={{ top: 10, right: 10, left: -20, bottom: 0 }}
              >
                <CartesianGrid
                  strokeDasharray="3 3"
                  vertical={false}
                  stroke="#e5e7eb"
                />
                <XAxis
                  dataKey="date"
                  axisLine={false}
                  tickLine={false}
                  tick={{ fontSize: 12, fill: "#6b7280" }}
                  dy={10}
                />
                <YAxis
                  axisLine={false}
                  tickLine={false}
                  tick={{ fontSize: 12, fill: "#6b7280" }}
                />
                <Tooltip content={<CustomTooltip />} />
                <Line
                  type="monotone"
                  dataKey="users"
                  stroke="rgb(0, 85, 183)"
                  strokeWidth={3}
                  dot={false}
                  activeDot={{ r: 6, strokeWidth: 0 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </ChartCard>

          {/* Total Chat Sessions Chart */}
          <ChartCard title="Total Chat Sessions" subtitle="Chat sessions created over time">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={analyticsData.timeSeries}
                margin={{ top: 10, right: 10, left: -20, bottom: 0 }}
              >
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />
                <XAxis
                  dataKey="date"
                  axisLine={false}
                  tickLine={false}
                  tick={{ fontSize: 12, fill: "#6b7280" }}
                  dy={10}
                />
                <YAxis
                  axisLine={false}
                  tickLine={false}
                  tick={{ fontSize: 12, fill: "#6b7280" }}
                />
                <Tooltip content={<CustomTooltip />} />
                <Line
                  type="monotone"
                  dataKey="chat_sessions"
                  stroke="rgb(0, 110, 220)"
                  strokeWidth={3}
                  dot={false}
                  activeDot={{ r: 6, strokeWidth: 0 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </ChartCard>

          {/* Total Questions Chart */}
          <ChartCard
            title="Total Questions"
            subtitle="Questions asked to chatbots"
          >
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={analyticsData.timeSeries}
                margin={{ top: 10, right: 10, left: -20, bottom: 0 }}
              >
                <CartesianGrid
                  strokeDasharray="3 3"
                  vertical={false}
                  stroke="#e5e7eb"
                />
                <XAxis
                  dataKey="date"
                  axisLine={false}
                  tickLine={false}
                  tick={{ fontSize: 12, fill: "#6b7280" }}
                  dy={10}
                />
                <YAxis
                  axisLine={false}
                  tickLine={false}
                  tick={{ fontSize: 12, fill: "#6b7280" }}
                />
                <Tooltip content={<CustomTooltip />} />
                <Line
                  type="monotone"
                  dataKey="questions"
                  stroke="rgb(50, 140, 240)"
                  strokeWidth={3}
                  dot={false}
                  activeDot={{ r: 6, strokeWidth: 0 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </ChartCard>
        </div>
      )}
    </div>
  );
}