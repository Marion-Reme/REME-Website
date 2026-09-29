"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { assertRole } from "@/lib/auth";
import {
  parseScheduleDates,
  taskDetailsInputSchema,
  taskInputSchema,
  workOrderDetailsInputSchema,
  workOrderInputSchema,
} from "@/lib/domain";
import { deleteObjects } from "@/lib/r2";
import { logger } from "@/lib/redact";
import { createClient } from "@/lib/supabase/server";
import { actionError, throwActionError } from "@/actions/errors";
import type { ActionState } from "@/actions/types";

const WORK_ORDER_HEADER_FIELDS = [
  "clientName",
  "customerName",
  "customerPhone",
  "streetAddress",
  "suburb",
  "state",
  "postcode",
  "siteContactName",
  "siteContactPhone",
  "workOrderNumber",
  "jobNumber",
  "clientReference",
  "supervisorName",
  "supervisorPhone",
  "issuedAt",
  "startDate",
  "dueDate",
  "notes",
  "additionalInstructions",
  "totalCents",
  "duplicateReason",
] as const;

// Creating and editing an order read the same header fields from the form.
function readWorkOrderHeader(formData: FormData) {
  return Object.fromEntries(WORK_ORDER_HEADER_FIELDS.map((field) => [field, formData.get(field)]));
}

// Every page that lists or counts work orders, for the lifecycle actions below.
function revalidateWorkOrderViews(workOrderId?: number | null) {
  if (workOrderId) revalidatePath(`/manager/work-orders/${workOrderId}`);
  for (const path of [
    "/manager",
    "/manager/work-orders",
    "/manager/calendar",
    "/manager/review",
    "/worker",
    "/worker/jobs",
    "/worker/upcoming",
    "/worker/history",
  ])
    revalidatePath(path);
}

// Deletes the R2 objects behind files a delete RPC removed. The database rows are
// already gone when this runs, so a failure only leaves orphaned objects in the
// private bucket. It is logged, and never reported as a failed delete.
async function removeStoredFiles(scope: string, storageKeys: unknown) {
  const keys = Array.isArray(storageKeys)
    ? storageKeys.filter((key): key is string => typeof key === "string" && key.length > 0)
    : [];
  if (!keys.length) return;
  try {
    const failed = await deleteObjects(keys);
    if (failed.length) logger.error(`${scope}.storage_cleanup_failed`, { failed: failed.length });
  } catch (error) {
    logger.error(`${scope}.storage_cleanup_failed`, error);
  }
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

export async function createWorkOrder(_: ActionState, formData: FormData): Promise<ActionState> {
  await assertRole("manager");
  let tasks: unknown = [];
  try {
    tasks = JSON.parse(String(formData.get("tasks") ?? "[]"));
  } catch {
    return { error: "The task list could not be read." };
  }
  const parsed = workOrderInputSchema.safeParse({ ...readWorkOrderHeader(formData), tasks });
  if (!parsed.success)
    return {
      error: "Check the highlighted information and try again.",
      fieldErrors: z.flattenError(parsed.error).fieldErrors,
    };
  const payload = {
    ...parsed.data,
    subtotalCents: parsed.data.totalCents,
    gstRate: 0,
    gstCents: 0,
    totalOverride: true,
  };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("create_work_order_bundle", { p_payload: payload });
  if (error) {
    logger.error("work_order.create_failed", error);
    const duplicate = error.message.toLowerCase().includes("duplicate");
    return {
      error: duplicate
        ? "A work order with that number or client reference already exists. Add a duplicate reason if this is intentional."
        : "The work order could not be saved.",
    };
  }
  revalidatePath("/manager");
  revalidatePath("/manager/work-orders");
  redirect(`/manager/work-orders/${data}`);
}

export async function updateTaskDetails(_: ActionState, formData: FormData): Promise<ActionState> {
  await assertRole("manager");
  const taskId = Number(formData.get("taskId"));
  if (!Number.isInteger(taskId) || taskId < 1) return { error: "The task is invalid." };
  const parsed = taskDetailsInputSchema.safeParse({
    description: formData.get("description"),
    area: formData.get("area"),
    quantity: formData.get("quantity"),
    unit: formData.get("unit"),
  });
  if (!parsed.success)
    return {
      error: "Check the task details and try again.",
      fieldErrors: z.flattenError(parsed.error).fieldErrors,
    };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("update_task_details", {
    p_task_id: taskId,
    p_description: parsed.data.description,
    p_quantity: parsed.data.quantity,
    p_unit: parsed.data.unit,
    p_area_label: parsed.data.area || null,
  });
  if (error) {
    if (error.message.includes("Completed or cancelled"))
      return {
        error: "Reopen completed work before editing it. Cancelled tasks cannot be edited.",
      };
    logger.error("task.update_failed", error);
    return { error: "The task could not be updated." };
  }
  const result = data as {
    changed?: boolean;
    workOrderId?: number;
    notifiedWorkers?: number;
  } | null;
  if (result?.workOrderId) revalidatePath(`/manager/work-orders/${result.workOrderId}`);
  revalidatePath("/manager/work-orders");
  revalidatePath("/manager/calendar");
  revalidatePath("/manager");
  revalidatePath("/worker");
  revalidatePath("/worker/jobs");
  revalidatePath(`/worker/tasks/${taskId}`);
  return {
    ok: true,
    message: result?.changed
      ? `Task updated${result.notifiedWorkers ? ` and ${result.notifiedWorkers} assigned worker${result.notifiedWorkers === 1 ? " was" : "s were"} notified` : ""}.`
      : "No task details changed.",
  };
}

// Assigns every open job on the order to the chosen workers at once. Work days
// are optional; leaving them empty keeps the plan the order already has.
export async function assignWorkOrderCrew(
  _: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await assertRole("manager");
  const workOrderId = Number(formData.get("workOrderId"));
  if (!Number.isInteger(workOrderId) || workOrderId < 1)
    return { error: "The work order is invalid." };
  const clear = formData.get("intent") === "clear";
  const workerIds = clear
    ? []
    : [...new Set(formData.getAll("workerIds").map(Number))].filter(
        (id) => Number.isInteger(id) && id > 0,
      );
  if (!clear && !workerIds.length) return { error: "Choose at least one worker." };
  const chosenLead = Number(formData.get("leadWorkerId"));
  const leadWorkerId = clear
    ? null
    : workerIds.includes(chosenLead)
      ? chosenLead
      : (workerIds[0] ?? null);
  const rawDates = clear ? "" : String(formData.get("dates") ?? "").trim();
  const dates = rawDates ? parseScheduleDates(rawDates) : null;
  if (rawDates && !dates) return { error: "Choose between 1 and 62 valid work dates." };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("assign_work_order_crew", {
    p_work_order_id: workOrderId,
    p_worker_ids: workerIds,
    p_lead_worker_id: leadWorkerId,
    p_dates: dates,
  });
  if (error) return actionError("work_order.assign_crew", error);
  const result = data as {
    crewSize?: number;
    addedWorkers?: number;
    removedWorkers?: number;
    assignedTasks?: number;
    scheduledDays?: number;
  } | null;
  revalidateWorkOrderViews(workOrderId);
  if (clear) return { ok: true, message: "Everyone was unassigned from this work order." };
  const scheduledDays = result?.scheduledDays ?? 0;
  return {
    ok: true,
    message: `${plural(result?.crewSize ?? workerIds.length, "worker")} assigned to all ${plural(result?.assignedTasks ?? 0, "open job")}${scheduledDays ? ` and booked on ${plural(scheduledDays, "day")}` : ""}.`,
  };
}

export async function assignTask(_: ActionState, formData: FormData): Promise<ActionState> {
  await assertRole("manager");
  const taskId = Number(formData.get("taskId"));
  const workerIds = formData.getAll("workerIds").map(Number).filter(Number.isInteger);
  const leadWorkerId = Number(formData.get("leadWorkerId"));
  if (!taskId || !workerIds.length || !leadWorkerId)
    return { error: "Choose at least one worker and a lead." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("assign_task", {
    p_task_id: taskId,
    p_worker_ids: workerIds,
    p_lead_worker_id: leadWorkerId,
  });
  if (error) return actionError("task.assign", error);
  revalidatePath("/manager/work-orders");
  revalidatePath("/manager");
  return { ok: true, message: "Task assignment updated." };
}

export async function scheduleTask(_: ActionState, formData: FormData): Promise<ActionState> {
  await assertRole("manager");
  const taskId = Number(formData.get("taskId"));
  const workerId = Number(formData.get("workerId"));
  const dates = parseScheduleDates(String(formData.get("dates") ?? ""));
  if (!Number.isInteger(taskId) || taskId < 1 || !Number.isInteger(workerId) || workerId < 1)
    return { error: "Choose a worker." };
  if (!dates) return { error: "Choose between 1 and 62 valid schedule dates." };
  const supabase = await createClient();
  const { data: task, error: taskError } = await supabase
    .from("task")
    .select("work_order_id")
    .eq("id", taskId)
    .single();
  if (taskError || !task) return { error: "The task could not be found." };
  const { error } = await supabase.rpc("schedule_task", {
    p_task_id: taskId,
    p_worker_id: workerId,
    p_dates: dates,
    p_start_time: String(formData.get("startTime") ?? "") || null,
    p_estimated_hours: Number(formData.get("estimatedHours")) || null,
  });
  if (error) return actionError("task.schedule", error);
  revalidatePath(`/manager/work-orders/${task.work_order_id}`);
  revalidatePath("/manager/calendar");
  revalidatePath("/manager/work-orders");
  revalidatePath("/worker");
  revalidatePath("/worker/upcoming");
  return { ok: true, message: dates.length > 1 ? "Multi-day schedule saved." : "Task scheduled." };
}

export async function unscheduleEntry(_: ActionState, formData: FormData): Promise<ActionState> {
  await assertRole("manager");
  const scheduleEntryId = Number(formData.get("scheduleEntryId"));
  // Removing one date is a routine planning correction, so it takes a single
  // press. A reason is still accepted if a caller sends one.
  const reason = String(formData.get("reason") ?? "").trim();
  if (!Number.isInteger(scheduleEntryId) || scheduleEntryId < 1)
    return { error: "The scheduled date is invalid." };
  if (reason.length > 500) return { error: "A reason must be 500 characters or fewer." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("unschedule_entry", {
    p_schedule_entry_id: scheduleEntryId,
    p_reason: reason || null,
  });
  if (error) return actionError("schedule_entry.unschedule", error);
  revalidatePath("/manager/calendar");
  revalidatePath("/manager/work-orders");
  revalidatePath("/worker");
  revalidatePath("/worker/upcoming");
  return { ok: true, message: "Scheduled date removed and the worker was notified." };
}

export async function unassignTask(_: ActionState, formData: FormData): Promise<ActionState> {
  await assertRole("manager");
  const taskId = Number(formData.get("taskId"));
  const reason = String(formData.get("reason") ?? "").trim();
  if (!Number.isInteger(taskId) || taskId < 1) return { error: "The task is invalid." };
  if (reason.length < 2 || reason.length > 500)
    return { error: "Enter a reason between 2 and 500 characters." };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("unassign_task", {
    p_task_id: taskId,
    p_reason: reason,
  });
  if (error) return actionError("task.unassign", error);
  const result = data as {
    workOrderId?: number;
    unassignedWorkers?: number;
    removedScheduleEntries?: number;
  } | null;
  if (result?.workOrderId) revalidatePath(`/manager/work-orders/${result.workOrderId}`);
  revalidatePath("/manager/calendar");
  revalidatePath("/manager/work-orders");
  revalidatePath("/manager");
  revalidatePath("/worker");
  revalidatePath("/worker/jobs");
  revalidatePath("/worker/upcoming");
  const clearedDates = result?.removedScheduleEntries ?? 0;
  return {
    ok: true,
    message: `Task unassigned from ${result?.unassignedWorkers ?? 0} worker${result?.unassignedWorkers === 1 ? "" : "s"}${clearedDates ? ` and ${clearedDates} scheduled date${clearedDates === 1 ? "" : "s"} cleared` : ""}.`,
  };
}

export async function unassignAllUnscheduled(
  _: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await assertRole("manager");
  const reason = String(formData.get("reason") ?? "").trim();
  if (reason.length < 2 || reason.length > 500)
    return { error: "Enter a reason between 2 and 500 characters." };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("unassign_all_unscheduled_tasks", {
    p_reason: reason,
  });
  if (error) return actionError("task.bulk_unassign", error);
  const result = data as {
    unassignedTasks?: number;
    affectedWorkers?: number;
    removedAssignments?: number;
    removedScheduleEntries?: number;
  } | null;
  revalidatePath("/manager/calendar");
  revalidatePath("/manager/work-orders");
  revalidatePath("/manager");
  revalidatePath("/worker");
  revalidatePath("/worker/jobs");
  revalidatePath("/worker/upcoming");
  const unassigned = result?.unassignedTasks ?? 0;
  const clearedDates = result?.removedScheduleEntries ?? 0;
  return {
    ok: true,
    message:
      unassigned > 0
        ? `${unassigned} ${unassigned === 1 ? "job" : "jobs"} moved to Unassigned jobs across ${result?.affectedWorkers ?? 0} worker${result?.affectedWorkers === 1 ? "" : "s"}${clearedDates ? `, and ${clearedDates} leftover scheduled date${clearedDates === 1 ? "" : "s"} cleared` : ""}.`
        : "There were no assigned, unscheduled jobs to unassign.",
  };
}

// Backs the Unschedule all button on the calendar's Scheduled queue. Assignments
// survive, so the jobs land in Assigned but unscheduled rather than becoming
// unassigned work.
export async function unscheduleAllUpcoming(
  _: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await assertRole("manager");
  const reason = String(formData.get("reason") ?? "").trim();
  if (reason.length < 2 || reason.length > 500)
    return { error: "Enter a reason between 2 and 500 characters." };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("unschedule_all_upcoming", { p_reason: reason });
  if (error) return actionError("schedule_entry.unschedule_all", error);
  const result = data as { removedEntries?: number; affectedWorkers?: number } | null;
  revalidatePath("/manager/calendar");
  revalidatePath("/manager/work-orders");
  revalidatePath("/manager");
  revalidatePath("/worker");
  revalidatePath("/worker/jobs");
  revalidatePath("/worker/upcoming");
  const removed = result?.removedEntries ?? 0;
  return {
    ok: true,
    message:
      removed > 0
        ? `${removed} upcoming schedule ${removed === 1 ? "entry" : "entries"} removed across ${result?.affectedWorkers ?? 0} worker${result?.affectedWorkers === 1 ? "" : "s"}. The jobs are now in Assigned but unscheduled.`
        : "There were no upcoming schedules to remove.",
  };
}

export async function cancelWorkOrder(formData: FormData) {
  await assertRole("manager");
  const workOrderId = Number(formData.get("workOrderId"));
  const reason = String(formData.get("reason") ?? "").trim();
  if (!workOrderId || !reason) throw new Error("A cancellation reason is required");
  const supabase = await createClient();
  // The RPC cancels the order's active tasks, clears their upcoming schedule
  // entries and notifies each affected worker once. Updating work_order alone
  // left every task assigned and startable on workers' phones.
  const { error } = await supabase.rpc("cancel_work_order", {
    p_work_order_id: workOrderId,
    p_reason: reason,
  });
  if (error) {
    logger.error("work_order.cancel_failed", error);
    throw new Error("Could not cancel work order");
  }
  revalidatePath("/manager/work-orders");
  revalidatePath("/manager");
  revalidatePath("/manager/calendar");
  revalidatePath("/worker");
  revalidatePath("/worker/jobs");
  revalidatePath("/worker/upcoming");
  redirect("/manager/work-orders");
}

export async function reopenTask(formData: FormData) {
  // One authorisation check. This previously called assertRole three times, so a
  // single click cost three round-trips for the same answer.
  const profile = await assertRole("manager");
  const taskId = Number(formData.get("taskId"));
  const reason = String(formData.get("reason") ?? "").trim();
  if (!Number.isInteger(taskId) || taskId < 1) throw new Error("The task is invalid");
  if (reason.length < 2 || reason.length > 500) {
    throw new Error("Enter a reason between 2 and 500 characters");
  }
  const supabase = await createClient();
  const { error } = await supabase
    .from("task")
    .update({ status: "changes_requested", completed_at: null, revised_since_viewed: true })
    .eq("id", taskId)
    .eq("tenant_id", profile.tenant_id);
  if (error) throwActionError("task.reopen", error, "Could not reopen task");

  // The reason is the worker's only explanation for the reopen, so a failure here
  // is worth recording even though it should not fail the action.
  const { error: noteError } = await supabase.from("note").insert({
    tenant_id: profile.tenant_id,
    parent_type: "task",
    parent_id: taskId,
    author_user_id: profile.id,
    body: reason,
    visibility: "worker_visible",
    note_type: "problem",
  });
  if (noteError) logger.error("task.reopen_note_failed", noteError);

  revalidatePath("/manager/work-orders");
  revalidatePath("/manager/review");
  revalidatePath(`/worker/tasks/${taskId}`);
}

export async function updateWorkOrderDetails(
  _: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await assertRole("manager");
  const workOrderId = Number(formData.get("workOrderId"));
  if (!Number.isInteger(workOrderId) || workOrderId < 1)
    return { error: "The work order is invalid." };
  const parsed = workOrderDetailsInputSchema.safeParse(readWorkOrderHeader(formData));
  if (!parsed.success)
    return {
      error: "Check the highlighted information and try again.",
      fieldErrors: z.flattenError(parsed.error).fieldErrors,
    };
  const supabase = await createClient();
  const { error } = await supabase.rpc("update_work_order_details", {
    p_work_order_id: workOrderId,
    p_payload: parsed.data,
  });
  if (error) return actionError("work_order.update_details", error);
  revalidateWorkOrderViews(workOrderId);
  redirect(`/manager/work-orders/${workOrderId}?notice=saved`);
}

export async function addWorkOrderTask(_: ActionState, formData: FormData): Promise<ActionState> {
  await assertRole("manager");
  const workOrderId = Number(formData.get("workOrderId"));
  if (!Number.isInteger(workOrderId) || workOrderId < 1)
    return { error: "The work order is invalid." };
  const parsed = taskInputSchema.safeParse({
    trade: formData.get("trade"),
    area: formData.get("area"),
    description: formData.get("description"),
    quantity: formData.get("quantity"),
    unit: formData.get("unit"),
  });
  if (!parsed.success)
    return {
      error: "Check the job details and try again.",
      fieldErrors: z.flattenError(parsed.error).fieldErrors,
    };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("add_work_order_task", {
    p_work_order_id: workOrderId,
    p_trade: parsed.data.trade,
    p_description: parsed.data.description,
    p_quantity: parsed.data.quantity,
    p_unit: parsed.data.unit,
    p_area_label: parsed.data.area || null,
  });
  if (error) return actionError("task.add", error);
  const assigned = (data as { assignedWorkers?: number } | null)?.assignedWorkers ?? 0;
  revalidateWorkOrderViews(workOrderId);
  return {
    ok: true,
    message: `Job added${assigned ? ` and assigned to the crew of ${assigned}` : ""}.`,
  };
}

// Permanent. The confirmation step lives in the form; the RPC refuses to remove
// the last job, since an order with no jobs should be deleted as a whole.
export async function deleteTask(_: ActionState, formData: FormData): Promise<ActionState> {
  await assertRole("manager");
  const taskId = Number(formData.get("taskId"));
  if (!Number.isInteger(taskId) || taskId < 1) return { error: "The job is invalid." };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("delete_task", { p_task_id: taskId });
  if (error) return actionError("task.delete", error);
  const result = data as {
    workOrderId?: number;
    notifiedWorkers?: number;
    storageKeys?: unknown;
  } | null;
  await removeStoredFiles("task.delete", result?.storageKeys);
  revalidateWorkOrderViews(result?.workOrderId);
  revalidatePath(`/worker/tasks/${taskId}`);
  const notified = result?.notifiedWorkers ?? 0;
  return {
    ok: true,
    message: `Job deleted${notified ? ` and ${plural(notified, "worker")} notified` : ""}.`,
  };
}

// Permanent. The manager must type the order number, and the RPC checks it again.
export async function deleteWorkOrder(_: ActionState, formData: FormData): Promise<ActionState> {
  await assertRole("manager");
  const workOrderId = Number(formData.get("workOrderId"));
  const confirmation = String(formData.get("confirmation") ?? "").trim();
  if (!Number.isInteger(workOrderId) || workOrderId < 1)
    return { error: "The work order is invalid." };
  if (!confirmation) return { error: "Type the work order number to confirm the deletion." };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("delete_work_order", {
    p_work_order_id: workOrderId,
    p_confirmation: confirmation,
  });
  if (error) return actionError("work_order.delete", error);
  await removeStoredFiles(
    "work_order.delete",
    (data as { storageKeys?: unknown } | null)?.storageKeys,
  );
  revalidateWorkOrderViews();
  redirect("/manager/work-orders?notice=deleted");
}

// Marks one job complete when a taskId is sent, otherwise every open job on the
// order. A fully complete order moves to the Completed tab.
export async function completeWorkOrderTasks(
  _: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await assertRole("manager");
  const workOrderId = Number(formData.get("workOrderId"));
  const rawTaskId = String(formData.get("taskId") ?? "");
  const taskId = rawTaskId ? Number(rawTaskId) : null;
  if (!Number.isInteger(workOrderId) || workOrderId < 1)
    return { error: "The work order is invalid." };
  if (taskId !== null && (!Number.isInteger(taskId) || taskId < 1))
    return { error: "The job is invalid." };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("complete_work_order_tasks", {
    p_work_order_id: workOrderId,
    p_task_ids: taskId === null ? null : [taskId],
  });
  if (error) return actionError("work_order.complete", error);
  const result = data as {
    completedTasks?: number;
    workOrderStatus?: string;
    approvedSubmissions?: number;
  } | null;
  revalidateWorkOrderViews(workOrderId);
  if (taskId !== null) revalidatePath(`/worker/tasks/${taskId}`);
  const completed = result?.completedTasks ?? 0;
  if (!completed) return { ok: true, message: "There were no open jobs left to complete." };
  const archived = result?.workOrderStatus === "signed_off";
  return {
    ok: true,
    message:
      taskId === null
        ? "Work order completed and moved to the Completed tab."
        : archived
          ? "Job completed. That was the last open job, so the work order moved to the Completed tab."
          : "Job marked complete.",
  };
}

export async function reopenWorkOrder(_: ActionState, formData: FormData): Promise<ActionState> {
  await assertRole("manager");
  const workOrderId = Number(formData.get("workOrderId"));
  const reason = String(formData.get("reason") ?? "").trim();
  if (!Number.isInteger(workOrderId) || workOrderId < 1)
    return { error: "The work order is invalid." };
  if (reason.length > 500) return { error: "A reason must be 500 characters or fewer." };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("reopen_work_order", {
    p_work_order_id: workOrderId,
    p_reason: reason || null,
  });
  if (error) return actionError("work_order.reopen", error);
  const reopened = (data as { reopenedTasks?: number } | null)?.reopenedTasks ?? 0;
  revalidateWorkOrderViews(workOrderId);
  return {
    ok: true,
    message: `Work order reopened with ${plural(reopened, "job")} back in active work.`,
  };
}
