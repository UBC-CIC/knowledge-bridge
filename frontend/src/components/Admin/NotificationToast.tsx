import { X, Download, RefreshCw, AlertCircle } from "lucide-react";
import type { Notification, NotificationType } from "@/types/notifications";

const ICON_MAP: Record<NotificationType, typeof Download> = {
  export_completed: Download,
  export_failed: AlertCircle,
  ingestion_completed: RefreshCw,
  ingestion_failed: AlertCircle,
};

const COLOR_MAP: Record<NotificationType, string> = {
  export_completed: "text-green-600 bg-green-50 border-green-200",
  export_failed: "text-red-600 bg-red-50 border-red-200",
  ingestion_completed: "text-blue-600 bg-blue-50 border-blue-200",
  ingestion_failed: "text-red-600 bg-red-50 border-red-200",
};

type Props = {
  notification: Notification;
  onDismiss: () => void;
  onNavigateToExports: () => void;
  onDeleteNotification: (id: string) => void;
};

export default function NotificationToast({
  notification,
  onDismiss,
  onNavigateToExports,
  onDeleteNotification,
}: Props) {
  const Icon = ICON_MAP[notification.type];
  const colorClass = COLOR_MAP[notification.type];

  const handleClick = () => {
    if (notification.type === "export_completed") {
      onNavigateToExports();
      onDeleteNotification(notification.id);
    }
    onDismiss();
  };

  const handleDismiss = (e: React.MouseEvent) => {
    e.stopPropagation();
    onDismiss();
  };

  return (
    <div
      className={`fixed bottom-6 right-6 z-[100] flex items-start gap-3 rounded-xl border shadow-lg px-4 py-3 max-w-sm cursor-pointer animate-in slide-in-from-bottom-4 duration-300 ${colorClass}`}
      onClick={handleClick}
    >
      <div className="mt-0.5 shrink-0">
        <Icon className="h-4 w-4" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold leading-tight">{notification.title}</p>
        <p className="text-xs mt-0.5 opacity-80 leading-snug">{notification.message}</p>
      </div>
      <button
        onClick={handleDismiss}
        className="shrink-0 opacity-60 hover:opacity-100 transition-opacity mt-0.5"
        aria-label="Dismiss notification"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
