"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  ArrowUpDown,
  CheckCircle2,
  Clock,
  CreditCard,
  DollarSign,
  FileText,
  Filter,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  X,
  XCircle,
} from "lucide-react";
import { backendUrl } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

export interface AdminPaymentItem {
  id: string;
  appointmentId: string;
  patientId: string;
  doctorId: string;
  razorpayOrderId: string;
  razorpayPaymentId: string | null;
  amountPaise: number;
  currency: string;
  status: "created" | "captured" | "failed" | "refunded";
  receipt: string | null;
  failureReason: string | null;
  refundedAmountPaise: number;
  createdAt: string;
  updatedAt: string;
  patientName: string | null;
  patientEmail: string | null;
}

export interface AdminRefundItem {
  id: string;
  paymentId: string;
  razorpayRefundId: string | null;
  amountPaise: number;
  currency: string;
  status: "pending" | "processed" | "failed";
  reason: string | null;
  arn: string | null;
  notes: string | null;
  failureReason: string | null;
  createdAt: string;
}

function formatInr(paise: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(paise / 100);
}

function formatDate(iso: string): string {
  try {
    return new Intl.DateTimeFormat("en-IN", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "Asia/Kolkata",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

export function AdminPaymentsRefunds() {
  const [activeTab, setActiveTab] = useState<"payments" | "refunds">("payments");
  const [payments, setPayments] = useState<AdminPaymentItem[]>([]);
  const [refunds, setRefunds] = useState<AdminRefundItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  // Filters
  const [searchQuery, setSearchQuery] = useState("");
  const [paymentStatusFilter, setPaymentStatusFilter] = useState<string>("all");
  const [refundStatusFilter, setRefundStatusFilter] = useState<string>("all");

  // Reconciliation state
  const [reconciling, setReconciling] = useState(false);

  // Refund Modal State
  const [selectedPaymentForRefund, setSelectedPaymentForRefund] = useState<AdminPaymentItem | null>(null);
  const [refundReason, setRefundReason] = useState("");
  const [refundAmountInr, setRefundAmountInr] = useState("");
  const [refundNotes, setRefundNotes] = useState("");
  const [refundSubmitting, setRefundSubmitting] = useState(false);
  const [refundModalError, setRefundModalError] = useState("");

  // Detail Modal State
  const [detailPayment, setDetailPayment] = useState<AdminPaymentItem | null>(null);

  const fetchLedgers = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [paymentsRes, refundsRes] = await Promise.all([
        fetch(`${backendUrl}/api/admin/payments?limit=100`, {
          credentials: "include",
          cache: "no-store",
        }),
        fetch(`${backendUrl}/api/admin/refunds?limit=100`, {
          credentials: "include",
          cache: "no-store",
        }),
      ]);

      if (!paymentsRes.ok || !refundsRes.ok) {
        if (paymentsRes.status === 401 || refundsRes.status === 401) {
          throw new Error("Admin session expired. Please sign in again.");
        }
        if (paymentsRes.status === 403 || refundsRes.status === 403) {
          throw new Error("Access denied. Admin privileges required.");
        }
        throw new Error("Failed to load payment and refund ledgers from server.");
      }

      const paymentsData = await paymentsRes.json();
      const refundsData = await refundsRes.json();

      setPayments(Array.isArray(paymentsData.payments) ? paymentsData.payments : []);
      setRefunds(Array.isArray(refundsData.refunds) ? refundsData.refunds : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error loading financial ledgers.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchLedgers();
  }, [fetchLedgers]);

  const handleReconcile = async () => {
    setReconciling(true);
    setError("");
    setNotice("");
    try {
      const res = await fetch(`${backendUrl}/api/admin/reconcile`, {
        method: "POST",
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || "Reconciliation failed.");
      }
      setNotice(data.message || `Reconciliation complete. ${data.reconciledCount ?? 0} item(s) updated.`);
      await fetchLedgers();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Reconciliation request failed.");
    } finally {
      setReconciling(false);
    }
  };

  const handleOpenRefundModal = (p: AdminPaymentItem) => {
    const remainingPaise = Math.max(0, p.amountPaise - (p.refundedAmountPaise || 0));
    setSelectedPaymentForRefund(p);
    setRefundReason("Administrative refund requested");
    setRefundAmountInr((remainingPaise / 100).toFixed(2));
    setRefundNotes("");
    setRefundModalError("");
  };

  const handleCloseRefundModal = () => {
    setSelectedPaymentForRefund(null);
    setRefundReason("");
    setRefundAmountInr("");
    setRefundNotes("");
    setRefundModalError("");
  };

  const handleSubmitRefund = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedPaymentForRefund) return;

    const remainingPaise = Math.max(
      0,
      selectedPaymentForRefund.amountPaise - (selectedPaymentForRefund.refundedAmountPaise || 0)
    );
    const amountInrNum = parseFloat(refundAmountInr);
    if (isNaN(amountInrNum) || amountInrNum <= 0) {
      setRefundModalError("Please provide a valid refund amount greater than 0.");
      return;
    }

    const requestedPaise = Math.round(amountInrNum * 100);
    if (requestedPaise > remainingPaise) {
      setRefundModalError(
        `Refund amount cannot exceed remaining unrefunded balance of ${formatInr(remainingPaise)}.`
      );
      return;
    }

    if (refundReason.trim().length < 3) {
      setRefundModalError("Reason must be at least 3 characters.");
      return;
    }

    setRefundSubmitting(true);
    setRefundModalError("");
    try {
      const res = await fetch(`${backendUrl}/api/admin/payments/${selectedPaymentForRefund.id}/refund`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          reason: refundReason.trim(),
          amountPaise: requestedPaise,
          notes: refundNotes.trim() || undefined,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || "Failed to issue refund.");
      }

      setNotice(
        `Refund of ${formatInr(requestedPaise)} initiated successfully (Status: ${data.status || "pending"}).`
      );
      handleCloseRefundModal();
      await fetchLedgers();
    } catch (err) {
      setRefundModalError(err instanceof Error ? err.message : "Error executing refund.");
    } finally {
      setRefundSubmitting(false);
    }
  };

  // Metrics
  const metrics = useMemo(() => {
    let capturedPaise = 0;
    let refundedPaise = 0;
    let capturedCount = 0;
    let pendingRefundCount = 0;

    for (const p of payments) {
      if (p.status === "captured" || p.status === "refunded") {
        capturedPaise += p.amountPaise;
        capturedCount += 1;
      }
      refundedPaise += p.refundedAmountPaise || 0;
    }

    for (const r of refunds) {
      if (r.status === "pending") {
        pendingRefundCount += 1;
      }
    }

    return {
      capturedPaise,
      refundedPaise,
      capturedCount,
      pendingRefundCount,
      netSettledPaise: Math.max(0, capturedPaise - refundedPaise),
    };
  }, [payments, refunds]);

  // Filtered Payments
  const filteredPayments = useMemo(() => {
    return payments.filter((p) => {
      if (paymentStatusFilter !== "all" && p.status !== paymentStatusFilter) {
        return false;
      }
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase().trim();
        const matchName = p.patientName?.toLowerCase().includes(q) ?? false;
        const matchEmail = p.patientEmail?.toLowerCase().includes(q) ?? false;
        const matchPayId = p.razorpayPaymentId?.toLowerCase().includes(q) ?? false;
        const matchOrderId = p.razorpayOrderId?.toLowerCase().includes(q) ?? false;
        const matchReceipt = p.receipt?.toLowerCase().includes(q) ?? false;
        if (!matchName && !matchEmail && !matchPayId && !matchOrderId && !matchReceipt) {
          return false;
        }
      }
      return true;
    });
  }, [payments, paymentStatusFilter, searchQuery]);

  // Filtered Refunds
  const filteredRefunds = useMemo(() => {
    return refunds.filter((r) => {
      if (refundStatusFilter !== "all" && r.status !== refundStatusFilter) {
        return false;
      }
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase().trim();
        const matchRefundId = r.razorpayRefundId?.toLowerCase().includes(q) ?? false;
        const matchPaymentId = r.paymentId?.toLowerCase().includes(q) ?? false;
        const matchArn = r.arn?.toLowerCase().includes(q) ?? false;
        const matchReason = r.reason?.toLowerCase().includes(q) ?? false;
        if (!matchRefundId && !matchPaymentId && !matchArn && !matchReason) {
          return false;
        }
      }
      return true;
    });
  }, [refunds, refundStatusFilter, searchQuery]);

  return (
    <div className="space-y-6">
      {/* Header and Reconcile Button */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">
            Payments & Refunds Ledger
          </h1>
          <p className="text-xs sm:text-sm text-slate-500 mt-1">
            Authoritative financial settlement audit, Razorpay gateway status, and administrative refund controls.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={fetchLedgers}
            disabled={loading || reconciling}
            className="text-xs h-9"
          >
            <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={handleReconcile}
            disabled={loading || reconciling}
            className="text-xs h-9 bg-teal-700 hover:bg-teal-800 text-white"
          >
            <RotateCcw className={`h-3.5 w-3.5 mr-1.5 ${reconciling ? "animate-spin" : ""}`} />
            {reconciling ? "Reconciling..." : "Run Reconciliation"}
          </Button>
        </div>
      </div>

      {/* Notifications */}
      {notice && (
        <div
          role="status"
          className="flex items-center justify-between rounded-xl bg-emerald-50 p-3.5 text-xs font-medium text-emerald-800 border border-emerald-200"
        >
          <div className="flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" />
            <span>{notice}</span>
          </div>
          <button
            type="button"
            onClick={() => setNotice("")}
            className="text-emerald-700 hover:text-emerald-900"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="flex items-center justify-between rounded-xl bg-red-50 p-3.5 text-xs font-medium text-red-700 border border-red-200"
        >
          <div className="flex items-center gap-2">
            <AlertCircle className="h-4 w-4 text-red-600 shrink-0" />
            <span>{error}</span>
          </div>
          <button
            type="button"
            onClick={() => setError("")}
            className="text-red-700 hover:text-red-900"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Financial Metrics Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="rounded-2xl border-slate-200 shadow-xs">
          <CardHeader className="p-4 pb-2">
            <CardDescription className="text-xs font-semibold uppercase tracking-wider text-slate-500">
              Gross Collected
            </CardDescription>
            <CardTitle className="text-xl font-extrabold text-slate-900">
              {formatInr(metrics.capturedPaise)}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0">
            <p className="text-[11px] text-slate-500">
              {metrics.capturedCount} completed consultations
            </p>
          </CardContent>
        </Card>

        <Card className="rounded-2xl border-slate-200 shadow-xs">
          <CardHeader className="p-4 pb-2">
            <CardDescription className="text-xs font-semibold uppercase tracking-wider text-slate-500">
              Total Refunded
            </CardDescription>
            <CardTitle className="text-xl font-extrabold text-rose-700">
              {formatInr(metrics.refundedPaise)}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0">
            <p className="text-[11px] text-slate-500">
              Settled cancellations & chargebacks
            </p>
          </CardContent>
        </Card>

        <Card className="rounded-2xl border-slate-200 shadow-xs">
          <CardHeader className="p-4 pb-2">
            <CardDescription className="text-xs font-semibold uppercase tracking-wider text-slate-500">
              Net Platform Revenue
            </CardDescription>
            <CardTitle className="text-xl font-extrabold text-teal-800">
              {formatInr(metrics.netSettledPaise)}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0">
            <p className="text-[11px] text-slate-500">
              Gross collected minus refunds
            </p>
          </CardContent>
        </Card>

        <Card className="rounded-2xl border-slate-200 shadow-xs">
          <CardHeader className="p-4 pb-2">
            <CardDescription className="text-xs font-semibold uppercase tracking-wider text-slate-500">
              Pending Refunds
            </CardDescription>
            <CardTitle className="text-xl font-extrabold text-purple-700">
              {metrics.pendingRefundCount}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0">
            <p className="text-[11px] text-slate-500">
              In-flight external Razorpay refunds
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Main Ledger Table Card */}
      <Card className="rounded-2xl border-slate-200 shadow-xs">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between border-b border-slate-200 px-6 py-4 gap-4">
          {/* Sub-tabs */}
          <div className="flex items-center rounded-xl bg-slate-100 p-1">
            <button
              type="button"
              onClick={() => setActiveTab("payments")}
              className={`rounded-lg px-3.5 py-1.5 text-xs font-semibold transition ${
                activeTab === "payments"
                  ? "bg-white text-slate-900 shadow-xs"
                  : "text-slate-600 hover:text-slate-900"
              }`}
            >
              Payments ({payments.length})
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("refunds")}
              className={`rounded-lg px-3.5 py-1.5 text-xs font-semibold transition ${
                activeTab === "refunds"
                  ? "bg-white text-slate-900 shadow-xs"
                  : "text-slate-600 hover:text-slate-900"
              }`}
            >
              Refunds ({refunds.length})
            </button>
          </div>

          {/* Search & Filter */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative w-full sm:w-64">
              <Search className="absolute left-3 top-2.5 h-3.5 w-3.5 text-slate-400" />
              <Input
                type="text"
                placeholder={
                  activeTab === "payments"
                    ? "Search name, pay_id, order..."
                    : "Search refund_id, ARN, pay..."
                }
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9 text-xs h-8"
              />
            </div>

            {activeTab === "payments" ? (
              <select
                value={paymentStatusFilter}
                onChange={(e) => setPaymentStatusFilter(e.target.value)}
                className="h-8 rounded-lg border border-slate-200 bg-white px-2.5 text-xs text-slate-700 focus:outline-none focus:ring-1 focus:ring-teal-500"
              >
                <option value="all">All Statuses</option>
                <option value="captured">Captured (Paid)</option>
                <option value="created">Created (Pending)</option>
                <option value="refunded">Refunded</option>
                <option value="failed">Failed</option>
              </select>
            ) : (
              <select
                value={refundStatusFilter}
                onChange={(e) => setRefundStatusFilter(e.target.value)}
                className="h-8 rounded-lg border border-slate-200 bg-white px-2.5 text-xs text-slate-700 focus:outline-none focus:ring-1 focus:ring-teal-500"
              >
                <option value="all">All Statuses</option>
                <option value="processed">Processed</option>
                <option value="pending">Pending</option>
                <option value="failed">Failed</option>
              </select>
            )}
          </div>
        </div>

        {/* Table Content */}
        <div className="overflow-x-auto">
          {loading ? (
            <div className="py-16 text-center text-xs text-slate-500">
              <RefreshCw className="h-6 w-6 text-teal-700 animate-spin mx-auto mb-2" />
              Retrieving financial records from server...
            </div>
          ) : activeTab === "payments" ? (
            filteredPayments.length === 0 ? (
              <div className="py-16 text-center text-xs text-slate-500">
                <FileText className="h-8 w-8 text-slate-300 mx-auto mb-2" />
                No payment transactions found matching the selected filter.
              </div>
            ) : (
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-[11px] font-semibold text-slate-600 uppercase tracking-wider">
                    <th className="py-3 px-4">Date & Time</th>
                    <th className="py-3 px-4">Patient</th>
                    <th className="py-3 px-4">Amount</th>
                    <th className="py-3 px-4">Status</th>
                    <th className="py-3 px-4">Gateway IDs</th>
                    <th className="py-3 px-4">Refunded</th>
                    <th className="py-3 px-4 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredPayments.map((p) => {
                    const remainingPaise = Math.max(0, p.amountPaise - (p.refundedAmountPaise || 0));
                    const canRefund = p.status === "captured" && remainingPaise > 0;

                    return (
                      <tr key={p.id} className="hover:bg-slate-50/80 transition">
                        <td className="py-3.5 px-4 whitespace-nowrap text-slate-600">
                          {formatDate(p.createdAt)}
                        </td>
                        <td className="py-3.5 px-4 whitespace-nowrap">
                          <p className="font-semibold text-slate-900">{p.patientName || "Anonymous"}</p>
                          <p className="text-[11px] text-slate-500">{p.patientEmail || "No email"}</p>
                        </td>
                        <td className="py-3.5 px-4 whitespace-nowrap font-bold text-slate-900">
                          {formatInr(p.amountPaise)}
                        </td>
                        <td className="py-3.5 px-4 whitespace-nowrap">
                          {p.status === "captured" && (
                            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-800 border border-emerald-300">
                              <CheckCircle2 className="h-3 w-3 text-emerald-600" />
                              Captured
                            </span>
                          )}
                          {p.status === "created" && (
                            <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-800 border border-amber-300">
                              <Clock className="h-3 w-3 text-amber-600" />
                              Created (Pending)
                            </span>
                          )}
                          {p.status === "refunded" && (
                            <span className="inline-flex items-center gap-1 rounded-full bg-sky-50 px-2 py-0.5 text-[11px] font-semibold text-sky-800 border border-sky-300">
                              <RotateCcw className="h-3 w-3 text-sky-600" />
                              Refunded
                            </span>
                          )}
                          {p.status === "failed" && (
                            <span className="inline-flex items-center gap-1 rounded-full bg-rose-50 px-2 py-0.5 text-[11px] font-semibold text-rose-800 border border-rose-300">
                              <XCircle className="h-3 w-3 text-rose-600" />
                              Failed
                            </span>
                          )}
                        </td>
                        <td className="py-3.5 px-4 whitespace-nowrap">
                          {p.razorpayPaymentId ? (
                            <p className="font-mono text-[11px] text-slate-800">
                              {p.razorpayPaymentId}
                            </p>
                          ) : (
                            <span className="text-slate-400 italic">None</span>
                          )}
                          <p className="font-mono text-[10px] text-slate-400">{p.razorpayOrderId}</p>
                        </td>
                        <td className="py-3.5 px-4 whitespace-nowrap">
                          {p.refundedAmountPaise > 0 ? (
                            <span className="font-semibold text-rose-700">
                              {formatInr(p.refundedAmountPaise)}
                            </span>
                          ) : (
                            <span className="text-slate-400">—</span>
                          )}
                        </td>
                        <td className="py-3.5 px-4 whitespace-nowrap text-right">
                          <div className="flex items-center justify-end gap-1.5">
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="h-7 text-[11px] px-2.5"
                              onClick={() => setDetailPayment(p)}
                            >
                              Details
                            </Button>
                            {canRefund && (
                              <Button
                                type="button"
                                size="sm"
                                className="h-7 text-[11px] px-2.5 bg-rose-600 hover:bg-rose-700 text-white"
                                onClick={() => handleOpenRefundModal(p)}
                              >
                                Refund
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )
          ) : (
            filteredRefunds.length === 0 ? (
              <div className="py-16 text-center text-xs text-slate-500">
                <RotateCcw className="h-8 w-8 text-slate-300 mx-auto mb-2" />
                No refund records found matching the selected filter.
              </div>
            ) : (
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-[11px] font-semibold text-slate-600 uppercase tracking-wider">
                    <th className="py-3 px-4">Refund Date</th>
                    <th className="py-3 px-4">Amount</th>
                    <th className="py-3 px-4">Status</th>
                    <th className="py-3 px-4">Gateway Refund ID</th>
                    <th className="py-3 px-4">Bank ARN</th>
                    <th className="py-3 px-4">Reason / Notes</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredRefunds.map((r) => (
                    <tr key={r.id} className="hover:bg-slate-50/80 transition">
                      <td className="py-3.5 px-4 whitespace-nowrap text-slate-600">
                        {formatDate(r.createdAt)}
                      </td>
                      <td className="py-3.5 px-4 whitespace-nowrap font-bold text-slate-900">
                        {formatInr(r.amountPaise)}
                      </td>
                      <td className="py-3.5 px-4 whitespace-nowrap">
                        {r.status === "processed" && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-800 border border-emerald-300">
                            <CheckCircle2 className="h-3 w-3 text-emerald-600" />
                            Processed
                          </span>
                        )}
                        {r.status === "pending" && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-purple-50 px-2 py-0.5 text-[11px] font-semibold text-purple-800 border border-purple-300">
                            <Clock className="h-3 w-3 text-purple-600 animate-spin" />
                            Pending Gateway
                          </span>
                        )}
                        {r.status === "failed" && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-rose-50 px-2 py-0.5 text-[11px] font-semibold text-rose-800 border border-rose-300">
                            <XCircle className="h-3 w-3 text-rose-600" />
                            Failed
                          </span>
                        )}
                      </td>
                      <td className="py-3.5 px-4 whitespace-nowrap font-mono text-[11px] text-slate-800">
                        {r.razorpayRefundId || <span className="text-slate-400 italic">None</span>}
                      </td>
                      <td className="py-3.5 px-4 whitespace-nowrap font-mono text-[11px]">
                        {r.arn ? (
                          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-700">
                            {r.arn}
                          </span>
                        ) : (
                          <span className="text-slate-400 italic">Awaiting ARN</span>
                        )}
                      </td>
                      <td className="py-3.5 px-4 max-w-xs truncate text-slate-600">
                        <p className="truncate font-medium">{r.reason || "No reason given"}</p>
                        {r.notes && <p className="text-[10px] text-slate-400 truncate">{r.notes}</p>}
                        {r.failureReason && (
                          <p className="text-[10px] text-rose-600 truncate">{r.failureReason}</p>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          )}
        </div>
      </Card>

      {/* Issue Refund Modal */}
      {selectedPaymentForRefund && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl space-y-4">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <h3 className="text-base font-bold text-slate-900">
                Execute Administrative Refund
              </h3>
              <button
                type="button"
                onClick={handleCloseRefundModal}
                className="text-slate-400 hover:text-slate-600"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="rounded-xl bg-slate-50 p-3.5 text-xs space-y-1.5 text-slate-700">
              <div className="flex justify-between">
                <span className="text-slate-500">Patient:</span>
                <span className="font-semibold">{selectedPaymentForRefund.patientName || "Anonymous"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Original Amount:</span>
                <span className="font-semibold">{formatInr(selectedPaymentForRefund.amountPaise)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Already Refunded:</span>
                <span className="font-semibold text-rose-700">
                  {formatInr(selectedPaymentForRefund.refundedAmountPaise || 0)}
                </span>
              </div>
              <div className="flex justify-between border-t border-slate-200 pt-1.5 font-bold">
                <span>Maximum Refund Available:</span>
                <span className="text-teal-800">
                  {formatInr(
                    Math.max(
                      0,
                      selectedPaymentForRefund.amountPaise - (selectedPaymentForRefund.refundedAmountPaise || 0)
                    )
                  )}
                </span>
              </div>
            </div>

            {refundModalError && (
              <div className="rounded-xl bg-red-50 p-3 text-xs font-medium text-red-700 border border-red-200">
                {refundModalError}
              </div>
            )}

            <form onSubmit={handleSubmitRefund} className="space-y-3.5">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Refund Amount (₹ INR)
                </label>
                <Input
                  type="number"
                  step="0.01"
                  min="1"
                  value={refundAmountInr}
                  onChange={(e) => setRefundAmountInr(e.target.value)}
                  required
                  className="text-xs h-9"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Reason for Refund
                </label>
                <Input
                  type="text"
                  placeholder="e.g. Doctor cancelled, Patient medical emergency..."
                  value={refundReason}
                  onChange={(e) => setRefundReason(e.target.value)}
                  required
                  minLength={3}
                  className="text-xs h-9"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Internal Notes (Optional)
                </label>
                <Input
                  type="text"
                  placeholder="Audit reference, ticket ID, or note..."
                  value={refundNotes}
                  onChange={(e) => setRefundNotes(e.target.value)}
                  maxLength={500}
                  className="text-xs h-9"
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleCloseRefundModal}
                  disabled={refundSubmitting}
                  className="text-xs h-8"
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  size="sm"
                  disabled={refundSubmitting}
                  className="text-xs h-8 bg-rose-600 hover:bg-rose-700 text-white"
                >
                  {refundSubmitting ? "Processing..." : "Confirm & Issue Refund"}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Payment Details Drawer/Modal */}
      {detailPayment && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-xl space-y-4">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <h3 className="text-base font-bold text-slate-900">
                Payment Audit Record
              </h3>
              <button
                type="button"
                onClick={() => setDetailPayment(null)}
                className="text-slate-400 hover:text-slate-600"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <dl className="grid grid-cols-2 gap-3 text-xs">
              <div className="col-span-2">
                <dt className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                  Payment Record ID
                </dt>
                <dd className="font-mono text-slate-900 select-all">{detailPayment.id}</dd>
              </div>

              <div>
                <dt className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                  Patient Name
                </dt>
                <dd className="font-medium text-slate-800">{detailPayment.patientName || "Anonymous"}</dd>
              </div>

              <div>
                <dt className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                  Patient Email
                </dt>
                <dd className="font-medium text-slate-800">{detailPayment.patientEmail || "N/A"}</dd>
              </div>

              <div>
                <dt className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                  Amount
                </dt>
                <dd className="font-bold text-slate-900">{formatInr(detailPayment.amountPaise)}</dd>
              </div>

              <div>
                <dt className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                  Status
                </dt>
                <dd className="font-semibold text-slate-800 uppercase">{detailPayment.status}</dd>
              </div>

              <div>
                <dt className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                  Razorpay Order ID
                </dt>
                <dd className="font-mono text-slate-900 select-all">{detailPayment.razorpayOrderId}</dd>
              </div>

              <div>
                <dt className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                  Razorpay Payment ID
                </dt>
                <dd className="font-mono text-slate-900 select-all">
                  {detailPayment.razorpayPaymentId || "None"}
                </dd>
              </div>

              <div>
                <dt className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                  Appointment ID
                </dt>
                <dd className="font-mono text-slate-900 select-all">{detailPayment.appointmentId}</dd>
              </div>

              <div>
                <dt className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                  Receipt Number
                </dt>
                <dd className="font-mono text-slate-900">{detailPayment.receipt || "None"}</dd>
              </div>

              {detailPayment.failureReason && (
                <div className="col-span-2 rounded-xl bg-red-50 p-2.5 border border-red-200">
                  <dt className="text-[10px] font-bold uppercase tracking-wider text-red-700">
                    Failure Reason
                  </dt>
                  <dd className="text-xs text-red-800 mt-0.5">{detailPayment.failureReason}</dd>
                </div>
              )}
            </dl>

            <div className="flex justify-end pt-3 border-t border-slate-100">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setDetailPayment(null)}
                className="text-xs h-8"
              >
                Close
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
