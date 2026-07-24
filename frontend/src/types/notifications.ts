export type NotificationType =
  | "export_completed"
  | "export_failed"
  | "ingestion_completed"
  | "ingestion_failed";

export interface Notification {
  id: string;
  user_id: string;
  type: NotificationType;
  title: string;
  message: string;
  metadata: Record<string, unknown>;
  created_at: string;
}
