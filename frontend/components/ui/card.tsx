import * as React from "react";
import { cn } from "@/lib/utils";

export function Card({ className, ...props }: React.ComponentProps<"div">) { return <div className={cn("rounded-2xl border border-slate-200 bg-white shadow-sm", className)} {...props} />; }
export function CardHeader({ className, ...props }: React.ComponentProps<"div">) { return <div className={cn("space-y-1.5 p-6", className)} {...props} />; }
export function CardTitle({ className, ...props }: React.ComponentProps<"h2">) { return <h2 className={cn("text-2xl font-semibold tracking-tight text-slate-900", className)} {...props} />; }
export function CardDescription({ className, ...props }: React.ComponentProps<"p">) { return <p className={cn("text-sm text-slate-600", className)} {...props} />; }
export function CardContent({ className, ...props }: React.ComponentProps<"div">) { return <div className={cn("p-6 pt-0", className)} {...props} />; }
