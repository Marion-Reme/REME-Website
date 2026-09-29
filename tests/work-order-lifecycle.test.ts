import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { workOrderDetailsInputSchema } from "@/lib/domain";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const flat = (path: string) => read(path).replace(/\s+/g, " ");

const sql = flat("supabase/migrations/0025_work_order_lifecycle.sql");
const actions = flat("src/actions/work-orders.ts");
const detail = read("src/app/manager/work-orders/[id]/page.tsx");
const list = read("src/app/manager/work-orders/page.tsx");

// The body of one plpgsql function, from its create statement to the next one.
function sqlFunction(name: string) {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  expect(start).toBeGreaterThanOrEqual(0);
  const next = sql.indexOf("create or replace function", start + 1);
  return sql.slice(start, next === -1 ? undefined : next);
}

// The body of one server action, up to the next export.
function action(name: string) {
  const start = actions.indexOf(`export async function ${name}(`);
  expect(start).toBeGreaterThanOrEqual(0);
  const next = actions.indexOf("export async function", start + 1);
  return actions.slice(start, next === -1 ? undefined : next);
}

const lifecycleFunctions = [
  "delete_task",
  "add_work_order_task",
  "update_work_order_details",
  "delete_work_order",
  "complete_work_order_tasks",
  "reopen_work_order",
  "assign_work_order_crew",
];

describe("work order lifecycle functions", () => {
  it.each(lifecycleFunctions)("%s is manager-only and tenant-scoped", (name) => {
    const body = sqlFunction(name);
    expect(body).toContain("if not public.is_manager() then raise exception 'Forbidden'");
    expect(body).toContain("tenant_key uuid := public.current_tenant_id()");
    expect(body).toMatch(/tenant_id = tenant_key/);
    expect(body).toContain("security definer set search_path = ''");
  });

  it.each(lifecycleFunctions)("%s is granted to signed-in users only", (name) => {
    expect(sql).toMatch(
      new RegExp(`revoke all on function public\\.${name}\\([^)]*\\) from public`),
    );
    expect(sql).toMatch(
      new RegExp(`grant execute on function public\\.${name}\\([^)]*\\) to authenticated`),
    );
  });

  it("keeps the notification helper internal", () => {
    expect(sql).toContain(
      "revoke all on function public.notify_workers(uuid, bigint[], text, text, text, text, text) from public",
    );
    expect(sql).not.toMatch(/grant execute on function public\.notify_workers/);
  });

  it("never puts amounts in a worker notification", () => {
    // Call sites only, not the helper's own definition.
    const calls = sql.split(/(?:perform|:=) public\.notify_workers\(/).slice(1);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.slice(0, call.indexOf(");"))).not.toMatch(/total|cents|\$/i);
    }
  });

  it("refuses to delete the last job and returns files for storage cleanup", () => {
    const body = sqlFunction("delete_task");
    expect(body).toContain(
      "A work order needs at least one job. Delete the whole work order instead.",
    );
    expect(body).toContain("'storageKeys', to_jsonb(storage_keys)");
    expect(body).toContain("perform public.recompute_work_order_status(task_row.work_order_id)");
    expect(body).toContain("'task.deleted'");
  });

  it("requires the order number before deleting a whole order", () => {
    const body = sqlFunction("delete_work_order");
    expect(body).toContain(
      "lower(trim(coalesce(p_confirmation, ''))) <> lower(trim(order_row.work_order_number))",
    );
    expect(body).toContain("'work_order.deleted'");
    expect(body.indexOf("delete from public.assignment")).toBeLessThan(
      body.indexOf("delete from public.work_order where"),
    );
  });

  it("completes one job or every open job, approving pending submissions", () => {
    const body = sqlFunction("complete_work_order_tasks");
    expect(body).toContain("(p_task_ids is null or t.id = any(p_task_ids))");
    expect(body).toContain("set status = 'approved'");
    expect(body).toContain("set status = 'completed', completed_at = now()");
  });

  it("records when an order is completed", () => {
    expect(sql).toContain(
      "alter table public.work_order add column if not exists completed_at timestamptz",
    );
    expect(sql).toContain("before update of status on public.work_order");
  });

  it("assigns the whole crew in one insert with optional days", () => {
    const body = sqlFunction("assign_work_order_crew");
    expect(body).toContain("cross join unnest(crew) as member(id)");
    expect(body).toContain("p_dates date[] default null");
    expect(body).toContain("Choose the lead from the selected workers");
    expect(body).toContain("Reopen the work order before changing its crew");
  });
});

describe("work order lifecycle actions", () => {
  it.each([
    ["assignWorkOrderCrew", "assign_work_order_crew"],
    ["updateWorkOrderDetails", "update_work_order_details"],
    ["addWorkOrderTask", "add_work_order_task"],
    ["deleteTask", "delete_task"],
    ["deleteWorkOrder", "delete_work_order"],
    ["completeWorkOrderTasks", "complete_work_order_tasks"],
    ["reopenWorkOrder", "reopen_work_order"],
  ])("%s authorises the manager and calls %s", (name, rpc) => {
    const body = action(name);
    expect(body).toContain('await assertRole("manager")');
    expect(body).toContain(`supabase.rpc("${rpc}"`);
    expect(body).toContain("actionError(");
  });

  it("removes stored files after both deletes", () => {
    expect(action("deleteTask")).toContain("removeStoredFiles(");
    expect(action("deleteWorkOrder")).toContain("removeStoredFiles(");
  });

  it("treats work days as optional when assigning a crew", () => {
    const body = action("assignWorkOrderCrew");
    expect(body).toContain('formData.getAll("workerIds")');
    expect(body).toContain("const dates = rawDates ? parseScheduleDates(rawDates) : null");
  });

  it("no longer offers the single-worker whole-order assign", () => {
    expect(actions).not.toContain("export async function assignWholeOrder");
  });
});

describe("work order details validation", () => {
  const valid = {
    clientName: "Bentino Pty Ltd",
    customerName: "",
    customerPhone: "",
    streetAddress: "4 Irwan St",
    suburb: "Saratoga",
    state: "nsw",
    postcode: "2251",
    siteContactName: "",
    siteContactPhone: "",
    workOrderNumber: "20299-29572",
    jobNumber: "",
    clientReference: "",
    supervisorName: "",
    supervisorPhone: "",
    issuedAt: "2026-09-01",
    startDate: "",
    dueDate: "2026-10-15",
    notes: "",
    additionalInstructions: "",
    totalCents: "150000",
    duplicateReason: "",
  };

  it("accepts a header without any task list", () => {
    const parsed = workOrderDetailsInputSchema.parse(valid);
    expect(parsed.state).toBe("NSW");
    expect(parsed.totalCents).toBe(150000);
    expect("tasks" in parsed).toBe(false);
  });

  it("rejects an impossible date", () => {
    expect(workOrderDetailsInputSchema.safeParse({ ...valid, dueDate: "2026-02-30" }).success).toBe(
      false,
    );
  });

  it("still requires a total", () => {
    expect(workOrderDetailsInputSchema.safeParse({ ...valid, totalCents: "" }).success).toBe(false);
  });
});

describe("work order screens", () => {
  it("switches per-job assignment off behind one flag", () => {
    expect(detail).toContain("const PER_JOB_ASSIGNMENT_ENABLED = false;");
    expect(detail.replace(/\s+/g, " ")).toContain("{PER_JOB_ASSIGNMENT_ENABLED && ( <details");
  });

  it("offers crew assignment, completion, reopening and deletion on the order", () => {
    for (const component of [
      "<WorkOrderCrewForm",
      "<CompleteJobForm",
      "<DeleteJobForm",
      "<AddJobForm",
      "<CompleteWorkOrderForm",
      "<ReopenWorkOrderForm",
      "<DeleteWorkOrderForm",
    ])
      expect(detail).toContain(component);
    expect(detail).toContain("/manager/work-orders/${order.id}/edit");
    expect(detail).not.toContain("WholeOrderAssignmentForm");
  });

  it("disables the order delete until the number is typed", () => {
    const form = read("src/components/work-order-actions.tsx");
    expect(form).toContain('name="confirmation"');
    expect(form).toContain("<fieldset disabled={!matches}");
  });

  it("archives completed orders in their own tab", () => {
    expect(list).toContain('completed: { label: "Completed"');
    expect(list).toContain('.in("status", ["signed_off", "completed"])');
    expect(list).toContain('request.not("status", "in", "(signed_off,completed,cancelled)")');
  });
});
