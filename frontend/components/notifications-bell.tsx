"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
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

interface NotificationsBellProps {
  isOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function NotificationsBell({
  isOpen: controlledOpen,
  onOpenChange,
}: NotificationsBellProps = {}) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = controlledOpen ?? uncontrolledOpen;
  const [renderInPortal, setRenderInPortal] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [notifications, setNotifications] = useState<InAppNotification[]>([]);
  const [loading, setLoading] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  const updateOpen = useCallback((nextOpen: boolean) => {
    if (controlledOpen === undefined) setUncontrolledOpen(nextOpen);
    onOpenChange?.(nextOpen);
  }, [controlledOpen, onOpenChange]);

  const closePopover = useCallback(() => {
    updateOpen(false);
    triggerRef.current?.focus({ preventScroll: true });
  }, [updateOpen]);

  useEffect(() => {
    if (!open) return;

    function handlePopoverKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        closePopover();
      }
    }

    document.addEventListener("keydown", handlePopoverKeyDown);
    return () => document.removeEventListener("keydown", handlePopoverKeyDown);
  }, [closePopover, open]);

  useEffect(() => {
    if (!open) return;

    const desktopBreakpoint = window.matchMedia("(min-width: 1024px)");
    const handleViewportChange = (event: MediaQueryListEvent) => {
      setRenderInPortal(!event.matches);
      updateOpen(false);
    };

    desktopBreakpoint.addEventListener("change", handleViewportChange);
    return () => desktopBreakpoint.removeEventListener("change", handleViewportChange);
  }, [open, updateOpen]);

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
    if (open) {
      closePopover();
      return;
    }

    setRenderInPortal(window.matchMedia("(max-width: 1023px)").matches);
    updateOpen(true);
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

  const notificationPanel = (className: string) => (
    <section
      id={`${panelId}-panel`}
      role="dialog"
      aria-labelledby={`${panelId}-title`}
      className={className}
    >
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-slate-100 pb-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h3 id={`${panelId}-title`} className="shrink-0 text-sm font-bold text-slate-900">
            Notifications
          </h3>
          {unreadCount > 0 && (
            <span className="whitespace-nowrap rounded-full bg-teal-100 px-2 py-0.5 text-[10px] font-semibold text-teal-800">
              {unreadCount} unread
            </span>
          )}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {unreadCount > 0 && (
            <button
              type="button"
              onClick={handleMarkAllRead}
              className="whitespace-nowrap text-[11px] font-medium text-teal-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600"
            >
              Mark all read
            </button>
          )}
          <button
            type="button"
            onClick={closePopover}
            aria-label="Close notifications"
            className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain divide-y divide-slate-100 py-2">
        {loading && (
          <p className="py-6 text-center text-xs text-slate-500">
            Loading notifications…
          </p>
        )}
        {!loading && notifications.length === 0 && (
          <div className="space-y-1 py-8 text-center text-xs text-slate-500">
            <Bell className="mx-auto h-6 w-6 text-slate-300" />
            <p className="font-semibold text-slate-700">All caught up</p>
            <p>You have no recent notifications.</p>
          </div>
        )}
        {!loading && notifications.map((notification) => (
          <button
            type="button"
            key={notification.id}
            onClick={() => !notification.read && handleMarkRead(notification.id)}
            disabled={notification.read}
            aria-label={notification.read
              ? `${notification.title}, already read`
              : `Mark notification as read: ${notification.title}`}
            className={`flex w-full items-start gap-3 rounded-xl p-2.5 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-teal-600 ${
              notification.read ? "bg-white hover:bg-slate-50" : "bg-teal-50/50 hover:bg-teal-50"
            }`}
          >
            <div className="mt-0.5 shrink-0 rounded-lg border border-slate-200 bg-slate-100 p-1.5">
              {getTypeIcon(notification.type)}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-1">
                <p className={`truncate text-xs ${notification.read ? "font-medium text-slate-800" : "font-bold text-slate-900"}`}>
                  {notification.title}
                </p>
                <span className="shrink-0 text-[10px] text-slate-400">
                  {new Date(notification.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                </span>
              </div>
              <p className="mt-0.5 line-clamp-2 text-[11px] text-slate-600">
                {notification.message}
              </p>
            </div>
          </button>
        ))}
      </div>
    </section>
  );

  const closeBackdrop = (className: string) => (
    <button
      type="button"
      aria-label="Close notifications"
      tabIndex={-1}
      className={className}
      onClick={closePopover}
    />
  );

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={handleToggleOpen}
        className="relative rounded-full p-2 text-slate-600 hover:bg-slate-100 hover:text-slate-900 transition focus:outline-none focus:ring-2 focus:ring-teal-600"
        aria-label="View notifications"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={`${panelId}-panel`}
      >
        <Bell className="h-5 w-5" />
        {unreadCount > 0 && (
          <span className="absolute top-1 right-1 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-teal-600 px-1 text-[10px] font-bold text-white ring-2 ring-white">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>

      {open && renderInPortal && createPortal(
        <>
          {closeBackdrop("fixed inset-0 z-[90] cursor-default bg-black/10")}
          <div
            className="pointer-events-none fixed inset-x-3 z-[100] flex justify-center"
            style={{ top: "calc(env(safe-area-inset-top) + 76px)" }}
          >
            {notificationPanel("pointer-events-auto flex max-h-[calc(100dvh_-_88px)] w-full max-w-[380px] flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white p-3 shadow-xl")}
          </div>
        </>,
        document.body
      )}
      {open && !renderInPortal && (
        <>
          {closeBackdrop("fixed inset-0 z-40 cursor-default bg-black/10")}
          {notificationPanel("absolute right-0 top-11 z-50 flex max-h-[calc(100dvh_-_2rem)] w-96 flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white p-4 shadow-xl")}
        </>
      )}
    </div>
  );
}
