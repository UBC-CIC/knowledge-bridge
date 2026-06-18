import { useState, useEffect, useRef, useCallback } from "react";
import { AuthService } from "@/functions/authService";
import type { Notification } from "@/types/notifications";

const API = import.meta.env.VITE_API_ENDPOINT;
const WS_URL = import.meta.env.VITE_WEBSOCKET_URL;

export function useNotifications(role?: string | null) {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [total, setTotal] = useState(0);
  const [panelOpen, setPanelOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isAdmin = role === "admin";

  const fetchNotifications = useCallback(async () => {
    if (!isAdmin) return;
    try {
      const token = await AuthService.getIdToken();
      const res = await fetch(`${API}/admin/notifications`, {
        headers: { Authorization: token },
      });
      if (!res.ok) return;
      const data = await res.json();
      setNotifications(data.notifications ?? []);
      setTotal(data.total ?? 0);
    } catch { /* swallow transient errors */ }
  }, [isAdmin]);

  const connectWebSocket = useCallback(async () => {
    if (!isAdmin) return;
    if (wsRef.current?.readyState === WebSocket.OPEN) return;
    try {
      const token = await AuthService.getIdToken();
      const ws = new WebSocket(`${WS_URL}?token=${encodeURIComponent(token)}`);
      wsRef.current = ws;

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === "notification") {
            setNotifications((prev) => [msg.notification, ...prev]);
            setTotal((prev) => prev + 1);
          }
        } catch { /* ignore malformed frames */ }
      };

      ws.onclose = () => {
        if (isAdmin) reconnectRef.current = setTimeout(() => connectWebSocket(), 5000);
      };

      ws.onerror = () => ws.close();
    } catch { /* ignore connect errors — onclose will retry */ }
  }, [isAdmin]);

  useEffect(() => {
    if (!isAdmin) return;
    connectWebSocket();
    fetchNotifications();
    return () => {
      wsRef.current?.close();
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
    };
  }, []);

  const openPanel = useCallback(() => {
    setPanelOpen(true);
    if (wsRef.current?.readyState !== WebSocket.OPEN) {
      fetchNotifications();
    }
  }, [fetchNotifications]);

  const closePanel = useCallback(() => {
    setPanelOpen(false);
    setExpanded(false);
  }, []);

  const deleteNotification = useCallback(async (id: string) => {
    try {
      const token = await AuthService.getIdToken();
      await fetch(`${API}/admin/notifications/${id}`, {
        method: "DELETE",
        headers: { Authorization: token },
      });
      setNotifications((prev) => prev.filter((n) => n.id !== id));
      setTotal((prev) => Math.max(0, prev - 1));
    } catch { /* swallow */ }
  }, []);

  const clearAll = useCallback(async () => {
    try {
      const token = await AuthService.getIdToken();
      await fetch(`${API}/admin/notifications`, {
        method: "DELETE",
        headers: { Authorization: token },
      });
      setNotifications([]);
      setTotal(0);
    } catch { /* swallow */ }
  }, []);

  return {
    notifications,
    total,
    panelOpen,
    expanded,
    setExpanded,
    openPanel,
    closePanel,
    deleteNotification,
    clearAll,
  };
}
