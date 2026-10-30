"use client";

import { useEffect, useState } from "react";
import {
  Bell,
  Calendar,
  CheckCircle2,
  Clock,
  RefreshCw,
  X,
  XCircle,
} from "lucide-react";
import { backendUrl } from "@/lib/api";

export interface InAppNotification {
  id: string;
  userId: string;
  title: string;
  message: string;
  type: "booking" | "reschedule" | "cancellation" | "completion" | "reminder" | "system";
  read: boolean;
  appointmentId?: string | null;
  createdAt: string;
}

export function NotificationsBell() {
  const [open, setOpen] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [notifications, setNotifications] = useState<InAppNotification[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let active = true;
    async function loadCount() {
      try {
        const res = await fetch(`${backendUrl}/api/notifications/unread-count`, {
          credentials: "include",
          cache: "no-store",
        });
        if (!res.ok) return;
        const data: { count: number } = await res.json();
        if (active) setUnreadCount(data.count);
      } catch {
        // Safe fallback in dev/offline
      }
    }
    void loadCount();
    const interval = setInterval(() => {
      void loadCount();
    }, 15000); // 15s poll
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, []);

  async function handleToggleOpen() {
    const nextState = !open;
    setOpen(nextState);
    if (nextState) {
      setLoading(true);
      try {
        const res = await fetch(`${backendUrl}/api/notifications`, {
          credentials: "include",
          cache: "no-store",
        });
        if (res.ok) {
          const list: InAppNotification[] = await res.json();
          setNotifications(list);
        }
      } catch {
        // Fallback
      } finally {
        setLoading(false);
      }
    }
  }

  async function handleMarkRead(id: string) {
    try {
      await fetch(`${backendUrl}/api/notifications/${id}/read`, {
        method: "PATCH",
        credentials: "include",
      });
      setNotifications((prev) =>
        prev.map((n) => (n.id === id ? { ...n, read: true } : n))
      );
      setUnreadCount((c) => Math.max(0, c - 1));
    } catch {
      // Fallback
    }
  }

  async function handleMarkAllRead() {
    try {
      await fetch(`${backendUrl}/api/notifications/mark-all-read`, {
        method: "PATCH",
        credentials: "include",
      });
      setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
      setUnreadCount(0);
    } catch {
      // Fallback
    }
  }

  function getTypeIcon(type: InAppNotification["type"]) {
    switch (type) {
      case "booking":
        return <Calendar className="h-4 w-4 text-teal-600" />;
      case "reschedule":
        return <RefreshCw className="h-4 w-4 text-blue-600" />;
      case "cancellation":
        return <XCircle className="h-4 w-4 text-red-600" />;
      case "completion":
        return <CheckCircle2 className="h-4 w-4 text-emerald-600" />;
      default:
        return <Clock className="h-4 w-4 text-slate-500" />;
    }
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={handleToggleOpen}
        className="relative rounded-full p-2 text-slate-600 hover:bg-slate-100 hover:text-slate-900 transition focus:outline-none focus:ring-2 focus:ring-teal-600"
        aria-label="View notifications"
      >
        <Bell className="h-5 w-5" />
        {unreadCount > 0 && (
          <span className="absolute top-1 right-1 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-teal-600 px-1 text-[10px] font-bold text-white ring-2 ring-white">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <>
          <div
            className="fixed inset-0 z-40 bg-black/10"
            onClick={() => setOpen(false)}
          />
          <div className="absolute right-0 top-11 z-50 w-80 sm:w-96 rounded-2xl border border-slate-200 bg-white p-4 shadow-xl">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100">
              <div className="flex items-center gap-2">
                <h3 className="font-bold text-sm text-slate-900">Notifications</h3>
                {unreadCount > 0 && (
                  <span className="rounded-full bg-teal-100 px-2 py-0.5 text-[10px] font-semibold text-teal-800">
                    {unreadCount} unread
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {unreadCount > 0 && (
                  <button
                    type="button"
                    onClick={handleMarkAllRead}
                    className="text-[11px] font-medium text-teal-700 hover:underline"
                  >
                    Mark all read
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

            <div className="max-h-80 overflow-y-auto divide-y divide-slate-100 py-2">
              {loading && (
                <p className="py-6 text-center text-xs text-slate-500">
                  Loading notifications…
                </p>
              )}
              {!loading && notifications.length === 0 && (
                <div className="py-8 text-center text-xs text-slate-500 space-y-1">
                  <Bell className="h-6 w-6 text-slate-300 mx-auto" />
                  <p className="font-semibold text-slate-700">All caught up</p>
                  <p>You have no recent notifications.</p>
                </div>
              )}
              {!loading &&
                notifications.map((n) => (
                  <div
                    key={n.id}
                    onClick={() => !n.read && handleMarkRead(n.id)}
                    className={`flex items-start gap-3 p-2.5 rounded-xl transition cursor-pointer ${
                      n.read ? "bg-white hover:bg-slate-50" : "bg-teal-50/50 hover:bg-teal-50"
                    }`}
                  >
                    <div className="mt-0.5 shrink-0 rounded-lg bg-slate-100 p-1.5 border border-slate-200">
                      {getTypeIcon(n.type)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-1">
                        <p className={`text-xs truncate ${n.read ? "font-medium text-slate-800" : "font-bold text-slate-900"}`}>
                          {n.title}
                        </p>
                        <span className="text-[10px] text-slate-400 shrink-0">
                          {new Date(n.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                        </span>
                      </div>
                      <p className="text-[11px] text-slate-600 line-clamp-2 mt-0.5">
                        {n.message}
                      </p>
                    </div>
                  </div>
                ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
