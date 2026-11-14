"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from "react";

type Bounds = { left: number; top: number; width: number; height: number };
type Viewport = Pick<Bounds, "width" | "height">;
type Action = "move" | "resize";
type Gesture = { action: Action; pointerId: number; x: number; y: number; bounds: Bounds };

const desktopQuery = "(min-width: 768px) and (pointer: fine)";
const edge = 16;
const minWidth = 320;
const minHeight = 250;
const maxWidth = 720;
const maxHeight = 760;

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, Math.min(min, max)), max);
}

export function fitAssistantBounds(bounds: Bounds, viewport: Viewport): Bounds {
  const width = clamp(bounds.width, minWidth, Math.min(maxWidth, viewport.width - edge * 2));
  const height = clamp(bounds.height, minHeight, Math.min(maxHeight, Math.max(0, viewport.height - edge * 2)));
  return {
    width, height,
    left: clamp(bounds.left, edge, viewport.width - width - edge),
    top: clamp(bounds.top, edge, Math.max(0, viewport.height - height - edge)),
  };
}

export function updateAssistantBounds(bounds: Bounds, viewport: Viewport, action: Action, x: number, y: number): Bounds {
  if (action === "move") return fitAssistantBounds({ ...bounds, left: bounds.left + x, top: bounds.top + y }, viewport);

  // The top-left grip can grow the window when it starts in the bottom-right corner.
  const right = bounds.left + bounds.width;
  const bottom = bounds.top + bounds.height;
  const width = clamp(bounds.width - x, minWidth, Math.min(maxWidth, right - edge));
  const height = clamp(bounds.height - y, minHeight, Math.min(maxHeight, bottom - edge));
  return fitAssistantBounds({ width, height, left: right - width, top: bottom - height }, viewport);
}

function viewportSize(): Viewport {
  return { width: document.documentElement.clientWidth, height: window.innerHeight };
}

export function useAssistantWindow(open: boolean, panel: RefObject<HTMLElement | null>) {
  const gesture = useRef<Gesture | null>(null);
  const [desktop, setDesktop] = useState(false);
  const [bounds, setBounds] = useState<Bounds | null>(null);

  useEffect(() => {
    if (!open) return;
    const media = window.matchMedia(desktopQuery);
    function syncViewport() {
      gesture.current = null;
      setDesktop(media.matches);
      if (media.matches) {
        const viewport = viewportSize();
        setBounds((current) => current && fitAssistantBounds(current, viewport));
      }
    }
    syncViewport();
    window.addEventListener("resize", syncViewport);
    media.addEventListener("change", syncViewport);
    return () => {
      gesture.current = null;
      window.removeEventListener("resize", syncViewport);
      media.removeEventListener("change", syncViewport);
    };
  }, [open]);

  function start(event: PointerEvent<HTMLElement>, action: Action) {
    if (!desktop || event.button !== 0 || !event.isPrimary || gesture.current || !panel.current) return;
    if (action === "move" && event.target instanceof Element &&
        event.target.closest("button, a, input, select, textarea, [contenteditable], [role=button]")) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = {
      action, pointerId: event.pointerId, x: event.clientX, y: event.clientY,
      bounds: fitAssistantBounds(panel.current.getBoundingClientRect(), viewportSize()),
    };
  }

  function move(event: PointerEvent<HTMLElement>) {
    const current = gesture.current;
    if (current?.pointerId !== event.pointerId) return;
    const x = event.clientX - current.x;
    const y = event.clientY - current.y;
    if (x || y) setBounds(updateAssistantBounds(current.bounds, viewportSize(), current.action, x, y));
  }

  function finish(event: PointerEvent<HTMLElement>) {
    if (gesture.current?.pointerId === event.pointerId) gesture.current = null;
  }

  function keyboard(event: KeyboardEvent<HTMLElement>, action: Action) {
    if (!desktop || event.target !== event.currentTarget || !panel.current) return;
    const step = event.shiftKey ? 32 : 8;
    const x = event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
    const y = event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
    if (!x && !y) return;
    event.preventDefault();
    const viewport = viewportSize();
    const bounds = fitAssistantBounds(panel.current.getBoundingClientRect(), viewport);
    setBounds(updateAssistantBounds(bounds, viewport, action, x, y));
  }

  return {
    desktop, bounds: desktop ? bounds : null,
    move, finish, start, keyboard,
  };
}
