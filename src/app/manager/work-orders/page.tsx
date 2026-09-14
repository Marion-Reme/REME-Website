import Link from "next/link";
import { Plus, Search } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Card } from "@/components/ui/card";
import type { WorkOrderStatus } from "@/lib/domain";
import { createClient } from "@/lib/supabase/server";
import { formatDate, formatMoney } from "@/lib/utils";

type WorkOrderRow = {
  id: number;
  work_order_number: string;
  client_reference: string | null;
  status: WorkOrderStatus;
  completion_due_date: string | null;
  client: { name: string } | null;
  site: { suburb: string } | null;
  lead_worker: { user_profile: { display_name: string } | null } | null;
  task: Array<{ id: number }>;
  work_order_totals: { total_cents: number } | null;
};

export const metadata = { title: "Work orders" };

export default async function WorkOrdersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  const query = params.q?.trim() ?? "";
  const status = params.status ?? "";
  const supabase = await createClient();
  let request = supabase
    .from("work_order")
    .select(
      "id,work_order_number,client_reference,status,completion_due_date,client:client_id(name),site:site_id(suburb),lead_worker:lead_worker_id(user_profile:user_id(display_name)),task(id),work_order_totals(total_cents)",
    )
    .order("created_at", { ascending: false });
  if (status) request = request.eq("status", status);
  if (query)
    request = request.or(
      `work_order_number.ilike.%${query.replace(/[%_,]/g, "")}%,client_reference.ilike.%${query.replace(/[%_,]/g, "")}%`,
    );
  const { data, error } = await request;
  const rows = (data ?? []) as unknown as WorkOrderRow[];
  return (
    <>
      <PageHeader
        eyebrow="Operations"
        title="Work orders"
        description="Every active, completed and cancelled order in one place."
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
      <Card className="overflow-hidden">
        <form className="flex flex-col gap-3 border-b border-[#e8e4dc] p-4 sm:flex-row">
          <div className="relative flex-1">
            <Search className="absolute top-3.5 left-3.5 h-4 w-4 text-[#89918e]" />
            <input
              name="q"
              defaultValue={query}
              placeholder="Search order or client reference"
              className="min-h-11 w-full rounded-xl border border-[#d9d4c9] bg-white pr-3 pl-10 text-sm outline-none focus:border-[#007ba7]"
            />
          </div>
          <select
            name="status"
            defaultValue={status}
            className="min-h-11 rounded-xl border border-[#d9d4c9] bg-white px-3 text-sm"
          >
            <option value="">All statuses</option>
            {[
              "ready",
              "assigned",
              "scheduled",
              "in_progress",
              "changes_requested",
              "blocked",
              "signed_off",
              "cancelled",
            ].map((value) => (
              <option key={value} value={value}>
                {value.replaceAll("_", " ")}
              </option>
            ))}
          </select>
          <button className="min-h-11 rounded-xl border border-[#d9d4c9] bg-[#f8f6f1] px-4 text-sm font-semibold">
            Filter
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
                    {row.client_reference || "No client reference"} · {row.task?.length ?? 0} tasks
                  </p>
                  <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
                    <dt>Lead</dt>
                    <dd>{row.lead_worker?.user_profile?.display_name ?? "Unassigned"}</dd>
                    <dt>Due</dt>
                    <dd>{formatDate(row.completion_due_date)}</dd>
                    <dt>Total</dt>
                    <dd>{formatMoney(row.work_order_totals?.total_cents ?? 0)}</dd>
                  </dl>
                </Link>
              ))}
              {!rows.length && <p className="p-6 text-sm">No work orders found.</p>}
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
                    <th className="px-5 py-3 font-bold">Lead</th>
                    <th className="px-5 py-3 font-bold">Due</th>
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
                          tasks
                        </p>
                      </td>
                      <td className="px-5 py-4">
                        <p className="font-semibold">{row.client?.name}</p>
                        <p className="mt-1 text-xs text-[#7c8582]">{row.site?.suburb}</p>
                      </td>
                      <td className="px-5 py-4">
                        <StatusBadge status={row.status} />
                      </td>
                      <td className="px-5 py-4 text-[#596461]">
                        {row.lead_worker?.user_profile?.display_name ?? (
                          <span className="font-semibold text-[#9a6324]">Unassigned</span>
                        )}
                      </td>
                      <td className="px-5 py-4 text-[#596461]">
                        {formatDate(row.completion_due_date)}
                      </td>
                      <td className="px-5 py-4 text-right font-mono font-semibold">
                        {formatMoney(row.work_order_totals?.total_cents)}
                      </td>
                    </tr>
                  ))}
                  {!rows.length && (
                    <tr>
                      <td colSpan={6} className="px-5 py-16 text-center text-[#737d7a]">
                        No work orders match these filters.
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
