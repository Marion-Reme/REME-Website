import Link from "next/link";
import { addDays, format, parseISO, startOfWeek } from "date-fns";
import {
  ArrowLeft,
  ArrowRight,
  CalendarDays,
  ChevronDown,
  ExternalLink,
  TriangleAlert,
} from "lucide-react";
import {
  UnassignAllControl,
  UnassignTaskForm,
  UnscheduleAllControl,
} from "@/components/calendar-queue-actions";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import type { TaskStatus, WorkOrderStatus } from "@/lib/domain";
import { createClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";

type WorkOrderSummary = {
  id: number;
  work_order_number: string;
  status: WorkOrderStatus;
  client: { name: string } | null;
};
type ScheduleItem = {
  id: number;
  planned_date: string;
  start_time: string | null;
  estimated_hours: number | null;
  worker_id: number | null;
  task: {
    id: number;
    description: string;
    status: TaskStatus;
    work_order: WorkOrderSummary | null;
  } | null;
  work_order: WorkOrderSummary | null;
};
type WorkerRow = { id: number; user_profile: { display_name: string } | null };
type QueueTask = {
  id: number;
  description: string;
  status: TaskStatus;
  work_order: {
    id: number;
    work_order_number: string;
    status: WorkOrderStatus;
    client: { name: string } | null;
  } | null;
  assignment: Array<{ id: number; status: string; worker_id: number }>;
};
type UpcomingScheduleTarget = {
  task_id: number | null;
  work_order_id: number | null;
  planned_date: string;
  worker_id: number | null;
};
export const metadata = { title: "Calendar" };
export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ week?: string }>;
}) {
  const { week } = await searchParams;
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney" }).format(
    new Date(),
  );
  const base = week && /^\d{4}-\d{2}-\d{2}$/.test(week) ? parseISO(week) : parseISO(today);
  const monday = startOfWeek(base, { weekStartsOn: 1 });
  const days = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
  const from = format(days[0], "yyyy-MM-dd"),
    to = format(days[6], "yyyy-MM-dd");
  const supabase = await createClient();
  const [
    { data: scheduleData },
    { data: workerData },
    { data: taskData },
    { data: upcomingScheduleData },
  ] = await Promise.all([
    supabase
      .from("schedule_entry")
      .select(
        "id,planned_date,start_time,estimated_hours,worker_id,task:task_id(id,description,status,work_order:work_order_id(id,work_order_number,status,client:client_id(name))),work_order:work_order_id(id,work_order_number,status,client:client_id(name))",
      )
      .gte("planned_date", from)
      .lte("planned_date", to)
      .order("start_time"),
    supabase.from("worker").select("id,user_profile:user_id(display_name,is_active)").order("id"),
    // The inner join plus the status filter keeps every task belonging to a
    // cancelled order out of all three queues, whatever state the task itself
    // was left in.
    supabase
      .from("task")
      .select(
        "id,description,status,work_order:work_order_id!inner(id,work_order_number,status,client:client_id(name)),assignment(id,status,worker_id)",
      )
      .not("status", "in", "(completed,cancelled)")
      .neq("work_order.status", "cancelled")
      .order("id"),
    supabase
      .from("schedule_entry")
      .select("task_id,work_order_id,planned_date,worker_id")
      .gte("planned_date", today)
      .order("planned_date"),
  ]);
  // Cancelling clears an order's dates, so this should already be empty. Kept as
  // a guard so a stray row can never put cancelled work back on the grid.
  const schedule = ((scheduleData ?? []) as unknown as ScheduleItem[]).filter(
    (item) => (item.task?.work_order ?? item.work_order)?.status !== "cancelled",
  );
  const workers = (workerData ?? []).filter(
    (worker) => (worker.user_profile as unknown as { is_active?: boolean } | null)?.is_active,
  ) as unknown as WorkerRow[];
  const taskRows = (taskData ?? []) as unknown as QueueTask[];
  const upcomingTargets = (upcomingScheduleData ?? []) as UpcomingScheduleTarget[];
  const upcomingTaskIds = new Set(
    upcomingTargets.flatMap((entry) => (entry.task_id == null ? [] : [entry.task_id])),
  );
  const upcomingOrderIds = new Set(
    upcomingTargets.flatMap((entry) => (entry.work_order_id == null ? [] : [entry.work_order_id])),
  );
  const planningStatuses = new Set<TaskStatus>(["draft", "ready", "assigned", "scheduled"]);
  const activeAssignments = (task: QueueTask) =>
    task.assignment.filter((assignment) => assignment.status !== "reassigned");
  const hasUpcomingSchedule = (task: QueueTask) =>
    upcomingTaskIds.has(task.id) ||
    (task.work_order ? upcomingOrderIds.has(task.work_order.id) : false);
  const assignedButUnscheduled = taskRows.filter(
    (task) =>
      planningStatuses.has(task.status) &&
      activeAssignments(task).length > 0 &&
      !hasUpcomingSchedule(task),
  );
  // Entries arrive ordered by planned_date, so the first one seen for a task or
  // an order is its next date.
  const nextDateByTask = new Map<number, string>();
  const nextDateByOrder = new Map<number, string>();
  for (const entry of upcomingTargets) {
    if (entry.task_id != null && !nextDateByTask.has(entry.task_id)) {
      nextDateByTask.set(entry.task_id, entry.planned_date);
    }
    if (entry.work_order_id != null && !nextDateByOrder.has(entry.work_order_id)) {
      nextDateByOrder.set(entry.work_order_id, entry.planned_date);
    }
  }
  // Built from the unfiltered worker rows: a schedule can still belong to
  // somebody who has since been deactivated.
  const workerNameById = new Map(
    ((workerData ?? []) as unknown as WorkerRow[]).map((worker) => [
      worker.id,
      worker.user_profile?.display_name ?? `Worker ${worker.id}`,
    ]),
  );
  const nextDateFor = (task: QueueTask) =>
    nextDateByTask.get(task.id) ??
    (task.work_order ? nextDateByOrder.get(task.work_order.id) : undefined);
  const scheduled = taskRows
    .filter((task) => planningStatuses.has(task.status) && hasUpcomingSchedule(task))
    .sort((a, b) => (nextDateFor(a) ?? "").localeCompare(nextDateFor(b) ?? ""));
  const unassigned = taskRows.filter(
    (task) => planningStatuses.has(task.status) && activeAssignments(task).length === 0,
  );
  return (
    <>
      <PageHeader
        eyebrow="Planning"
        title="Crew calendar"
        description={`${format(days[0], "d MMM")} - ${format(days[6], "d MMM yyyy")}`}
        actions={
          <>
            <Link
              aria-label="Previous week"
              href={`/manager/calendar?week=${format(addDays(monday, -7), "yyyy-MM-dd")}`}
              className="grid h-11 w-11 place-items-center rounded-xl border border-[#d9d4c9] bg-white"
            >
              <ArrowLeft className="h-4 w-4" />
            </Link>
            <Link
              aria-label="Next week"
              href={`/manager/calendar?week=${format(addDays(monday, 7), "yyyy-MM-dd")}`}
              className="grid h-11 w-11 place-items-center rounded-xl border border-[#d9d4c9] bg-white"
            >
              <ArrowRight className="h-4 w-4" />
            </Link>
          </>
        }
      />
      <section aria-label="Weekly agenda" className="space-y-4 lg:hidden">
        {days.map((day) => {
          const date = format(day, "yyyy-MM-dd");
          const items = schedule.filter((item) => item.planned_date === date);
          return (
            <Card key={date} className="p-4">
              <h2 className="mb-3 font-semibold">
                {format(day, "EEEE, d MMM")}
                {date === today ? " · Today" : ""}
              </h2>
              <div className="space-y-3">
                {items.map((item) => {
                  const order = item.task?.work_order ?? item.work_order;
                  const worker = workers.find((worker) => worker.id === item.worker_id);
                  const dailyHours = items
                    .filter((entry) => entry.worker_id === item.worker_id)
                    .reduce((total, entry) => total + Number(entry.estimated_hours ?? 0), 0);
                  const status = item.task?.status ?? order?.status;
                  return (
                    <Link
                      key={item.id}
                      href={`/manager/work-orders/${order?.id}`}
                      className="block min-h-11 rounded-xl border border-[#cfdedc] bg-[#e8f1ef] p-3 text-sm break-words"
                    >
                      <p className="font-semibold">
                        {item.start_time?.slice(0, 5) ?? "Any time"} · {order?.work_order_number}
                      </p>
                      <p>{worker?.user_profile?.display_name ?? "Unassigned / disabled worker"}</p>
                      <p className="my-2">
                        {item.task?.description ?? "Whole work order · All tasks"}
                      </p>
                      {item.estimated_hours && <p className="mb-2">{item.estimated_hours} hours</p>}
                      {status && <StatusBadge status={status} />}
                      {dailyHours > 8 && (
                        <div className="mt-2">
                          <Badge tone="red">{dailyHours}h booked for this worker today</Badge>
                        </div>
                      )}
                    </Link>
                  );
                })}
                {!items.length && <p className="text-sm text-[#607181]">No work scheduled.</p>}
              </div>
            </Card>
          );
        })}
      </section>
      <Card
        role="region"
        aria-label="Weekly crew calendar, scroll horizontally"
        tabIndex={0}
        className="hidden overflow-x-auto lg:block"
      >
        <div className="min-w-[1050px]">
          <div className="grid grid-cols-[170px_repeat(7,1fr)] border-b border-[#ddd8ce] bg-[#f8f6f1]">
            <div className="p-3 text-xs font-bold tracking-wider text-[#737d7a] uppercase">
              Worker
            </div>
            {days.map((day) => {
              const date = format(day, "yyyy-MM-dd");
              const isToday = date === today;
              return (
                <div
                  key={date}
                  className={cn(
                    "border-l border-[#e1ddd4] p-3 text-center",
                    isToday && "bg-[#fff3da] ring-2 ring-[#d49a4a] ring-inset",
                  )}
                >
                  <p className="text-xs font-bold text-[#7a8380] uppercase">{format(day, "EEE")}</p>
                  <p className="mt-1 text-lg font-semibold">{format(day, "d")}</p>
                  {isToday && (
                    <p className="mt-0.5 text-[10px] font-bold tracking-wider text-[#9b5d20] uppercase">
                      Today
                    </p>
                  )}
                </div>
              );
            })}
          </div>
          {workers.map((worker) => (
            <div
              key={worker.id}
              className="grid min-h-28 grid-cols-[170px_repeat(7,1fr)] border-b border-[#e8e4dc] last:border-0"
            >
              <div className="p-3 text-sm font-semibold">{worker.user_profile?.display_name}</div>
              {days.map((day) => {
                const date = format(day, "yyyy-MM-dd");
                const items = schedule.filter(
                  (item) => item.worker_id === worker.id && item.planned_date === date,
                );
                const hours = items.reduce(
                  (sum, item) => sum + Number(item.estimated_hours ?? 0),
                  0,
                );
                const isToday = date === today;
                return (
                  <div
                    key={date}
                    className={cn(
                      "space-y-2 border-l border-[#e8e4dc] p-2",
                      isToday && "bg-[#fffbf2]",
                      hours > 8 && "bg-[#fff1e8]",
                    )}
                  >
                    {items.map((item) => {
                      const order = item.task?.work_order ?? item.work_order;
                      const status = item.task?.status ?? order?.status;
                      return (
                        <Link
                          href={`/manager/work-orders/${order?.id}`}
                          key={item.id}
                          className="block rounded-lg border border-[#cfdedc] bg-[#e8f1ef] p-2 text-xs"
                        >
                          <p className="font-bold text-[#24575d]">
                            {item.start_time?.slice(0, 5) ?? "Any time"} ·{" "}
                            {order?.work_order_number}
                          </p>
                          <p className="mt-1 line-clamp-2 font-medium">
                            {item.task?.description ?? "Whole work order · All tasks"}
                          </p>
                          {status && (
                            <div className="mt-2">
                              <StatusBadge status={status} />
                            </div>
                          )}
                        </Link>
                      );
                    })}
                    {hours > 8 && (
                      <Badge tone="red">
                        <TriangleAlert className="mr-1 h-3 w-3" />
                        {hours}h
                      </Badge>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </Card>
      <Card className="mt-6 overflow-visible">
        <div className="flex flex-col gap-3 border-b border-[#e8e4dc] px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="font-semibold">Scheduled</h2>
            <p className="text-sm text-[#7a8380]">
              Every job with an upcoming date, whichever week it falls in.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Badge tone={scheduled.length ? "teal" : "green"}>{scheduled.length}</Badge>
            {scheduled.length > 0 && <UnscheduleAllControl />}
          </div>
        </div>
        <div className="divide-y divide-[#e9e5dd]">
          {scheduled.map((task) => {
            const next = nextDateFor(task);
            const workerId = activeAssignments(task)[0]?.worker_id;
            return (
              <Link
                key={task.id}
                href={`/manager/work-orders/${task.work_order?.id}`}
                className="flex items-center justify-between gap-3 px-5 py-4 hover:bg-[#faf9f6]"
              >
                <div className="min-w-0">
                  <p className="text-sm font-semibold">{task.description}</p>
                  <p className="mt-1 text-xs text-[#7a8380]">
                    {task.work_order?.work_order_number}
                    {task.work_order?.client?.name ? ` · ${task.work_order.client.name}` : ""}
                    {workerId != null
                      ? ` · ${workerNameById.get(workerId) ?? "Unknown worker"}`
                      : ""}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {next && <Badge tone="teal">{format(parseISO(next), "EEE d MMM")}</Badge>}
                  <CalendarDays className="h-4 w-4 text-[#0077a8]" />
                </div>
              </Link>
            );
          })}
          {!scheduled.length && (
            <p className="p-8 text-center text-sm text-[#7a8380]">
              Nothing is scheduled. Assign dates from a work order to fill the calendar.
            </p>
          )}
        </div>
      </Card>
      <Card className="mt-6 overflow-visible">
        <div className="flex flex-col gap-3 border-b border-[#e8e4dc] px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="font-semibold">Assigned but unscheduled</h2>
            <p className="text-sm text-[#7a8380]">
              Open a job to unassign it or use its work order to add dates.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Badge tone={assignedButUnscheduled.length ? "amber" : "green"}>
              {assignedButUnscheduled.length}
            </Badge>
            {assignedButUnscheduled.length > 0 && <UnassignAllControl />}
          </div>
        </div>
        <div className="divide-y divide-[#e9e5dd]">
          {assignedButUnscheduled.map((task) => (
            <details key={task.id} className="group">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-5 py-4 hover:bg-[#faf9f6]">
                <div>
                  <p className="text-sm font-semibold">{task.description}</p>
                  <p className="mt-1 text-xs text-[#7a8380]">
                    {task.work_order?.work_order_number}
                    {task.work_order?.client?.name ? ` · ${task.work_order.client.name}` : ""}
                  </p>
                </div>
                <ChevronDown className="h-4 w-4 shrink-0 text-[#0077a8] transition group-open:rotate-180" />
              </summary>
              <div className="space-y-3 border-t border-[#efebe4] px-5 pt-3 pb-4">
                <Link
                  href={`/manager/work-orders/${task.work_order?.id}`}
                  className="inline-flex min-h-10 items-center gap-2 text-sm font-semibold text-[#0077a8] hover:underline"
                >
                  Open work order
                  <ExternalLink className="h-3.5 w-3.5" />
                </Link>
                <UnassignTaskForm taskId={task.id} />
              </div>
            </details>
          ))}
          {!assignedButUnscheduled.length && (
            <p className="p-8 text-center text-sm text-[#7a8380]">
              All assigned tasks have an upcoming schedule.
            </p>
          )}
        </div>
      </Card>
      <Card className="mt-6 overflow-hidden">
        <div className="flex items-center justify-between border-b border-[#e8e4dc] px-5 py-4">
          <div>
            <h2 className="font-semibold">Unassigned jobs</h2>
            <p className="text-sm text-[#7a8380]">
              These tasks need a worker before they can appear on the crew calendar.
            </p>
          </div>
          <Badge tone={unassigned.length ? "amber" : "green"}>{unassigned.length}</Badge>
        </div>
        <div className="divide-y divide-[#e9e5dd]">
          {unassigned.map((task) => (
            <Link
              key={task.id}
              href={`/manager/work-orders/${task.work_order?.id}`}
              className="flex items-center justify-between gap-3 px-5 py-4 hover:bg-[#faf9f6]"
            >
              <div>
                <p className="text-sm font-semibold">{task.description}</p>
                <p className="mt-1 text-xs text-[#7a8380]">
                  {task.work_order?.work_order_number}
                  {task.work_order?.client?.name ? ` · ${task.work_order.client.name}` : ""}
                </p>
              </div>
              <CalendarDays className="h-4 w-4 shrink-0 text-[#9a6324]" />
            </Link>
          ))}
          {!unassigned.length && (
            <p className="p-8 text-center text-sm text-[#7a8380]">
              No jobs are waiting for assignment.
            </p>
          )}
        </div>
      </Card>
    </>
  );
}
