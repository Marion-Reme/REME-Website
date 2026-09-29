import Link from "next/link";
import { Archive, CheckCircle2, ClipboardList, Plus, Search, XCircle } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Card } from "@/components/ui/card";
import type { WorkOrderStatus } from "@/lib/domain";
import { createClient } from "@/lib/supabase/server";
import { cn, formatDate, formatMoney } from "@/lib/utils";

type WorkOrderRow = {
  id: number;
  work_order_number: string;
  client_reference: string | null;
  status: WorkOrderStatus;
  completion_due_date: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  lead_worker_id: number | null;
  client: { name: string } | null;
  site: { suburb: string } | null;
  task: Array<{
    id: number;
    status: string;
    assignment: Array<{ worker_id: number; status: string }>;
  }>;
  work_order_totals: { total_cents: number } | null;
};

// Completed orders are archived out of the day-to-day list rather than deleted.
const VIEWS = {
  active: { label: "Active", icon: ClipboardList },
  completed: { label: "Completed", icon: Archive },
  cancelled: { label: "Cancelled", icon: XCircle },
} as const;
type View = keyof typeof VIEWS;
const ACTIVE_STATUSES = [
  "ready",
  "assigned",
  "scheduled",
  "in_progress",
  "changes_requested",
  "blocked",
] as const;

export const metadata = { title: "Work orders" };

export default async function WorkOrdersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  const view: View =
    params.view === "completed" || params.view === "cancelled" ? params.view : "active";
  const query = params.q?.trim() ?? "";
  const status =
    view === "active" && ACTIVE_STATUSES.includes(params.status as (typeof ACTIVE_STATUSES)[number])
      ? (params.status as string)
      : "";
  const search = query.replace(/[%_,()]/g, "");
  const supabase = await createClient();

  // Each tab narrows by status; search applies across all three so the counts
  // show where a matching order lives.
  const scoped = <T extends { or: (filter: string) => T }>(request: T) =>
    search
      ? request.or(`work_order_number.ilike.%${search}%,client_reference.ilike.%${search}%`)
      : request;
  const countFor = (target: View) => {
    const request = scoped(
      supabase.from("work_order").select("id", { count: "exact", head: true }),
    );
    if (target === "completed") return request.in("status", ["signed_off", "completed"]);
    if (target === "cancelled") return request.eq("status", "cancelled");
    return request.not("status", "in", "(signed_off,completed,cancelled)");
  };

  let request = scoped(
    supabase
      .from("work_order")
      .select(
        "id,work_order_number,client_reference,status,completion_due_date,completed_at,cancelled_at,lead_worker_id,client:client_id(name),site:site_id(suburb),task(id,status,assignment(worker_id,status)),work_order_totals(total_cents)",
      ),
  );
  if (view === "completed")
    request = request
      .in("status", ["signed_off", "completed"])
      .order("completed_at", { ascending: false, nullsFirst: false });
  else if (view === "cancelled")
    request = request
      .eq("status", "cancelled")
      .order("cancelled_at", { ascending: false, nullsFirst: false });
  else {
    request = request.not("status", "in", "(signed_off,completed,cancelled)");
    if (status) request = request.eq("status", status);
    request = request.order("created_at", { ascending: false });
  }

  const [{ data, error }, activeCount, completedCount, cancelledCount, { data: workerData }] =
    await Promise.all([
      request,
      countFor("active"),
      countFor("completed"),
      countFor("cancelled"),
      supabase.from("worker").select("id,user_profile:user_id(display_name)"),
    ]);
  const counts: Record<View, number> = {
    active: activeCount.count ?? 0,
    completed: completedCount.count ?? 0,
    cancelled: cancelledCount.count ?? 0,
  };
  const rows = (data ?? []) as unknown as WorkOrderRow[];
  const workerNameById = new Map(
    (workerData ?? []).map((row) => [
      row.id,
      (row.user_profile as unknown as { display_name: string } | null)?.display_name ??
        `Worker ${row.id}`,
    ]),
  );
  // The crew is everyone still on the order's jobs, lead first.
  const crewFor = (row: WorkOrderRow) => {
    const ids = [
      ...new Set(
        row.task.flatMap((task) =>
          task.status === "cancelled"
            ? []
            : task.assignment.filter((a) => a.status !== "reassigned").map((a) => a.worker_id),
        ),
      ),
    ].sort((a, b) => (a === row.lead_worker_id ? -1 : b === row.lead_worker_id ? 1 : a - b));
    return ids.map((id) => workerNameById.get(id) ?? `Worker ${id}`);
  };
  const crewLabel = (row: WorkOrderRow) => {
    const crew = crewFor(row);
    if (!crew.length) return null;
    return crew.length === 1 ? crew[0] : `${crew[0]} +${crew.length - 1}`;
  };
  const dateLabel = view === "completed" ? "Completed" : view === "cancelled" ? "Cancelled" : "Due";
  const dateFor = (row: WorkOrderRow) =>
    formatDate(
      view === "completed"
        ? row.completed_at
        : view === "cancelled"
          ? row.cancelled_at
          : row.completion_due_date,
    );
  const tabHref = (target: View) => {
    const next = new URLSearchParams();
    if (target !== "active") next.set("view", target);
    if (query) next.set("q", query);
    const suffix = next.toString();
    return `/manager/work-orders${suffix ? `?${suffix}` : ""}`;
  };
  return (
    <>
      <PageHeader
        eyebrow="Operations"
        title="Work orders"
        description="Active work up front. Completed orders move to their own tab, and cancelled ones to theirs."
        actions={
          <Link
            href="/manager/work-orders/new"
            className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-[#003f70] px-4 text-sm font-semibold text-white"
          >
            <Plus className="h-4 w-4" />
            New work order
          </Link>
        }
      />
      {params.notice === "deleted" && (
        <div
          role="status"
          className="mb-5 flex items-center gap-2 rounded-2xl border border-[#cfe4d8] bg-[#eaf5ee] px-4 py-3 text-sm font-medium text-[#2f6446]"
        >
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          Work order deleted.
        </div>
      )}
      <nav aria-label="Work order lists" className="mb-4 flex gap-2 overflow-x-auto pb-1">
        {(Object.keys(VIEWS) as View[]).map((target) => {
          const { label, icon: Icon } = VIEWS[target];
          const current = target === view;
          return (
            <Link
              key={target}
              href={tabHref(target)}
              aria-current={current ? "page" : undefined}
              className={cn(
                "inline-flex min-h-11 shrink-0 items-center gap-2 rounded-xl border px-4 text-sm font-semibold",
                current
                  ? "border-[#003f70] bg-[#003f70] text-white"
                  : "border-[#d9d4c9] bg-white text-[#3a423f] hover:bg-[#f8f6f1]",
              )}
            >
              <Icon className="h-4 w-4" />
              {label}
              <span
                className={cn(
                  "rounded-full px-2 py-0.5 text-xs",
                  current ? "bg-white/20" : "bg-[#eeece5] text-[#59605e]",
                )}
              >
                {counts[target]}
              </span>
            </Link>
          );
        })}
      </nav>
      <Card className="overflow-hidden">
        <form className="flex flex-col gap-3 border-b border-[#e8e4dc] p-4 sm:flex-row">
          {view !== "active" && <input type="hidden" name="view" value={view} />}
          <div className="relative flex-1">
            <Search className="absolute top-3.5 left-3.5 h-4 w-4 text-[#89918e]" />
            <input
              name="q"
              defaultValue={query}
              placeholder="Search order or client reference"
              className="min-h-11 w-full rounded-xl border border-[#d9d4c9] bg-white pr-3 pl-10 text-sm outline-none focus:border-[#007ba7]"
            />
          </div>
          {view === "active" && (
            <select
              name="status"
              defaultValue={status}
              className="min-h-11 rounded-xl border border-[#d9d4c9] bg-white px-3 text-sm"
            >
              <option value="">All active statuses</option>
              {ACTIVE_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {value.replaceAll("_", " ")}
                </option>
              ))}
            </select>
          )}
          <button className="min-h-11 rounded-xl border border-[#d9d4c9] bg-[#f8f6f1] px-4 text-sm font-semibold">
            {view === "active" ? "Filter" : "Search"}
          </button>
        </form>
        {error ? (
          <p className="p-6 text-sm text-[#913a31]">Could not load work orders.</p>
        ) : (
          <>
            <div className="divide-y divide-[#ebe7df] lg:hidden">
              {rows.map((row) => (
                <Link
                  key={row.id}
                  href={`/manager/work-orders/${row.id}`}
                  className="block space-y-2 p-4 break-words hover:bg-[#faf9f6]"
                >
                  <p className="font-bold text-[#24575d]">{row.work_order_number}</p>
                  <StatusBadge status={row.status} />
                  <p className="text-sm">
                    {row.client?.name} · {row.site?.suburb}
                  </p>
                  <p className="text-xs text-[#607181]">
                    {row.client_reference || "No client reference"} · {row.task?.length ?? 0} jobs
                  </p>
                  <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
                    <dt>Crew</dt>
                    <dd>{crewFor(row).join(", ") || "Unassigned"}</dd>
                    <dt>{dateLabel}</dt>
                    <dd>{dateFor(row)}</dd>
                    <dt>Total</dt>
                    <dd>{formatMoney(row.work_order_totals?.total_cents ?? 0)}</dd>
                  </dl>
                </Link>
              ))}
              {!rows.length && (
                <p className="p-6 text-sm">
                  No {VIEWS[view].label.toLowerCase()} work orders found.
                </p>
              )}
            </div>
            <div
              role="region"
              aria-label="Work orders, scroll horizontally for all columns"
              tabIndex={0}
              className="hidden overflow-x-auto lg:block"
            >
              <table className="w-full min-w-[860px] text-left text-sm">
                <thead className="bg-[#f8f6f1] text-xs tracking-wider text-[#737d7a] uppercase">
                  <tr>
                    <th className="px-5 py-3 font-bold">Order</th>
                    <th className="px-5 py-3 font-bold">Client / site</th>
                    <th className="px-5 py-3 font-bold">Status</th>
                    <th className="px-5 py-3 font-bold">Crew</th>
                    <th className="px-5 py-3 font-bold">{dateLabel}</th>
                    <th className="px-5 py-3 text-right font-bold">Total</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#ebe7df]">
                  {rows.map((row) => (
                    <tr key={row.id} className="hover:bg-[#faf9f6]">
                      <td className="px-5 py-4">
                        <Link
                          href={`/manager/work-orders/${row.id}`}
                          className="font-bold text-[#24575d] hover:underline"
                        >
                          {row.work_order_number}
                        </Link>
                        <p className="mt-1 text-xs text-[#7c8582]">
                          {row.client_reference || "No client reference"} · {row.task?.length ?? 0}{" "}
                          jobs
                        </p>
                      </td>
                      <td className="px-5 py-4">
                        <p className="font-semibold">{row.client?.name}</p>
                        <p className="mt-1 text-xs text-[#7c8582]">{row.site?.suburb}</p>
                      </td>
                      <td className="px-5 py-4">
                        <StatusBadge status={row.status} />
                      </td>
                      <td className="px-5 py-4 text-[#596461]" title={crewFor(row).join(", ")}>
                        {crewLabel(row) ?? (
                          <span className="font-semibold text-[#9a6324]">Unassigned</span>
                        )}
                      </td>
                      <td className="px-5 py-4 text-[#596461]">{dateFor(row)}</td>
                      <td className="px-5 py-4 text-right font-mono font-semibold">
                        {formatMoney(row.work_order_totals?.total_cents)}
                      </td>
                    </tr>
                  ))}
                  {!rows.length && (
                    <tr>
                      <td colSpan={6} className="px-5 py-16 text-center text-[#737d7a]">
                        No {VIEWS[view].label.toLowerCase()} work orders match.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Card>
    </>
  );
}
