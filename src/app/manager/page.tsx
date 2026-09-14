import Link from "next/link";
import {
  AlertTriangle,
  ArrowRight,
  CalendarClock,
  CheckCircle2,
  ClipboardList,
  DollarSign,
  Plus,
  Users,
} from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Card } from "@/components/ui/card";
import { StatusBadge } from "@/components/status-badge";
import { requireRole } from "@/lib/auth";
import type { TaskStatus, WorkOrderStatus } from "@/lib/domain";
import { createClient } from "@/lib/supabase/server";
import { formatDate, formatMoney, timeAgo } from "@/lib/utils";

type WorkOrderSummary = {
  id: number;
  work_order_number: string;
  status: WorkOrderStatus;
  client: { name: string } | null;
  site: { suburb: string } | null;
};
type ScheduleRow = {
  id: number;
  start_time: string | null;
  task: {
    id: number;
    description: string;
    status: TaskStatus;
    work_order: WorkOrderSummary | null;
  } | null;
  work_order: WorkOrderSummary | null;
  worker: { user_profile: { display_name: string } | null } | null;
};
type AuditRow = {
  id: number;
  action: string;
  entity_type: string;
  created_at: string;
  actor: { display_name: string } | null;
};

export const metadata = { title: "Manager overview" };

export default async function ManagerDashboard() {
  const profile = await requireRole("manager");
  const supabase = await createClient();
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney" }).format(
    new Date(),
  );
  const [ordersResult, pendingResult, tasksResult, scheduleResult, auditResult, revenueResult] =
    await Promise.all([
      supabase
        .from("work_order")
        .select("id", { count: "exact", head: true })
        .not("status", "in", "(signed_off,cancelled)"),
      supabase
        .from("completion_submission")
        .select("id", { count: "exact", head: true })
        .eq("status", "submitted"),
      // Cancelled orders must not feed the unassigned or overdue tiles, however
      // their tasks were left.
      supabase
        .from("task")
        .select("id,status,work_order!inner(completion_due_date,status),assignment(id)")
        .not("status", "in", "(completed,cancelled)")
        .neq("work_order.status", "cancelled"),
      supabase
        .from("schedule_entry")
        .select(
          "id,start_time,task:task_id(id,description,status,work_order:work_order_id(id,work_order_number,status,client:client_id(name),site:site_id(suburb))),work_order:work_order_id(id,work_order_number,status,client:client_id(name),site:site_id(suburb)),worker:worker_id(user_profile:user_id(display_name))",
        )
        .eq("planned_date", today)
        .order("start_time"),
      supabase
        .from("audit_event")
        .select("id,action,entity_type,created_at,actor:actor_user_id(display_name)")
        .order("created_at", { ascending: false })
        .limit(6),
      supabase
        .from("work_order_totals")
        .select("total_cents,work_order!inner(status)")
        .eq("work_order.status", "signed_off"),
    ]);
  const tasks = (tasksResult.data ?? []) as unknown as Array<{
    status: TaskStatus;
    work_order: { completion_due_date: string | null } | null;
    assignment: Array<{ id: number }>;
  }>;
  const unassigned = tasks.filter((task) => !task.assignment?.length).length;
  const overdue = tasks.filter(
    (task) => task.work_order?.completion_due_date && task.work_order.completion_due_date < today,
  ).length;
  const revenue = (revenueResult.data ?? []).reduce(
    (sum, row) => sum + Number(row.total_cents ?? 0),
    0,
  );
  const schedule = ((scheduleResult.data ?? []) as unknown as ScheduleRow[]).filter(
    (row) => (row.task?.work_order ?? row.work_order)?.status !== "cancelled",
  );
  const audit = (auditResult.data ?? []) as unknown as AuditRow[];
  const cards = [
    {
      label: "Active work orders",
      value: ordersResult.count ?? 0,
      icon: ClipboardList,
      tone: "bg-[#e2f1f8] text-[#0078ad]",
      href: "/manager/work-orders",
    },
    {
      label: "Awaiting approval",
      value: pendingResult.count ?? 0,
      icon: CheckCircle2,
      tone: "bg-[#eee6f3] text-[#704e80]",
      href: "/manager/review",
    },
    {
      label: "Unassigned tasks",
      value: unassigned,
      icon: Users,
      tone: "bg-[#f6ead0] text-[#845b1d]",
      href: "/manager/work-orders?attention=unassigned",
    },
    {
      label: "Overdue tasks",
      value: overdue,
      icon: AlertTriangle,
      tone: "bg-[#f5dfdc] text-[#9b4035]",
      href: "/manager/work-orders?attention=overdue",
    },
  ];
  return (
    <>
      <PageHeader
        eyebrow={`Good ${new Date().getHours() < 12 ? "morning" : "afternoon"}, ${profile.display_name.split(" ")[0]}`}
        title="Keep the day moving"
        description="A live view of work that needs assignment, scheduling or approval."
        actions={
          <Link
            href="/manager/work-orders/new"
            className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-[#003f70] px-4 text-sm font-semibold text-white hover:bg-[#005a8d]"
          >
            <Plus className="h-4 w-4" />
            New work order
          </Link>
        }
      />
      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {cards.map(({ label, value, icon: Icon, tone, href }) => (
          <Link key={label} href={href}>
            <Card className="p-5 transition hover:-translate-y-0.5 hover:border-[#c5bfb2] hover:shadow-md">
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-sm font-medium text-[#6d7774]">{label}</p>
                  <p className="mt-2 text-4xl font-semibold tracking-[-.04em]">{value}</p>
                </div>
                <div className={`grid h-11 w-11 place-items-center rounded-2xl ${tone}`}>
                  <Icon className="h-5 w-5" />
                </div>
              </div>
            </Card>
          </Link>
        ))}
      </section>
      <section className="mt-6 grid gap-6 xl:grid-cols-[1.45fr_.85fr]">
        <Card className="overflow-hidden">
          <div className="flex items-center justify-between border-b border-[#ebe7df] px-5 py-4">
            <div>
              <h2 className="font-semibold">Today&apos;s schedule</h2>
              <p className="text-sm text-[#77807e]">{formatDate(today, "EEEE, d MMMM")}</p>
            </div>
            <Link href="/manager/calendar" className="text-sm font-semibold text-[#0077a8]">
              Open calendar
            </Link>
          </div>
          <div className="divide-y divide-[#ebe7df]">
            {schedule.length ? (
              schedule.map((item) => {
                const order = item.task?.work_order ?? item.work_order;
                const status = item.task?.status ?? order?.status;
                return (
                  <Link
                    key={item.id}
                    href={`/manager/work-orders/${order?.id}`}
                    className="grid grid-cols-[48px_minmax(0,1fr)] items-center gap-3 px-5 py-4 hover:bg-[#faf9f6] sm:grid-cols-[64px_minmax(0,1fr)_auto]"
                  >
                    <span className="font-mono text-sm font-semibold text-[#596461]">
                      {item.start_time?.slice(0, 5) ?? "Any"}
                    </span>
                    <div>
                      <p className="line-clamp-1 font-semibold">
                        {item.task?.description ?? "Whole work order · All tasks"}
                      </p>
                      <p className="mt-0.5 text-sm text-[#75807c]">
                        {order?.work_order_number} · {order?.client?.name} · {order?.site?.suburb}
                      </p>
                      <p className="mt-1 text-xs font-medium text-[#b44a00]">
                        {item.worker?.user_profile?.display_name ?? "No worker"}
                      </p>
                    </div>
                    {status && (
                      <div className="col-start-2 sm:col-start-auto">
                        <StatusBadge status={status} />
                      </div>
                    )}
                  </Link>
                );
              })
            ) : (
              <div className="px-5 py-12 text-center">
                <CalendarClock className="mx-auto h-7 w-7 text-[#9ba29f]" />
                <p className="mt-3 font-semibold">Nothing scheduled today</p>
                <p className="mt-1 text-sm text-[#7a8380]">Use the calendar to plan the crew.</p>
              </div>
            )}
          </div>
        </Card>
        <div className="space-y-6">
          <Card className="overflow-hidden">
            <div className="border-b border-[#ebe7df] px-5 py-4">
              <p className="text-sm font-medium text-[#6d7774]">Signed-off value</p>
              <div className="mt-2 flex items-end justify-between">
                <p className="text-3xl font-semibold tracking-[-.04em]">{formatMoney(revenue)}</p>
                <div className="grid h-10 w-10 place-items-center rounded-xl bg-[#e1eee8] text-[#2f6249]">
                  <DollarSign className="h-5 w-5" />
                </div>
              </div>
            </div>
            <p className="px-5 py-3 text-xs text-[#7a8380]">
              Manager-only financial summary. Never included in worker data.
            </p>
          </Card>
          <Card className="overflow-hidden">
            <div className="flex items-center justify-between border-b border-[#ebe7df] px-5 py-4">
              <h2 className="font-semibold">Recent activity</h2>
              <Link href="/manager/audit" className="text-sm font-semibold text-[#0077a8]">
                View all
              </Link>
            </div>
            <div className="divide-y divide-[#ebe7df]">
              {audit.map((event) => (
                <div key={event.id} className="flex gap-3 px-5 py-3.5">
                  <div className="mt-1 h-2 w-2 shrink-0 rounded-full bg-[#0089bd]" />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {event.actor?.display_name ?? "System"} ·{" "}
                      {event.action.replaceAll("_", " ").replace(".", " ")}
                    </p>
                    <p className="mt-0.5 text-xs text-[#7d8583]">{timeAgo(event.created_at)}</p>
                  </div>
                </div>
              ))}
              {!audit.length && (
                <p className="px-5 py-8 text-center text-sm text-[#7a8380]">
                  Activity will appear here.
                </p>
              )}
            </div>
          </Card>
        </div>
      </section>
      <Link
        href="/manager/work-orders?attention=unassigned"
        className="mt-6 flex items-center justify-between rounded-2xl bg-[#003f70] px-5 py-4 text-white"
      >
        <span className="font-semibold">Review work needing attention</span>
        <ArrowRight className="h-5 w-5" />
      </Link>
    </>
  );
}
