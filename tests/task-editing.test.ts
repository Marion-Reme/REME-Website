import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { taskDetailsInputSchema } from "@/lib/domain";

const source = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

describe("manager task editing", () => {
  it("validates the operational task fields without accepting pricing", () => {
    expect(
      taskDetailsInputSchema.parse({
        description: "Remove and replace cornices",
        area: "Lounge",
        quantity: "4.5",
        unit: "lm",
      }),
    ).toEqual({
      description: "Remove and replace cornices",
      area: "Lounge",
      quantity: 4.5,
      unit: "lm",
    });
    expect(
      taskDetailsInputSchema.safeParse({ description: "x", area: "", quantity: 0, unit: "dollars" })
        .success,
    ).toBe(false);
    expect(Object.keys(taskDetailsInputSchema.shape)).toEqual([
      "area",
      "description",
      "quantity",
      "unit",
    ]);
  });

  it("renders an edit form for active tasks inside the work order", () => {
    const page = source("src/app/manager/work-orders/[id]/page.tsx");
    const form = source("src/components/task-edit-form.tsx");
    expect(page).toContain("<TaskEditForm");
    expect(page).toContain('["completed", "cancelled"]');
    expect(form).toContain("Edit task");
    expect(form).toContain('name="description"');
    expect(form).toContain('name="area"');
    expect(form).toContain('name="quantity"');
    expect(form).toContain('name="unit"');
    expect(form).not.toMatch(/price|rate|cost/i);
  });

  it("uses a guarded server action and transactional RPC", () => {
    const actions = source("src/actions/work-orders.ts");
    expect(actions).toContain("export async function updateTaskDetails");
    const start = actions.indexOf("export async function updateTaskDetails");
    const end = actions.indexOf("export async function", start + 1);
    const updateAction = actions.slice(start, end);
    expect(updateAction).toContain('assertRole("manager")');
    expect(updateAction).toContain('supabase.rpc("update_task_details"');
    expect(updateAction).toContain("taskDetailsInputSchema.safeParse");
  });

  it("tenant-scopes changes, protects terminal work and records worker-safe notices", () => {
    const migration = source("supabase/migrations/0018_update_task_details.sql");
    expect(migration).toContain("if not public.is_manager()");
    expect(migration).toContain("t.id = p_task_id and t.tenant_id = tenant_key");
    expect(migration).toContain("for update of t");
    expect(migration).toContain("task_row.status in ('completed','cancelled')");
    expect(migration).toContain("revised_since_viewed = true");
    expect(migration).toContain("task.details_updated");
    expect(migration).toContain("a.status <> 'reassigned'");
    expect(migration).toContain("select distinct w.id as worker_id");
    expect(migration).toContain("REME: task details on order");
    expect(migration).not.toMatch(/task_pricing|unit_rate|line_total|total_cents/);
  });
});
