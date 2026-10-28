import * as React from "react";
import { cn } from "@/lib/utils";

export const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(function Input({ className, ...props }, ref) {
  return <input ref={ref} className={cn("flex h-11 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none placeholder:text-slate-400 focus-visible:ring-2 focus-visible:ring-teal-600 disabled:opacity-50", className)} {...props} />;
});
