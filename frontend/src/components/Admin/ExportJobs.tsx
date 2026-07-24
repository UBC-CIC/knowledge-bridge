import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Download, RefreshCw } from "lucide-react";
import { AuthService } from "@/functions/authService";
import { cn } from "@/lib/utils";

type ExportStatus = "pending" | "processing" | "completed" | "failed";
type ExportType = "chat" | "analytics";

type ExportRun = {
    id: string;
    status: ExportStatus;
    scope: string;
    export_type: ExportType;
    scope_label: string;
    presigned_url: string | null;
    url_expires_at: string | null;
    error_message: string | null;
    requested_at: string;
    completed_at: string | null;
};

const STATUS_STYLES: Record<ExportStatus, string> = {
    pending:    "bg-gray-100 text-gray-700 border-gray-200",
    processing: "bg-blue-50 text-blue-700 border-blue-200",
    completed:  "bg-green-50 text-green-700 border-green-200",
    failed:     "bg-red-50 text-red-600 border-red-200",
};

const EXPORT_TYPE_STYLES: Record<ExportType, string> = {
    chat:      "bg-violet-50 text-violet-700 border-violet-200",
    analytics: "bg-amber-50 text-amber-700 border-amber-200",
};

const VISIBLE_GROUPS = 2;

function ScopeCell({ label, type }: { label: string; type: ExportType }) {
    if (type !== "analytics") {
        return <span className="font-medium text-gray-800 text-sm">{label}</span>;
    }
    // Format: "Group A, Group B · Last 30d"
    const [groupsPart, timePart] = label.split(" · ");
    const groupNames = groupsPart ? groupsPart.split(", ").filter(Boolean) : [];
    const visible = groupNames.slice(0, VISIBLE_GROUPS);
    const overflow = groupNames.slice(VISIBLE_GROUPS);
    return (
        <div className="flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-1">
                {visible.map(name => (
                    <span key={name} className="inline-flex items-center px-2 py-0.5 rounded-md bg-amber-50 border border-amber-200 text-amber-700 text-xs font-medium">
                        {name}
                    </span>
                ))}
                {overflow.length > 0 && (
                    <span
                        className="inline-flex items-center px-2 py-0.5 rounded-md bg-gray-100 border border-gray-200 text-gray-500 text-xs font-medium cursor-default"
                        title={overflow.join(", ")}
                    >
                        +{overflow.length} more
                    </span>
                )}
            </div>
            {timePart && (
                <span className="text-xs text-gray-400">{timePart}</span>
            )}
        </div>
    );
}

const LIMIT = 10;

export default function ExportJobs() {
    const [runs, setRuns] = useState<ExportRun[]>([]);
    const [total, setTotal] = useState(0);
    const [offset, setOffset] = useState(0);
    const [loading, setLoading] = useState(false);
    const [typeFilter, setTypeFilter] = useState<ExportType | "all">("all");

    const getAuthHeaders = async () => ({
        Authorization: await AuthService.getIdToken(),
        "Content-Type": "application/json",
    });

    const formatDate = (d?: string | null) => {
        if (!d) return "—";
        return new Date(d).toLocaleString([], {
            month: "short", day: "numeric",
            hour: "2-digit", minute: "2-digit",
        });
    };

    const fetchRuns = async (newOffset = 0) => {
        setLoading(true);
        try {
            const headers = await getAuthHeaders();
            const typeParam = typeFilter !== "all" ? `&export_type=${typeFilter}` : "";
            const res = await fetch(
                `${import.meta.env.VITE_API_ENDPOINT}/admin/export/runs?limit=${LIMIT}&offset=${newOffset}${typeParam}`,
                { headers }
            );
            if (!res.ok) throw new Error("Failed to fetch export runs");
            const data = await res.json();
            setRuns(data.runs ?? []);
            setTotal(data.total ?? 0);
            setOffset(newOffset);
        } catch (e) {
            console.error(e);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => { fetchRuns(0); }, [typeFilter]);

    return (
        <div className="space-y-6 max-w-5xl mx-auto animate-in fade-in duration-500">
            <div className="flex items-center justify-between">
                <div>
                    <h2 className="text-3xl font-bold text-gray-900">Export Jobs</h2>
                    <p className="text-gray-500 mt-1">
                        Track exports you've triggered. Download links are valid for 7 days.
                    </p>
                </div>
                <button
                    onClick={() => fetchRuns(offset)}
                    disabled={loading}
                    className="flex items-center gap-2 px-4 py-2 bg-white border border-gray-200 rounded-lg text-sm font-medium text-gray-600 hover:bg-gray-50 hover:text-gray-900 transition-colors shadow-sm"
                >
                    <RefreshCw size={16} className={loading ? "animate-spin text-primary" : ""} />
                    Refresh
                </button>
            </div>

            <Card className="border-gray-200 shadow-sm">
                <CardHeader className="border-b pb-4">
                    <CardTitle className="flex items-center gap-2 text-lg">
                        <Download className="h-5 w-5 text-primary" />
                        Export History
                    </CardTitle>
                    <CardDescription className="text-sm">
                        Each export is scoped to all chats, a group, a specific user, or analytics data.
                    </CardDescription>
                </CardHeader>
                <CardContent className="p-0">
                    {loading && runs.length === 0 ? (
                        <div className="text-center text-gray-400 py-16 text-base">Loading…</div>
                    ) : runs.length === 0 ? (
                        <div className="flex flex-col items-center justify-center py-16 text-gray-400 gap-3">
                            <Download className="h-10 w-10 text-gray-200" />
                            <p className="text-base">No export jobs yet.</p>
                            <p className="text-sm text-gray-400">
                                Trigger one from <span className="font-medium text-gray-600">Chat History</span> or <span className="font-medium text-gray-600">Analytics</span>.
                            </p>
                        </div>
                    ) : (
                        <div className="overflow-x-auto">
                            <table className="w-full text-sm text-left">
                                <thead>
                                    <tr className="border-b bg-gray-50/60 text-sm text-gray-500 uppercase tracking-wide">
                                        <th className="px-6 py-3">Requested</th>
                                        <th className="px-6 py-3">
                                            <div className="flex items-center gap-2">
                                                Export Type
                                                <select
                                                    value={typeFilter}
                                                    onChange={e => setTypeFilter(e.target.value as ExportType | "all")}
                                                    className="text-xs font-normal normal-case tracking-normal border border-gray-200 rounded px-1.5 py-0.5 bg-white text-gray-600 focus:outline-none focus:ring-1 focus:ring-primary"
                                                >
                                                    <option value="all">All</option>
                                                    <option value="chat">Chat</option>
                                                    <option value="analytics">Analytics</option>
                                                </select>
                                            </div>
                                        </th>
                                        <th className="px-6 py-3">Scope</th>
                                        <th className="px-6 py-3">Status</th>
                                        <th className="px-6 py-3">Completed</th>
                                        <th className="px-6 py-3">Download</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-gray-100">
                                    {runs.map(run => {
                                        const expired = run.url_expires_at
                                            ? new Date(run.url_expires_at) < new Date()
                                            : false;
                                        const exportType: ExportType = run.export_type ?? (run.scope === "analytics" ? "analytics" : "chat");
                                        return (
                                            <tr key={run.id} className="hover:bg-gray-50/50 transition-colors">
                                                <td className="px-6 py-4 text-gray-500 whitespace-nowrap text-sm">
                                                    {formatDate(run.requested_at)}
                                                </td>
                                                <td className="px-6 py-4">
                                                    <span className={cn(
                                                        "inline-flex items-center px-2.5 py-1 rounded-full font-medium border text-xs",
                                                        EXPORT_TYPE_STYLES[exportType]
                                                    )}>
                                                        {exportType === "analytics" ? "Analytics" : "Chat"}
                                                    </span>
                                                </td>
                                                <td className="px-6 py-4">
                                                    <ScopeCell label={run.scope_label} type={exportType} />
                                                </td>
                                                <td className="px-6 py-4">
                                                    <span className={cn(
                                                        "inline-flex items-center gap-1 px-2.5 py-1 rounded-full font-medium border text-xs",
                                                        STATUS_STYLES[run.status]
                                                    )}>
                                                        {(run.status === "processing" || run.status === "pending") && (
                                                            <RefreshCw size={11} className="animate-spin" />
                                                        )}
                                                        {run.status.charAt(0).toUpperCase() + run.status.slice(1)}
                                                    </span>
                                                </td>
                                                <td className="px-6 py-4 text-gray-500 whitespace-nowrap text-sm">
                                                    {formatDate(run.completed_at)}
                                                </td>
                                                <td className="px-6 py-4">
                                                    {run.status === "completed" && run.presigned_url && !expired ? (
                                                        <a
                                                            href={run.presigned_url}
                                                            download
                                                            className="inline-flex items-center gap-1.5 text-primary hover:underline font-medium text-sm"
                                                        >
                                                            <Download size={14} />
                                                            Download
                                                        </a>
                                                    ) : run.status === "completed" && expired ? (
                                                        <span className="text-gray-400 italic text-sm">Link expired</span>
                                                    ) : run.status === "failed" ? (
                                                        <span
                                                            className="text-red-500 text-xs cursor-help"
                                                            title={run.error_message ?? "Unknown error"}
                                                        >
                                                            {run.error_message
                                                                ? run.error_message.slice(0, 50) + (run.error_message.length > 50 ? "…" : "")
                                                                : "Failed"}
                                                        </span>
                                                    ) : (
                                                        <span className="text-gray-400 text-sm">—</span>
                                                    )}
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>

                            {/* Pagination */}
                            {total > LIMIT && (
                                <div className="flex items-center justify-between px-6 py-4 border-t text-sm text-gray-500">
                                    <span>{offset + 1}–{Math.min(offset + LIMIT, total)} of {total}</span>
                                    <div className="flex gap-2">
                                        <button
                                            onClick={() => fetchRuns(offset - LIMIT)}
                                            disabled={offset === 0 || loading}
                                            className="px-3 py-1.5 border rounded text-sm font-medium disabled:opacity-40 hover:bg-gray-50"
                                        >
                                            Previous
                                        </button>
                                        <button
                                            onClick={() => fetchRuns(offset + LIMIT)}
                                            disabled={offset + LIMIT >= total || loading}
                                            className="px-3 py-1.5 border rounded text-sm font-medium disabled:opacity-40 hover:bg-gray-50"
                                        >
                                            Next
                                        </button>
                                    </div>
                                </div>
                            )}
                        </div>
                    )}
                </CardContent>
            </Card>
        </div>
    );
}
