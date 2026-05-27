import { useState, useEffect, useRef, useCallback } from "react";
import { Play, Loader2, RefreshCw, ChevronDown, ChevronUp } from "lucide-react";
import { AuthService } from "@/functions/authService";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type RunStatus =
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "stopped"
  | "stopping";

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

const STATUS_BADGE: Record<string, string> = {
  starting: "bg-amber-100 text-amber-700",
  running:  "bg-blue-100 text-blue-700",
  completed: "bg-green-100 text-green-700",
  failed:   "bg-red-100 text-red-700",
  stopped:  "bg-gray-100 text-gray-700",
  stopping: "bg-gray-100 text-gray-700",
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

export default function IngestionPanel() {
  const [runs, setRuns] = useState<IngestionRun[]>([]);
  const [loadingRuns, setLoadingRuns] = useState(true);
  const [triggering, setTriggering] = useState(false);
  const [forceFull, setForceFull] = useState(false);
  const [triggerError, setTriggerError] = useState<string | null>(null);

  // Log viewer state
  const [viewingRunId, setViewingRunId] = useState<string | null>(null);
  const [logType, setLogType] = useState<"output" | "error">("output");
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const logBoxRef = useRef<HTMLDivElement>(null);
  const nextTokenRef = useRef<string | undefined>(undefined);
  const pollRunsRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollLogsRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const activeRun = runs[0] ?? null;
  const isInFlight = activeRun ? !TERMINAL.has(activeRun.status) : false;

  const getToken = async () => {
    const session = await AuthService.getAuthSession(true);
    return session.tokens.idToken as string;
  };

  const fetchRuns = useCallback(async () => {
    try {
      const token = await getToken();
      const res = await fetch(`${import.meta.env.VITE_API_ENDPOINT}/admin/ingestion/runs`, {
        headers: { Authorization: token },
      });
      if (!res.ok) return;
      const data = await res.json();
      setRuns(data.runs ?? []);
    } catch {
      // silently ignore
    } finally {
      setLoadingRuns(false);
    }
  }, []);

  // Poll runs every 10s while any run is in-flight
  useEffect(() => {
    fetchRuns();
  }, [fetchRuns]);

  useEffect(() => {
    if (isInFlight) {
      pollRunsRef.current = setInterval(fetchRuns, 10_000);
    } else {
      if (pollRunsRef.current) clearInterval(pollRunsRef.current);
    }
    return () => {
      if (pollRunsRef.current) clearInterval(pollRunsRef.current);
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
      await fetchRuns();
    } catch (e) {
      setTriggerError(e instanceof Error ? e.message : "Failed to trigger job");
    } finally {
      setTriggering(false);
    }
  };

  // Fetch logs for a specific run
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

      if (data.logLines?.length) {
        if (append) {
          setLogs((prev) => [...prev, ...data.logLines]);
        } else {
          setLogs(data.logLines);
        }
        nextTokenRef.current = data.nextForwardToken;
      }
    } catch {
      // silently ignore
    } finally {
      setLogsLoading(false);
    }
  }, []);

  // Start/stop log polling when viewingRunId changes
  useEffect(() => {
    if (pollLogsRef.current) clearInterval(pollLogsRef.current);
    if (!viewingRunId) return;

    const run = runs.find((r) => r.id === viewingRunId);
    if (!run?.glue_run_id) return;

    // reset and fetch from scratch
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

  // Stop log polling when run finishes
  useEffect(() => {
    if (!viewingRunId) return;
    const run = runs.find((r) => r.id === viewingRunId);
    if (run && TERMINAL.has(run.status) && pollLogsRef.current) {
      clearInterval(pollLogsRef.current);
    }
  }, [runs, viewingRunId]);

  // Auto-scroll log box
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
    <Card className="border-gray-200 shadow-sm">
      <CardHeader className="pb-3 border-b border-gray-100 bg-gray-50/50">
        <CardTitle className="text-base font-semibold text-gray-900">
          SharePoint Ingestion
        </CardTitle>
      </CardHeader>
      <CardContent className="p-6 space-y-5">

        {/* Trigger controls */}
        <div className="flex flex-wrap items-center gap-3">
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

          {isInFlight && (
            <span className="flex items-center gap-1.5 text-sm text-blue-600">
              <RefreshCw className="h-3.5 w-3.5 animate-spin" />
              Job in progress — polling for updates
            </span>
          )}
        </div>

        {triggerError && (
          <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
            {triggerError}
          </div>
        )}

        {/* Run history */}
        {loadingRuns ? (
          <div className="flex items-center gap-2 text-sm text-gray-500">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading runs...
          </div>
        ) : runs.length === 0 ? (
          <p className="text-sm text-gray-500">No ingestion runs yet.</p>
        ) : (
          <div className="space-y-2">
            <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
              Recent Runs
            </div>
            <div className="rounded-lg border border-gray-200 overflow-hidden divide-y divide-gray-100">
              {runs.map((run) => {
                const isViewing = viewingRunId === run.id;
                const isActive = !TERMINAL.has(run.status);
                return (
                  <div key={run.id}>
                    {/* Run row */}
                    <div className="flex items-center gap-3 px-4 py-3 bg-white hover:bg-gray-50/50 transition-colors">
                      <Badge className={`${STATUS_BADGE[run.status] ?? "bg-gray-100 text-gray-700"} font-medium shrink-0`}>
                        {run.status}
                        {isActive && <RefreshCw className="ml-1.5 h-3 w-3 animate-spin inline" />}
                      </Badge>

                      <div className="flex-1 min-w-0 text-sm">
                        <span className="text-gray-700 font-medium">
                          {formatDateTime(run.started_at)}
                        </span>
                        {!!run.metadata?.force_full && (
                          <span className="ml-2 text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5">
                            full re-ingest
                          </span>
                        )}
                      </div>

                      <div className="text-xs text-gray-500 shrink-0 hidden sm:block">
                        {formatDuration(run.started_at, run.finished_at)}
                      </div>

                      {run.status === "completed" && (
                        <div className="text-xs text-gray-600 shrink-0 hidden md:flex gap-3">
                          <span className="text-green-600">{run.ingested_documents} ingested</span>
                          {run.skipped_documents > 0 && (
                            <span className="text-gray-400">{run.skipped_documents} skipped</span>
                          )}
                          {run.failed_documents > 0 && (
                            <span className="text-red-500">{run.failed_documents} failed</span>
                          )}
                        </div>
                      )}

                      {run.glue_run_id && (
                        <button
                          type="button"
                          onClick={() => toggleLogs(run)}
                          className="text-xs text-primary hover:text-primary/80 flex items-center gap-1 shrink-0 font-medium"
                        >
                          {isViewing ? (
                            <><ChevronUp className="h-3.5 w-3.5" />Hide logs</>
                          ) : (
                            <><ChevronDown className="h-3.5 w-3.5" />View logs</>
                          )}
                        </button>
                      )}
                    </div>

                    {/* Inline log viewer */}
                    {isViewing && run.glue_run_id && (
                      <div className="border-t border-gray-100">
                        {/* Log type tabs */}
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

                        {/* Terminal */}
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
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
