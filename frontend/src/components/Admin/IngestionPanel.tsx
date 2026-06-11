import React, { useState, useEffect, useRef, useCallback } from "react";
import { Play, Square, Loader2, RefreshCw, ChevronDown, ChevronUp, ChevronLeft, ChevronRight, Clock, Trash2, Save, Calendar, CheckCircle2, XCircle } from "lucide-react";
import { AuthService } from "@/functions/authService";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type RunStatus = "running" | "stopping" | "stopped" | "completed" | "failed";

type IngestionRun = {
  id: string;
  glue_run_id: string | null;
  triggered_by: string;
  status: RunStatus;
  started_at: string;
  finished_at: string | null;
  total_documents: number;
  processed_documents: number;
  ingested_documents: number;
  skipped_documents: number;
  failed_documents: number;
  error_message: string | null;
  metadata: Record<string, unknown> | null;
};

type LogLine = { timestamp: number; message: string };

type ScheduleConfig = {
  exists: boolean;
  cron?: string;
  timezone?: string;
  enabled?: boolean;
  force_full?: boolean;
  next_run_at?: string | null;
};

const STATUS_BADGE: Record<string, string> = {
  running:   "bg-blue-100 text-blue-700",
  stopping:  "bg-yellow-100 text-yellow-700",
  stopped:   "bg-red-100 text-red-700",
  completed: "bg-green-100 text-green-700",
  failed:    "bg-red-100 text-red-700",
};

const TERMINAL = new Set(["completed", "failed", "stopped"]);

function formatDuration(start: string, end: string | null) {
  const ms = (end ? new Date(end) : new Date()).getTime() - new Date(start).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function formatDateTime(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

function describeCron(cron: string, tz: string): string {
  if (!cron) return "";
  const parts = cron.trim().split(/\s+/);
  if (parts.length < 5) return `cron(${cron})`;
  const [min, hr, dom, , dow] = parts;
  const pad = (v: string) => v.padStart(2, "0");
  const timeStr = (hr !== "*" && hr !== "?") ? `${pad(hr)}:${pad(min !== "*" ? min : "00")}` : null;
  let when = "";
  if (dom !== "*" && dom !== "?") {
    when = `day ${dom} of every month`;
  } else if (dow !== "*" && dow !== "?") {
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const d = parseInt(dow, 10);
    when = isNaN(d) ? `every ${dow}` : `every ${days[d] ?? dow}`;
  } else {
    when = "every day";
  }
  return timeStr ? `${when} at ${timeStr} (${tz})` : `${when} (${tz})`;
}

const PRESETS = [
  { label: "Daily",   cron: "0 9 * * ? *",  desc: "Every day at 9:00 AM" },
  { label: "Weekly",  cron: "0 9 ? * MON *", desc: "Every Monday at 9:00 AM" },
  { label: "Monthly", cron: "0 9 1 * ? *",   desc: "1st of every month at 9:00 AM" },
  { label: "Custom",  cron: "",              desc: "Enter your own cron expression" },
];

const TIMEZONES = [
  "America/Vancouver",
  "America/Toronto",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Halifax",
  "America/St_Johns",
  "UTC",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Asia/Tokyo",
  "Asia/Shanghai",
  "Asia/Kolkata",
  "Australia/Sydney",
  "Pacific/Auckland",
];

const PAGE_SIZE = 5;

// ─── Schedule Panel ────────────────────────────────────────────────────────────

function SchedulePanel() {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [schedule, setSchedule] = useState<ScheduleConfig | null>(null);

  const [selectedPreset, setSelectedPreset] = useState("Daily");
  const [cron, setCron] = useState("0 9 * * ? *");
  const [timezone, setTimezone] = useState("America/Vancouver");
  const [enabled, setEnabled] = useState(true);
  const [forceFull, setForceFull] = useState(false);
  const [tzSearch, setTzSearch] = useState("");
  const [tzOpen, setTzOpen] = useState(false);
  const tzRef = useRef<HTMLDivElement>(null);

  const getToken = () => AuthService.getIdToken();

  const fetchSchedule = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const token = await getToken();
      const res = await fetch(`${import.meta.env.VITE_API_ENDPOINT}/admin/ingestion/schedule`, {
        headers: { Authorization: token },
      });
      const data: ScheduleConfig = await res.json();
      setSchedule(data);
      if (data.exists) {
        setCron(data.cron ?? "0 9 * * ? *");
        setTimezone(data.timezone ?? "America/Vancouver");
        setEnabled(data.enabled ?? true);
        setForceFull(data.force_full ?? false);
        const match = PRESETS.find(p => p.cron === data.cron);
        setSelectedPreset(match?.label ?? "Custom");
      }
    } catch {
      setError("Failed to load schedule");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open && schedule === null) fetchSchedule();
  }, [open, schedule, fetchSchedule]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (tzRef.current && !tzRef.current.contains(e.target as Node)) setTzOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const handlePreset = (label: string, presetCron: string) => {
    setSelectedPreset(label);
    if (label !== "Custom") setCron(presetCron);
  };

  const handleSave = async () => {
    if (!cron.trim()) { setError("Cron expression is required"); return; }
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const token = await getToken();
      const res = await fetch(`${import.meta.env.VITE_API_ENDPOINT}/admin/ingestion/schedule`, {
        method: "PUT",
        headers: { Authorization: token, "Content-Type": "application/json" },
        body: JSON.stringify({ cron: cron.trim(), timezone, enabled, force_full: forceFull }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Save failed");
      setSuccess(data.next_run_at
        ? `Saved! Next run: ${formatDateTime(data.next_run_at)}`
        : "Schedule saved.");
      await fetchSchedule();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    setError(null);
    setSuccess(null);
    try {
      const token = await getToken();
      const res = await fetch(`${import.meta.env.VITE_API_ENDPOINT}/admin/ingestion/schedule`, {
        method: "DELETE",
        headers: { Authorization: token },
      });
      if (!res.ok) { const d = await res.json(); throw new Error(d.error || "Delete failed"); }
      setSuccess("Schedule removed.");
      setSchedule({ exists: false });
      setCron("0 9 * * ? *");
      setSelectedPreset("Daily");
      setEnabled(true);
      setForceFull(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setDeleting(false);
    }
  };

  const filteredTz = tzSearch
    ? TIMEZONES.filter(tz => tz.toLowerCase().includes(tzSearch.toLowerCase()))
    : TIMEZONES;

  const cronPreview = describeCron(cron, timezone);

  return (
    <div className="rounded-xl border border-gray-200 shadow-sm overflow-hidden">
      {/* Trigger row */}
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between px-5 py-4 bg-white hover:bg-gray-50 transition-colors"
      >
        <div className="flex items-center gap-3">
          <div className={`p-2 rounded-lg ${schedule?.exists ? "bg-primary/10" : "bg-gray-100"}`}>
            <Clock className={`h-4 w-4 ${schedule?.exists ? "text-primary" : "text-gray-400"}`} />
          </div>
          <div className="text-left">
            <p className="text-sm font-semibold text-gray-900">Scheduled Run</p>
            <p className="text-xs text-gray-500 mt-0.5">
              {loading ? "Loading…" :
                schedule?.exists
                  ? (schedule.enabled
                      ? `Active — ${describeCron(schedule.cron ?? "", schedule.timezone ?? "UTC")}`
                      : "Paused — click to configure")
                  : "Not configured — click to set up"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {schedule?.exists && (
            <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
              schedule.enabled
                ? "bg-green-100 text-green-700"
                : "bg-gray-100 text-gray-500"
            }`}>
              {schedule.enabled ? "Active" : "Paused"}
            </span>
          )}
          {open
            ? <ChevronUp className="h-4 w-4 text-gray-400" />
            : <ChevronDown className="h-4 w-4 text-gray-400" />}
        </div>
      </button>

      {/* Expanded panel */}
      {open && (
        <div className="border-t border-gray-100 bg-gray-50/50 px-5 py-5 space-y-5">

          {/* Next run banner */}
          {schedule?.exists && schedule.next_run_at && (
            <div className="flex items-center gap-2 text-xs text-gray-600 bg-white border border-gray-200 rounded-lg px-3 py-2.5">
              <Calendar className="h-3.5 w-3.5 text-primary shrink-0" />
              <span>Next run: <span className="font-medium text-gray-900">{formatDateTime(schedule.next_run_at)}</span></span>
            </div>
          )}

          {/* Preset chips */}
          <div>
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">Frequency</p>
            <div className="flex flex-wrap gap-2">
              {PRESETS.map(p => (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => handlePreset(p.label, p.cron)}
                  className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-all ${
                    selectedPreset === p.label
                      ? "bg-primary text-white border-primary shadow-sm"
                      : "bg-white text-gray-600 border-gray-200 hover:border-primary/50 hover:text-primary"
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          {/* Cron expression */}
          <div>
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">
              Cron Expression
              <span className="ml-1 normal-case font-normal text-gray-400">(AWS format: min hr dom mon dow year)</span>
            </p>
            <input
              type="text"
              value={cron}
              onChange={e => { setCron(e.target.value); setSelectedPreset("Custom"); }}
              placeholder="0 9 * * ? *"
              className="w-full font-mono text-sm px-3 py-2 border border-gray-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-colors"
              spellCheck={false}
            />
            {cronPreview && (
              <p className="mt-1.5 text-xs text-primary/80 font-medium">{cronPreview}</p>
            )}
          </div>

          {/* Timezone dropdown */}
          <div>
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">Timezone</p>
            <div ref={tzRef} className="relative">
              <button
                type="button"
                onClick={() => setTzOpen(v => !v)}
                className="w-full flex items-center justify-between px-3 py-2 border border-gray-200 rounded-lg bg-white text-sm hover:border-primary/50 focus:outline-none focus:ring-2 focus:ring-primary/30 transition-colors"
              >
                <span className="font-medium text-gray-800">{timezone}</span>
                <ChevronDown className={`h-4 w-4 text-gray-400 transition-transform duration-200 ${tzOpen ? "rotate-180" : ""}`} />
              </button>

              {tzOpen && (
                <div className="absolute z-20 mt-1 w-full bg-white border border-gray-200 rounded-xl shadow-lg overflow-hidden">
                  <div className="p-2 border-b border-gray-100">
                    <input
                      type="text"
                      value={tzSearch}
                      onChange={e => setTzSearch(e.target.value)}
                      placeholder="Search timezones…"
                      className="w-full text-sm px-3 py-1.5 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
                      autoFocus
                    />
                  </div>
                  <div className="max-h-48 overflow-y-auto chat-scrollbar">
                    {filteredTz.length === 0 ? (
                      <p className="text-xs text-gray-400 text-center py-3">No results</p>
                    ) : filteredTz.map(tz => (
                      <button
                        key={tz}
                        type="button"
                        onClick={() => { setTimezone(tz); setTzOpen(false); setTzSearch(""); }}
                        className={`w-full text-left px-4 py-2 text-sm hover:bg-gray-50 transition-colors flex items-center justify-between ${
                          timezone === tz ? "text-primary font-medium bg-primary/5" : "text-gray-700"
                        }`}
                      >
                        {tz}
                        {timezone === tz && <CheckCircle2 className="h-3.5 w-3.5 text-primary shrink-0" />}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Toggle switches */}
          <div className="flex flex-col sm:flex-row gap-5">
            <label className="flex items-center gap-3 cursor-pointer select-none">
              <div
                role="switch"
                aria-checked={enabled}
                onClick={() => setEnabled(v => !v)}
                className={`relative w-10 h-5 rounded-full transition-colors cursor-pointer ${enabled ? "bg-primary" : "bg-gray-200"}`}
              >
                <div className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform duration-200 ${enabled ? "translate-x-5" : "translate-x-0"}`} />
              </div>
              <div>
                <p className="text-sm font-medium text-gray-700">Enabled</p>
                <p className="text-xs text-gray-400">Schedule will {enabled ? "" : "not "}fire automatically</p>
              </div>
            </label>

            <label className="flex items-center gap-3 cursor-pointer select-none">
              <div
                role="switch"
                aria-checked={forceFull}
                onClick={() => setForceFull(v => !v)}
                className={`relative w-10 h-5 rounded-full transition-colors cursor-pointer ${forceFull ? "bg-amber-500" : "bg-gray-200"}`}
              >
                <div className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform duration-200 ${forceFull ? "translate-x-5" : "translate-x-0"}`} />
              </div>
              <div>
                <p className="text-sm font-medium text-gray-700">Force full re-ingest</p>
                <p className="text-xs text-gray-400">Re-process all documents, ignore change detection</p>
              </div>
            </label>
          </div>

          {/* Feedback messages */}
          {error && (
            <div className="flex items-center gap-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              <XCircle className="h-4 w-4 shrink-0" />
              {error}
            </div>
          )}
          {success && (
            <div className="flex items-center gap-2 text-sm text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2">
              <CheckCircle2 className="h-4 w-4 shrink-0" />
              {success}
            </div>
          )}

          {/* Action buttons */}
          <div className="flex items-center justify-between pt-1 border-t border-gray-100">
            <div>
              {schedule?.exists && (
                <Button
                  variant="outline"
                  size="sm"
                  className="border-red-200 text-red-500 hover:bg-red-50 hover:text-red-600 hover:border-red-300"
                  onClick={handleDelete}
                  disabled={deleting || saving}
                >
                  {deleting
                    ? <><Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />Removing…</>
                    : <><Trash2 className="mr-1.5 h-3.5 w-3.5" />Remove schedule</>}
                </Button>
              )}
            </div>
            <Button
              size="sm"
              className="bg-primary text-white hover:bg-primary/90"
              onClick={handleSave}
              disabled={saving || deleting}
            >
              {saving
                ? <><Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />Saving…</>
                : <><Save className="mr-1.5 h-3.5 w-3.5" />Save schedule</>}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main panel ───────────────────────────────────────────────────────────────

export default function IngestionPanel() {
  const [runs, setRuns] = useState<IngestionRun[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loadingRuns, setLoadingRuns] = useState(true);
  const [triggering, setTriggering] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [forceFull, setForceFull] = useState(false);
  const [triggerError, setTriggerError] = useState<string | null>(null);

  const [viewingRunId, setViewingRunId] = useState<string | null>(null);
  const [logType, setLogType] = useState<"output" | "error">("output");
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const logBoxRef = useRef<HTMLDivElement>(null);
  const nextTokenRef = useRef<string | undefined>(undefined);
  const pollRunsRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollLogsRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const activeRun = runs[0] ?? null;
  const isInFlight = activeRun ? !TERMINAL.has(activeRun.status) : false;

  const getToken = () => AuthService.getIdToken();

  const fetchRuns = useCallback(async (pageIndex = page) => {
    try {
      const token = await getToken();
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(pageIndex * PAGE_SIZE) });
      const res = await fetch(`${import.meta.env.VITE_API_ENDPOINT}/admin/ingestion/runs?${params}`, {
        headers: { Authorization: token },
      });
      if (!res.ok) return;
      const data = await res.json();
      setRuns(data.runs ?? []);
      setTotal(data.total ?? 0);
    } catch {
      // silently ignore
    } finally {
      setLoadingRuns(false);
    }
  }, [page]);

  useEffect(() => {
    fetchRuns(page);
  }, [page]);

  const totalPages = Math.ceil(total / PAGE_SIZE);

  const handlePageChange = (newPage: number) => {
    setPage(newPage);
    setViewingRunId(null);
  };

  // Fast poll while a run is in-flight
  useEffect(() => {
    if (isInFlight) {
      pollRunsRef.current = setInterval(() => fetchRuns(0), 10_000);
    } else {
      if (pollRunsRef.current) clearInterval(pollRunsRef.current);
    }
    return () => {
      if (pollRunsRef.current) clearInterval(pollRunsRef.current);
    };
  }, [isInFlight, fetchRuns]);

  // Heartbeat — slow always-on poll to catch scheduler-triggered runs while page is open
  useEffect(() => {
    heartbeatRef.current = setInterval(() => {
      if (!isInFlight) fetchRuns(0);
    }, 60_000);
    return () => {
      if (heartbeatRef.current) clearInterval(heartbeatRef.current);
    };
  }, [isInFlight, fetchRuns]);

  const triggerJob = async () => {
    try {
      setTriggering(true);
      setTriggerError(null);
      const token = await getToken();
      const res = await fetch(`${import.meta.env.VITE_API_ENDPOINT}/admin/ingestion/trigger`, {
        method: "POST",
        headers: { Authorization: token, "Content-Type": "application/json" },
        body: JSON.stringify({ force_full: forceFull }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to trigger job");
      setPage(0);
      await fetchRuns(0);
    } catch (e) {
      setTriggerError(e instanceof Error ? e.message : "Failed to trigger job");
    } finally {
      setTriggering(false);
    }
  };

  const stopJob = async () => {
    try {
      setStopping(true);
      setTriggerError(null);
      const token = await getToken();
      const res = await fetch(`${import.meta.env.VITE_API_ENDPOINT}/admin/ingestion/stop`, {
        method: "POST",
        headers: { Authorization: token },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to stop job");
      await fetchRuns(0);
    } catch (e) {
      setTriggerError(e instanceof Error ? e.message : "Failed to stop job");
    } finally {
      setStopping(false);
    }
  };

  const fetchLogs = useCallback(async (glueRunId: string, type: "output" | "error", append = true) => {
    try {
      setLogsLoading(true);
      const token = await getToken();
      const params = new URLSearchParams({ jobRunId: glueRunId, logType: type });
      if (append && nextTokenRef.current) params.set("nextToken", nextTokenRef.current);

      const res = await fetch(`${import.meta.env.VITE_API_ENDPOINT}/admin/ingestion/logs?${params}`, {
        headers: { Authorization: token },
      });
      const data = await res.json();

      if (data.nextForwardToken) nextTokenRef.current = data.nextForwardToken;
      if (data.logLines?.length) {
        if (append) {
          setLogs((prev) => [...prev, ...data.logLines]);
        } else {
          setLogs(data.logLines);
        }
      }
    } catch {
      // silently ignore
    } finally {
      setLogsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (pollLogsRef.current) clearInterval(pollLogsRef.current);
    if (!viewingRunId) return;

    const run = runs.find((r) => r.id === viewingRunId);
    if (!run?.glue_run_id) return;

    setLogs([]);
    nextTokenRef.current = undefined;
    fetchLogs(run.glue_run_id, logType, false);

    if (!TERMINAL.has(run.status)) {
      pollLogsRef.current = setInterval(() => fetchLogs(run.glue_run_id!, logType, true), 5_000);
    }
    return () => {
      if (pollLogsRef.current) clearInterval(pollLogsRef.current);
    };
  }, [viewingRunId, logType, fetchLogs]);

  useEffect(() => {
    if (!viewingRunId) return;
    const run = runs.find((r) => r.id === viewingRunId);
    if (run && TERMINAL.has(run.status) && pollLogsRef.current) {
      clearInterval(pollLogsRef.current);
    }
  }, [runs, viewingRunId]);

  useEffect(() => {
    if (logBoxRef.current) logBoxRef.current.scrollTop = logBoxRef.current.scrollHeight;
  }, [logs]);

  const toggleLogs = (run: IngestionRun) => {
    if (viewingRunId === run.id) {
      setViewingRunId(null);
    } else {
      setViewingRunId(run.id);
      setLogType("output");
    }
  };

  return (
    <div className="space-y-4">
      {/* Header + controls */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <h3 className="text-2xl font-bold text-gray-900">SharePoint Ingestion</h3>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={forceFull}
              onChange={(e) => setForceFull(e.target.checked)}
              disabled={triggering || isInFlight}
              className="rounded border-gray-300"
            />
            Force full re-ingest
          </label>
          {(activeRun?.status === "running" || activeRun?.status === "stopping") && (
            <Button
              variant="outline"
              className="border-red-300 text-red-600 hover:bg-red-50 hover:text-red-700"
              onClick={stopJob}
              disabled={stopping || activeRun?.status === "stopping"}
            >
              {(stopping || activeRun?.status === "stopping") ? (
                <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Stopping...</>
              ) : (
                <><Square className="mr-2 h-4 w-4" />Stop</>
              )}
            </Button>
          )}
          <Button
            className="bg-primary text-white hover:bg-primary/90"
            onClick={triggerJob}
            disabled={triggering || isInFlight || loadingRuns}
          >
            {triggering ? (
              <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Starting...</>
            ) : (
              <><Play className="mr-2 h-4 w-4" />Run Ingestion</>
            )}
          </Button>
        </div>
      </div>

      {triggerError && (
        <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
          {triggerError}
        </div>
      )}

      {/* Runs table */}
      <Card className="border-gray-200 shadow-sm py-0">
        <CardContent className="p-0">
          {loadingRuns ? (
            <div className="flex items-center gap-2 text-sm text-gray-500 p-6">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading runs...
            </div>
          ) : runs.length === 0 ? (
            <p className="text-sm text-gray-500 p-6">No ingestion runs yet.</p>
          ) : (
            <Table>
              <TableHeader className="bg-gray-50">
                <TableRow>
                  <TableHead className="w-[4%]">#</TableHead>
                  <TableHead className="w-[12%]">Status</TableHead>
                  <TableHead className="w-[22%]">Started</TableHead>
                  <TableHead className="w-[10%]">Duration</TableHead>
                  <TableHead className="w-[35%]">Items Ingested</TableHead>
                  <TableHead className="w-[17%]">Logs</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.map((run, index) => {
                  const isViewing = viewingRunId === run.id;
                  const hasStats = run.status === "completed" || run.ingested_documents > 0 || run.failed_documents > 0;
                  return (
                    <React.Fragment key={run.id}>
                      <TableRow className={isViewing ? "bg-gray-50/50" : ""}>
                        <TableCell className="text-sm text-gray-500 font-medium">{index + 1}</TableCell>

                        <TableCell>
                          <Badge className={`${STATUS_BADGE[run.status] ?? "bg-gray-100 text-gray-700"} font-medium`}>
                            {run.status.charAt(0).toUpperCase() + run.status.slice(1)}
                            {(run.status === "running" || run.status === "stopping") && (
                              <RefreshCw className="ml-1.5 h-3 w-3 animate-spin inline" />
                            )}
                          </Badge>
                        </TableCell>

                        <TableCell className="text-sm text-gray-700">
                          {formatDateTime(run.started_at)}
                          {!!run.metadata?.force_full && (
                            <span className="ml-2 text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5">
                              full re-ingest
                            </span>
                          )}
                        </TableCell>

                        <TableCell className="text-sm text-gray-600">
                          {formatDuration(run.started_at, run.finished_at)}
                        </TableCell>

                        <TableCell className="text-sm">
                          {hasStats ? (
                            <div className="flex gap-3">
                              <span className="text-green-600">{run.ingested_documents} ingested</span>
                              {run.skipped_documents > 0 && (
                                <span className="text-gray-400">{run.skipped_documents} skipped</span>
                              )}
                              {run.failed_documents > 0 && (
                                <span className="text-red-500">{run.failed_documents} failed</span>
                              )}
                            </div>
                          ) : (
                            <span className="text-gray-400">—</span>
                          )}
                        </TableCell>

                        <TableCell>
                          {run.glue_run_id ? (
                            <button
                              type="button"
                              onClick={() => toggleLogs(run)}
                              className="text-xs text-primary hover:text-primary/80 flex items-center gap-1 font-medium"
                            >
                              {isViewing ? (
                                <><ChevronUp className="h-3.5 w-3.5" />Hide logs</>
                              ) : (
                                <><ChevronDown className="h-3.5 w-3.5" />View logs</>
                              )}
                            </button>
                          ) : (
                            <span className="text-xs text-gray-400">—</span>
                          )}
                        </TableCell>
                      </TableRow>

                      {isViewing && run.glue_run_id && (
                        <TableRow key={`${run.id}-logs`}>
                          <TableCell colSpan={6} className="p-0 border-t border-gray-100">
                            <div className="flex border-b border-gray-100 bg-gray-50">
                              {(["output", "error"] as const).map((t) => (
                                <button
                                  key={t}
                                  type="button"
                                  onClick={() => setLogType(t)}
                                  className={`px-4 py-2 text-xs font-medium border-b-2 transition-colors capitalize ${
                                    logType === t
                                      ? "border-primary text-primary bg-white"
                                      : "border-transparent text-gray-500 hover:text-gray-700"
                                  }`}
                                >
                                  {t} logs
                                </button>
                              ))}
                              {logsLoading && (
                                <div className="ml-auto flex items-center px-3 text-xs text-gray-400 gap-1">
                                  <Loader2 className="h-3 w-3 animate-spin" />
                                  loading
                                </div>
                              )}
                            </div>
                            <div
                              ref={logBoxRef}
                              className="h-72 overflow-y-auto chat-scrollbar p-4 font-mono text-xs leading-5"
                              style={{ backgroundColor: "rgb(23, 68, 103)", color: "rgb(245,245,245)" }}
                            >
                              {logs.length === 0 ? (
                                <span style={{ color: "rgba(245,245,245,0.4)" }}>
                                  {logsLoading ? "Fetching logs..." : "No logs available."}
                                </span>
                              ) : (
                                logs.map((line, i) => {
                                  const isError = line.message.includes("ERROR") || line.message.includes("Traceback");
                                  const isWarn = line.message.includes("WARNING");
                                  return (
                                    <div key={i} className="whitespace-pre-wrap break-all">
                                      <span style={{ color: "rgba(245,245,245,0.35)", marginRight: 8 }}>
                                        {new Date(line.timestamp).toLocaleTimeString()}
                                      </span>
                                      <span style={{
                                        color: isError ? "rgb(252,165,165)" : isWarn ? "rgb(253,224,71)" : "rgb(245,245,245)",
                                      }}>
                                        {line.message}
                                      </span>
                                    </div>
                                  );
                                })
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      )}
                    </React.Fragment>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm text-gray-500">
          <span>{total} total runs</span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => handlePageChange(page - 1)}
              disabled={page === 0}
              className="p-1 rounded hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span>Page {page + 1} of {totalPages}</span>
            <button
              onClick={() => handlePageChange(page + 1)}
              disabled={page >= totalPages - 1}
              className="p-1 rounded hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {/* Schedule panel — collapsible */}
      <SchedulePanel />
    </div>
  );
}
