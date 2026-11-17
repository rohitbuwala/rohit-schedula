"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { createQueuePoller, readOwnAttendance } from "../lib/queue-api";
import type { Attendance } from "../lib/queue-response";

export function useQueueResource<T>(key: string, load: (signal: AbortSignal) => Promise<T>) {
  const [state, setState] = useState<{ key: string; data: T | null; error: string; updatedAt: number | null }>({ key: "", data: null, error: "", updatedAt: null });
  const poller = useRef<ReturnType<typeof createQueuePoller<T>> | null>(null);
  useEffect(() => {
    if (!key) return;
    const instance = createQueuePoller({ load, visibility: document,
      onData: data => setState({ key, data, error: "", updatedAt: Date.now() }),
      onError: error => setState(previous => ({ key, data: previous.key === key && !(error instanceof Error && "status" in error && [401, 403, 404].includes(Number(error.status))) ? previous.data : null,
        error: error instanceof Error ? error.message : "Could not refresh the queue.", updatedAt: previous.key === key ? previous.updatedAt : null })),
    });
    poller.current = instance;
    window.addEventListener("queue-updated", instance.refresh);
    return () => { instance.stop(); window.removeEventListener("queue-updated", instance.refresh); if (poller.current === instance) poller.current = null; };
  }, [key, load]);
  const refresh = useCallback(() => poller.current?.refresh(), []);
  const matches = state.key === key;
  return { data: matches ? state.data : null, error: matches ? state.error : "", loading: !!key && (!matches || !state.data && !state.error),
    updatedAt: matches ? state.updatedAt : null, refresh };
}
export function useOwnAttendance(ids: string[], enabled = true) {
  const key = enabled ? [...new Set(ids)].sort().join(",") : "";
  const load = useCallback((signal: AbortSignal) => readOwnAttendance(key ? key.split(",") : [], signal), [key]);
  const resource = useQueueResource(key, load);
  return { ...resource, data: resource.data ?? {} as Record<string, Attendance> };
}
