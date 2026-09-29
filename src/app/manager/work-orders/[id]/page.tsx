import Link from "next/link";
import { notFound } from "next/navigation";
import {
  Archive,
  ArrowLeft,
  CalendarDays,
  CheckCircle2,
  ExternalLink,
  FileText,
  MapPin,
  Pencil,
  Phone,
  RotateCcw,
  ShieldCheck,
  Users,
} from "lucide-react";
import { cancelWorkOrder, reopenTask } from "@/actions/work-orders";
import {
  ScheduleTaskForm,
  UnscheduleEntryForm,
  WorkOrderCrewForm,
} from "@/components/assignment-form";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { TaskEditForm } from "@/components/task-edit-form";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import {
  AddJobForm,
  CompleteJobForm,
  CompleteWorkOrderForm,
  DeleteJobForm,
  DeleteWorkOrderForm,
  ReopenWorkOrderForm,
} from "@/components/work-order-actions";
import type { TaskStatus, WorkOrderStatus } from "@/lib/domain";
import { createClient } from "@/lib/supabase/server";
import { formatDate, formatMoney, mapsUrl } from "@/lib/utils";

// Per-job assignment is switched off for now: a work order is assigned as a
// whole to its crew. Set this to true to bring back "Schedule this task" and the
// per-job worker badges.
const PER_JOB_ASSIGNMENT_ENABLED = false;
const CLOSED_TASK_STATUSES: TaskStatus[] = ["completed", "cancelled"];

type AssignmentRow = {
  id: number;
  worker_id: number;
  is_lead: boolean;
  status: string;
  worker: { user_profile: { display_name: string } | null } | null;
};
type ScheduleRow = {
  id: number;
  planned_date: string;
  start_time: string | null;
  estimated_hours: number | null;
  worker_id: number | null;
};
type TaskRow = {
  id: number;
  description: string;
  quantity: number;
  unit: string;
  area_label: string | null;
  status: TaskStatus;
  revised_since_viewed: boolean;
  trade_section: { trade_category: { name: string } | null } | null;
  assignment: AssignmentRow[];
  schedule_entry: ScheduleRow[];
};
type WorkOrderDetail = {
  id: number;
  work_order_number: string;
  job_number: string | null;
  client_reference: string | null;
  status: WorkOrderStatus;
  lead_worker_id: number | null;
  completed_at: string | null;
  cancelled_at: string | null;
  cancelled_reason: string | null;
  issued_at: string | null;
  start_date: string | null;
  completion_due_date: string | null;
  client_supervisor_name: string | null;
  client_supervisor_phone: string | null;
  notes: string | null;
  additional_instructions: string | null;
  client: { name: string; abn: string | null } | null;
  customer: { name: string; phone: string | null } | null;
  site: {
    id: number;
    street_address: string;
    suburb: string;
    state: string;
    postcode: string;
    access_notes: string | null;
    site_contact: Array<{ name: string; phone: string | null }>;
  } | null;
  work_order_totals: { total_cents: number } | null;
  task: TaskRow[];
  schedule_entry: ScheduleRow[];
  attachment: Array<{
    id: number;
    content_type: string;
    size_bytes: number;
    deleted_at: string | null;
  }>;
};

export default async function WorkOrderDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ notice?: string }>;
}) {
  const [{ id }, { notice }] = await Promise.all([params, searchParams]);
  const workOrderId = Number(id);
  if (!Number.isInteger(workOrderId)) notFound();
  const supabase = await createClient();
  const [
    { data, error: orderError },
    { data: workerData },
    { data: attachmentData, error: attachmentError },
  ] = await Promise.all([
    supabase
      .from("work_order")
      .select(
        "id,work_order_number,job_number,client_reference,status,lead_worker_id,completed_at,cancelled_at,cancelled_reason,issued_at,start_date,completion_due_date,client_supervisor_name,client_supervisor_phone,notes,additional_instructions,client:client_id(name,abn),customer:customer_id(name,phone),site:site_id(id,street_address,suburb,state,postcode,access_notes,site_contact(name,phone)),work_order_totals(total_cents),task(id,description,quantity,unit,area_label,status,revised_since_viewed,trade_section:trade_section_id(trade_category:trade_category_id(name)),assignment(id,worker_id,is_lead,status,worker:worker_id(user_profile:user_id(display_name))),schedule_entry(id,planned_date,start_time,estimated_hours,worker_id)),schedule_entry(id,planned_date,start_time,estimated_hours,worker_id)",
      )
      .eq("id", workOrderId)
      .single(),
    supabase.from("worker").select("id,user_profile:user_id(display_name,is_active)").order("id"),
    supabase
      .from("attachment")
      .select("id,content_type,size_bytes,deleted_at")
      .eq("owner_type", "work_order")
      .eq("owner_id", workOrderId),
  ]);
  if (orderError?.code === "PGRST116") notFound();
  if (orderError) throw new Error(`Could not load work order: ${orderError.message}`);
  if (!data) notFound();
  if (attachmentError)
    throw new Error(`Could not load work order attachments: ${attachmentError.message}`);
  const order = { ...data, attachment: attachmentData ?? [] } as unknown as WorkOrderDetail;
  const workers = (workerData ?? [])
    .filter(
      (row) =>
        row.user_profile && (row.user_profile as unknown as { is_active: boolean }).is_active,
    )
    .map((row) => ({
      id: row.id,
      name: (row.user_profile as unknown as { display_name: string }).display_name,
    }));
  // Built from every worker row: a crew member may since have been deactivated.
  const workerNameById = new Map(
    (workerData ?? []).map((row) => [
      row.id,
      (row.user_profile as unknown as { display_name: string } | null)?.display_name ??
        `Worker ${row.id}`,
    ]),
  );
  const isCancelled = order.status === "cancelled";
  const isCompleted = order.status === "signed_off" || order.status === "completed";
  const isActive = !isCancelled && !isCompleted;
  const liveWorkerIds = (task: TaskRow) => [
    ...new Set(task.assignment.filter((a) => a.status !== "reassigned").map((a) => a.worker_id)),
  ];
  const openTasks = order.task.filter((task) => !CLOSED_TASK_STATUSES.includes(task.status));
  // The crew is everyone on the open jobs. A finished order has none open, so its
  // crew is whoever did the work.
  const crewSource = openTasks.length
    ? openTasks
    : order.task.filter((task) => task.status !== "cancelled");
  const crewIds = [...new Set(crewSource.flatMap(liveWorkerIds))].sort((a, b) =>
    a === order.lead_worker_id ? -1 : b === order.lead_worker_id ? 1 : a - b,
  );
  const crewSignature = [...crewIds].sort((a, b) => a - b).join(",");
  // Jobs normally share the order's crew. Badges only appear on a job whose
  // workers differ, such as one assigned separately before crews existed.
  const differsFromCrew = (task: TaskRow) =>
    liveWorkerIds(task)
      .sort((a, b) => a - b)
      .join(",") !== crewSignature;
  const canDeleteJob = (task: TaskRow) =>
    isCancelled
      ? order.task.length > 1
      : order.task.some((other) => other.id !== task.id && other.status !== "cancelled");
  const grouped = order.task.reduce<Record<string, TaskRow[]>>((groups, task) => {
    const key = task.trade_section?.trade_category?.name ?? "Miscellaneous";
    (groups[key] ??= []).push(task);
    return groups;
  }, {});
  const address = order.site
    ? `${order.site.street_address}, ${order.site.suburb} ${order.site.state} ${order.site.postcode}`
    : "";
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney" }).format(
    new Date(),
  );
  return (
    <>
      <PageHeader
        eyebrow="Work order"
        title={order.work_order_number}
        description={`${order.client?.name ?? "Unknown client"} · ${order.site?.suburb ?? "No site"}`}
        actions={
          <>
            <Link
              href="/manager/work-orders"
              className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-[#d9d4c9] bg-white px-4 text-sm font-semibold"
            >
              <ArrowLeft className="h-4 w-4" />
              All orders
            </Link>
            <Link
              href={`/manager/work-orders/${order.id}/edit`}
              className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-[#d9d4c9] bg-white px-4 text-sm font-semibold"
            >
              <Pencil className="h-4 w-4" />
              Edit details
            </Link>
            <StatusBadge status={order.status} />
          </>
        }
      />
      {notice === "saved" && (
        <div
          role="status"
          className="mb-5 flex items-center gap-2 rounded-2xl border border-[#cfe4d8] bg-[#eaf5ee] px-4 py-3 text-sm font-medium text-[#2f6446]"
        >
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          Work order details saved.
        </div>
      )}
      {isCompleted && (
        <div className="mb-5 flex flex-wrap items-center gap-2 rounded-2xl border border-[#cfe4d8] bg-[#eaf5ee] px-4 py-3 text-sm text-[#2f6446]">
          <Archive className="h-4 w-4 shrink-0" />
          <span className="font-semibold">
            Completed{order.completed_at ? ` on ${formatDate(order.completed_at)}` : ""}.
          </span>
          <span>
            This order is in the{" "}
            <Link href="/manager/work-orders?view=completed" className="font-semibold underline">
              Completed
            </Link>{" "}
            tab.
          </span>
        </div>
      )}
      {isCancelled && (
        <div className="mb-5 rounded-2xl border border-[#e1ddd4] bg-[#f3f1ec] px-4 py-3 text-sm text-[#59605e]">
          <span className="font-semibold">
            Cancelled{order.cancelled_at ? ` on ${formatDate(order.cancelled_at)}` : ""}.
          </span>
          {order.cancelled_reason ? ` ${order.cancelled_reason}` : ""}
        </div>
      )}
      <div className="grid gap-6 xl:grid-cols-[1fr_330px]">
        <div className="space-y-6">
          <Card className="p-5 sm:p-6">
            <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <p className="text-xs font-bold tracking-wider text-[#818986] uppercase">
                  Client reference
                </p>
                <p className="mt-1 font-semibold">{order.client_reference || "-"}</p>
              </div>
              <div>
                <p className="text-xs font-bold tracking-wider text-[#818986] uppercase">
                  Job number
                </p>
                <p className="mt-1 font-semibold">{order.job_number || "-"}</p>
              </div>
              <div>
                <p className="text-xs font-bold tracking-wider text-[#818986] uppercase">Start</p>
                <p className="mt-1 font-semibold">{formatDate(order.start_date)}</p>
              </div>
              <div>
                <p className="text-xs font-bold tracking-wider text-[#818986] uppercase">Due</p>
                <p className="mt-1 font-semibold">{formatDate(order.completion_due_date)}</p>
              </div>
            </div>
            <div className="mt-6 grid gap-4 border-t border-[#ebe7df] pt-5 sm:grid-cols-2">
              <a
                href={mapsUrl(address)}
                target="_blank"
                rel="noreferrer"
                className="flex items-start gap-3 rounded-xl bg-[#f8f6f1] p-4 hover:bg-[#f0eee8]"
              >
                <MapPin className="mt-0.5 h-5 w-5 text-[#0077a8]" />
                <span>
                  <span className="block text-xs font-bold tracking-wider text-[#818986] uppercase">
                    Site
                  </span>
                  <span className="mt-1 block text-sm font-semibold">{address}</span>
                </span>
                <ExternalLink className="ml-auto h-4 w-4 text-[#87908d]" />
              </a>
              <div className="rounded-xl bg-[#f8f6f1] p-4">
                <p className="text-xs font-bold tracking-wider text-[#818986] uppercase">
                  Contacts
                </p>
                <p className="mt-1 text-sm font-semibold">
                  {order.site?.site_contact?.[0]?.name ?? order.customer?.name ?? "Not set"}
                </p>
                {(order.site?.site_contact?.[0]?.phone || order.customer?.phone) && (
                  <a
                    className="mt-1 inline-flex items-center gap-1.5 text-sm text-[#0077a8]"
                    href={`tel:${order.site?.site_contact?.[0]?.phone ?? order.customer?.phone}`}
                  >
                    <Phone className="h-3.5 w-3.5" />
                    {order.site?.site_contact?.[0]?.phone ?? order.customer?.phone}
                  </a>
                )}
              </div>
            </div>
            {order.additional_instructions && (
              <div className="mt-5 rounded-xl border-l-4 border-[#d59b4b] bg-[#fbf3e4] p-4">
                <p className="text-xs font-bold tracking-wider text-[#8b5d1f] uppercase">
                  Site instructions
                </p>
                <p className="mt-2 text-sm leading-6 whitespace-pre-wrap">
                  {order.additional_instructions}
                </p>
              </div>
            )}
          </Card>
          <Card className="overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#ebe7df] px-5 py-4 sm:px-6">
              <div>
                <h2 className="text-lg font-semibold">Jobs by trade</h2>
                <p className="text-sm text-[#77817e]">
                  {order.task.length} job{order.task.length === 1 ? "" : "s"} · {openTasks.length}{" "}
                  open
                </p>
              </div>
              {isActive && openTasks.length > 0 ? (
                <CompleteWorkOrderForm workOrderId={order.id} openJobs={openTasks.length} />
              ) : isCompleted ? (
                <Badge tone="green">All jobs complete</Badge>
              ) : (
                <Badge tone="teal">Operational scope</Badge>
              )}
            </div>
            {Object.entries(grouped).map(([trade, tasks]) => (
              <section key={trade}>
                <div className="border-b border-[#e6e2d9] bg-[#f5f3ee] px-5 py-3 text-sm font-bold text-[#3f4d49] sm:px-6">
                  {trade}
                </div>
                <div className="divide-y divide-[#ebe7df]">
                  {tasks.map((task) => (
                    <article key={task.id} className="p-5 sm:px-6">
                      <div className="flex flex-col justify-between gap-3 sm:flex-row">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="font-semibold">{task.description}</p>
                            {task.revised_since_viewed && <Badge tone="amber">Revised</Badge>}
                          </div>
                          <p className="mt-1 text-sm text-[#6d7774]">
                            {task.area_label && `${task.area_label} · `}
                            {task.quantity} {task.unit}
                          </p>
                          {(PER_JOB_ASSIGNMENT_ENABLED || differsFromCrew(task)) && (
                            <div className="mt-3 flex flex-wrap gap-2">
                              {liveWorkerIds(task).length ? (
                                task.assignment
                                  .filter((a) => a.status !== "reassigned")
                                  .map((assignment) => (
                                    <Badge
                                      key={assignment.id}
                                      tone={assignment.is_lead ? "teal" : "neutral"}
                                    >
                                      {assignment.worker?.user_profile?.display_name}
                                      {assignment.is_lead ? " · lead" : ""}
                                    </Badge>
                                  ))
                              ) : (
                                <Badge tone="amber">Unassigned</Badge>
                              )}
                            </div>
                          )}
                        </div>
                        <div className="flex shrink-0 flex-col items-start gap-2 sm:items-end">
                          <StatusBadge status={task.status} />
                          {!isCancelled && !CLOSED_TASK_STATUSES.includes(task.status) && (
                            <CompleteJobForm workOrderId={order.id} taskId={task.id} />
                          )}
                        </div>
                      </div>
                      {!(["completed", "cancelled"] as TaskStatus[]).includes(task.status) && (
                        <TaskEditForm
                          task={{
                            id: task.id,
                            description: task.description,
                            quantity: task.quantity,
                            unit: task.unit,
                            areaLabel: task.area_label,
                          }}
                        />
                      )}
                      {task.schedule_entry.length > 0 && (
                        <div className="mt-4 space-y-2">
                          <p className="text-xs font-bold tracking-wider text-[#818986] uppercase">
                            Scheduled dates
                          </p>
                          {task.schedule_entry.map((entry) => (
                            <div
                              key={entry.id}
                              className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-[#d8e3e1] bg-[#eef7fb] px-3 py-2.5"
                            >
                              <span className="flex items-center gap-2 text-sm font-semibold text-[#005b8b]">
                                <CalendarDays className="h-4 w-4" />
                                {formatDate(entry.planned_date, "d MMM yyyy")}
                                {entry.start_time ? ` at ${entry.start_time.slice(0, 5)}` : ""}
                                {entry.estimated_hours ? ` · ${entry.estimated_hours}h` : ""}
                              </span>
                              <UnscheduleEntryForm scheduleEntryId={entry.id} />
                            </div>
                          ))}
                        </div>
                      )}
                      {PER_JOB_ASSIGNMENT_ENABLED && (
                        <details className="mt-4 rounded-xl border border-[#e1ddd4] bg-[#faf9f6] p-3">
                          <summary className="cursor-pointer text-sm font-semibold text-[#0077a8]">
                            Schedule this task
                          </summary>
                          <div className="mt-3">
                            <ScheduleTaskForm
                              taskId={task.id}
                              workers={workers}
                              defaultWorkerId={
                                task.assignment.find((a) => a.is_lead && a.status !== "reassigned")
                                  ?.worker_id
                              }
                              today={today}
                            />
                          </div>
                        </details>
                      )}
                      {task.status === "completed" && (
                        <form action={reopenTask} className="mt-3 flex flex-col gap-2 sm:flex-row">
                          <input type="hidden" name="taskId" value={task.id} />
                          <input
                            name="reason"
                            required
                            placeholder="Reason for reopening"
                            className="min-h-11 min-w-0 flex-1 rounded-lg border border-[#d9d4c9] px-3 text-sm"
                          />
                          <button className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg border border-[#d9d4c9] px-3 text-sm font-semibold">
                            <RotateCcw className="h-3.5 w-3.5" />
                            Reopen
                          </button>
                        </form>
                      )}
                      {canDeleteJob(task) ? (
                        <DeleteJobForm taskId={task.id} />
                      ) : (
                        <p className="mt-3 text-xs text-[#89918e]">
                          This is the only job. To remove it, delete the whole work order.
                        </p>
                      )}
                    </article>
                  ))}
                </div>
              </section>
            ))}
            {!isCancelled && (
              <div className="border-t border-[#ebe7df] p-5 sm:px-6">
                <AddJobForm workOrderId={order.id} />
              </div>
            )}
          </Card>
        </div>
        <aside className="space-y-5">
          <Card className="p-5">
            <div className="mb-4 flex items-center gap-2">
              <Users className="h-5 w-5 text-[#0077a8]" />
              <h2 className="font-semibold">Crew</h2>
            </div>
            {crewIds.length ? (
              <ul className="mb-4 flex flex-wrap gap-2">
                {crewIds.map((workerId) => (
                  <li key={workerId}>
                    <Badge tone={workerId === order.lead_worker_id ? "teal" : "neutral"}>
                      {workerNameById.get(workerId) ?? `Worker ${workerId}`}
                      {workerId === order.lead_worker_id ? " · lead" : ""}
                    </Badge>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mb-4 text-sm text-[#77817e]">
                {isActive ? "No one is assigned yet." : "No one was assigned."}
              </p>
            )}
            {isActive ? (
              <WorkOrderCrewForm
                key={`${crewSignature}:${order.lead_worker_id ?? ""}:${order.schedule_entry.map((entry) => entry.id).join(",")}`}
                workOrderId={order.id}
                workers={workers}
                crewIds={crewIds}
                leadWorkerId={order.lead_worker_id}
                today={today}
              />
            ) : (
              <p className="text-sm text-[#77817e]">
                {isCompleted
                  ? "Reopen the work order to change its crew."
                  : "Cancelled orders cannot be assigned."}
              </p>
            )}
            {order.schedule_entry.length > 0 && (
              <div className="mt-5 border-t border-[#e8e4dc] pt-4">
                <p className="mb-2 text-xs font-bold tracking-wider text-[#818986] uppercase">
                  Whole-order dates
                </p>
                <div className="space-y-2">
                  {order.schedule_entry.map((entry) => (
                    <div
                      key={entry.id}
                      className="flex items-start justify-between gap-2 rounded-xl bg-[#eef7fb] px-3 py-2"
                    >
                      <span className="text-xs font-semibold text-[#005b8b]">
                        {formatDate(entry.planned_date, "d MMM yyyy")} ·{" "}
                        {workers.find((worker) => worker.id === entry.worker_id)?.name ??
                          "Unassigned"}
                      </span>
                      <UnscheduleEntryForm scheduleEntryId={entry.id} />
                    </div>
                  ))}
                </div>
              </div>
            )}
          </Card>
          {isCompleted && (
            <Card className="p-5">
              <div className="mb-3 flex items-center gap-2">
                <Archive className="h-5 w-5 text-[#2f6249]" />
                <h2 className="font-semibold">Completed</h2>
              </div>
              <ReopenWorkOrderForm workOrderId={order.id} />
            </Card>
          )}
          <Card className="overflow-hidden">
            <div className="border-b border-[#e7e3da] bg-[#003f70] px-5 py-4 text-white">
              <div className="flex items-center gap-2">
                <ShieldCheck className="h-5 w-5 text-[#ffad58]" />
                <h2 className="font-semibold">Manager-only total cost</h2>
              </div>
            </div>
            <div className="flex justify-between p-5 text-base">
              <span className="font-bold">Work order total</span>
              <span className="font-mono font-bold text-[#24575d]">
                {formatMoney(order.work_order_totals?.total_cents)}
              </span>
            </div>
          </Card>
          <Card className="p-5">
            <div className="flex items-center gap-2">
              <FileText className="h-5 w-5 text-[#0077a8]" />
              <h2 className="font-semibold">Original document</h2>
            </div>
            {order.attachment.filter((a) => !a.deleted_at).length ? (
              order.attachment
                .filter((a) => !a.deleted_at)
                .map((file) => (
                  <a
                    key={file.id}
                    href={`/api/attachments/${file.id}`}
                    className="mt-3 block rounded-xl border border-[#d9d4c9] p-3 text-sm font-semibold hover:bg-[#f8f6f1]"
                  >
                    Open manager-only PDF
                  </a>
                ))
            ) : (
              <p className="mt-2 text-sm text-[#77817e]">Manual-entry order. No PDF stored.</p>
            )}
          </Card>
          {order.status !== "cancelled" && order.status !== "signed_off" && (
            <Card className="p-5">
              <details>
                <summary className="cursor-pointer text-sm font-semibold text-[#913a31]">
                  Cancel work order
                </summary>
                <form action={cancelWorkOrder} className="mt-3 space-y-2">
                  <input type="hidden" name="workOrderId" value={order.id} />
                  <textarea
                    name="reason"
                    required
                    placeholder="Cancellation reason"
                    className="min-h-24 w-full rounded-xl border border-[#d9d4c9] p-3 text-sm"
                  />
                  <button className="min-h-10 w-full rounded-lg bg-[#a33a32] px-3 text-sm font-semibold text-white">
                    Cancel order
                  </button>
                </form>
              </details>
            </Card>
          )}
          <Card className="p-5">
            <DeleteWorkOrderForm workOrderId={order.id} workOrderNumber={order.work_order_number} />
          </Card>
        </aside>
      </div>
    </>
  );
}
