import { X, Download, RefreshCw, AlertCircle, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Notification, NotificationType } from "@/types/notifications";

const ICON_MAP: Record<NotificationType, typeof Download> = {
  export_completed: Download,
  export_failed: AlertCircle,
  ingestion_completed: RefreshCw,
  ingestion_failed: AlertCircle,
};

const COLOR_MAP: Record<NotificationType, string> = {
  export_completed: "text-green-600 bg-green-50",
  export_failed: "text-red-600 bg-red-50",
  ingestion_completed: "text-blue-600 bg-blue-50",
  ingestion_failed: "text-red-600 bg-red-50",
};

const COLLAPSED_COUNT = 5;

type Props = {
  notifications: Notification[];
  total: number;
  expanded: boolean;
  onSetExpanded: (v: boolean) => void;
  onClose: () => void;
  onClearAll: () => void;
  onDelete: (id: string) => void;
  onNavigateToExports: () => void;
};

export default function NotificationPanel({
  notifications,
  total,
  expanded,
  onSetExpanded,
  onClose,
  onClearAll,
  onDelete,
  onNavigateToExports,
}: Props) {
  const visible = expanded ? notifications : notifications.slice(0, COLLAPSED_COUNT);
  const hiddenCount = total - COLLAPSED_COUNT;

  const formatTime = (iso: string) =>
    new Date(iso).toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });

  const handleRowClick = (n: Notification) => {
    if (n.type === "export_completed") {
      onNavigateToExports();
      onClose();
    }
    onDelete(n.id);
  };

  return (
    <>
      {/* click-away overlay */}
      <div className="fixed inset-0 z-40" onClick={onClose} />

      <div className="absolute right-0 top-full mt-2 z-50 w-96 rounded-xl border border-gray-200 bg-white shadow-xl flex flex-col max-h-[480px]">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 flex-shrink-0">
          <span className="font-semibold text-gray-900 text-sm">Notifications</span>
          <div className="flex items-center gap-1">
            {notifications.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="text-xs text-gray-500 h-7 px-2"
                onClick={(e) => { e.stopPropagation(); onClearAll(); }}
              >
                Clear all
              </Button>
            )}
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onClose}>
              <X className="h-4 w-4 text-gray-500" />
            </Button>
          </div>
        </div>

        {/* Body */}
        <div className="overflow-y-auto flex-1">
          {notifications.length === 0 ? (
            <p className="py-12 text-center text-sm text-gray-400">No notifications yet.</p>
          ) : (
            <>
              {visible.map((n) => {
                const Icon = ICON_MAP[n.type];
                const colorClass = COLOR_MAP[n.type];
                return (
                  <div
                    key={n.id}
                    className="flex items-start gap-3 px-4 py-3 border-b border-gray-50 hover:bg-gray-50 transition-colors cursor-pointer group"
                    onClick={() => handleRowClick(n)}
                  >
                    <div className={`mt-0.5 flex-shrink-0 rounded-full p-1.5 ${colorClass}`}>
                      <Icon className="h-3.5 w-3.5" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-900">{n.title}</p>
                      <p className="text-xs text-gray-500 mt-0.5 leading-snug">{n.message}</p>
                      <p className="text-[10px] text-gray-400 mt-1">{formatTime(n.created_at)}</p>
                    </div>
                    <button
                      className="flex-shrink-0 text-gray-300 hover:text-gray-500 mt-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
                      onClick={(e) => { e.stopPropagation(); onDelete(n.id); }}
                      aria-label="Dismiss"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                );
              })}

              {/* Expand / collapse */}
              {!expanded && hiddenCount > 0 && (
                <button
                  className="w-full py-3 text-xs text-primary font-medium hover:bg-gray-50 transition-colors flex items-center justify-center gap-1"
                  onClick={(e) => { e.stopPropagation(); onSetExpanded(true); }}
                >
                  <ChevronDown className="h-3.5 w-3.5" />
                  +{hiddenCount} more
                </button>
              )}
              {expanded && notifications.length > COLLAPSED_COUNT && (
                <button
                  className="w-full py-3 text-xs text-gray-400 hover:bg-gray-50 transition-colors"
                  onClick={(e) => { e.stopPropagation(); onSetExpanded(false); }}
                >
                  Show less
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}
