import { z } from "zod";

export const APP_ROLES = ["manager", "worker"] as const;
export type AppRole = (typeof APP_ROLES)[number];

export const TASK_STATUSES = [
  "draft",
  "ready",
  "assigned",
  "scheduled",
  "in_progress",
  "completion_submitted",
  "changes_requested",
  "blocked",
  "completed",
  "cancelled",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const WORK_ORDER_STATUSES = [
  "draft",
  "ready",
  "assigned",
  "scheduled",
  "in_progress",
  "changes_requested",
  "blocked",
  "completed",
  "signed_off",
  "cancelled",
] as const;
export type WorkOrderStatus = (typeof WORK_ORDER_STATUSES)[number];

export const UNITS = ["ea", "m2", "lm", "m3", "hr"] as const;

// Australian states and territories. SA, WA and NT are two characters, so this
// must never be validated as a fixed-length string — the form offers all eight
// and every one of them has to survive validation.
export const AU_STATES = ["NSW", "ACT", "VIC", "QLD", "SA", "WA", "TAS", "NT"] as const;
export type AuState = (typeof AU_STATES)[number];

export const TRADE_CATEGORIES = [
  "Carpentry",
  "Cleaning",
  "Insulation",
  "Painting",
  "Plastering",
  "Preliminaries",
  "Waste Removal",
  "Miscellaneous",
] as const;

export type UserProfile = {
  id: string;
  tenant_id: string;
  role: AppRole;
  worker_id: number | null;
  display_name: string;
  email: string;
  phone: string | null;
  is_active: boolean;
  mfa_enrolled: boolean;
};

export const taskInputSchema = z.object({
  trade: z.string().trim().min(1, "Trade is required"),
  area: z.string().trim().max(120).optional().default(""),
  description: z.string().trim().min(2, "Description is required").max(1000),
  quantity: z.coerce.number().positive().max(999999),
  unit: z.enum(UNITS),
});

export const taskDetailsInputSchema = taskInputSchema.omit({ trade: true });

export const workOrderInputSchema = z.object({
  clientId: z.coerce.number().int().positive().optional(),
  clientName: z.string().trim().min(2).max(200),
  customerName: z.string().trim().max(200).optional().default(""),
  customerPhone: z.string().trim().max(40).optional().default(""),
  streetAddress: z.string().trim().min(3).max(300),
  suburb: z.string().trim().min(2).max(100),
  state: z.preprocess(
    (value) => (typeof value === "string" && value.trim() ? value.trim().toUpperCase() : "NSW"),
    z.enum(AU_STATES),
  ),
  postcode: z
    .string()
    .trim()
    .regex(/^\d{4}$/, "Enter a four-digit postcode"),
  siteContactName: z.string().trim().max(200).optional().default(""),
  siteContactPhone: z.string().trim().max(40).optional().default(""),
  workOrderNumber: z.string().trim().min(1).max(100),
  jobNumber: z.string().trim().max(100).optional().default(""),
  clientReference: z.string().trim().max(100).optional().default(""),
  supervisorName: z.string().trim().max(200).optional().default(""),
  supervisorPhone: z.string().trim().max(40).optional().default(""),
  issuedAt: z.string().optional().default(""),
  startDate: z.string().optional().default(""),
  dueDate: z.string().optional().default(""),
  notes: z.string().max(10000).optional().default(""),
  additionalInstructions: z.string().max(10000).optional().default(""),
  totalCents: z.preprocess(
    (value) => (value === "" || value == null ? undefined : value),
    z.coerce.number().int().min(0, "Enter the work order total"),
  ),
  duplicateReason: z.string().trim().max(500).optional().default(""),
  tasks: z.array(taskInputSchema).min(1, "Add at least one task").max(200),
});

export type WorkOrderInput = z.infer<typeof workOrderInputSchema>;

const optionalIsoDate = z
  .string()
  .trim()
  .optional()
  .default("")
  .refine((value) => value === "" || parseScheduleDates(value, 1) !== null, "Enter a valid date");

// Editing a saved order changes its header and total. Jobs are edited one at a
// time on the order page, so there is no task list here.
export const workOrderDetailsInputSchema = workOrderInputSchema
  .omit({ clientId: true, tasks: true })
  .extend({ issuedAt: optionalIsoDate, startDate: optionalIsoDate, dueDate: optionalIsoDate });

export type WorkOrderDetailsInput = z.infer<typeof workOrderDetailsInputSchema>;

export function parseTaskLines(input: string) {
  const headerNames = new Set(TRADE_CATEGORIES.map((trade) => trade.toLowerCase()));
  let trade = "Miscellaneous";
  const tasks: Array<z.input<typeof taskInputSchema>> = [];

  for (const originalLine of input.split(/\r?\n/)) {
    const line = originalLine.trim();
    if (!line || /^material$/i.test(line)) continue;
    if (headerNames.has(line.replace(/\s+material$/i, "").toLowerCase())) {
      trade =
        TRADE_CATEGORIES.find(
          (name) => name.toLowerCase() === line.replace(/\s+material$/i, "").toLowerCase(),
        ) ?? trade;
      continue;
    }
    const match = line.match(/^(.*?)\s+(\d+(?:\.\d+)?)\s*\/\s*(ea|m2|lm|m3|hr)\s*$/i);
    if (!match) continue;
    tasks.push({
      trade,
      area: "",
      description: match[1].trim(),
      quantity: Number(match[2]),
      unit: match[3].toLowerCase() as (typeof UNITS)[number],
    });
  }
  return tasks;
}

export function parseScheduleDates(input: string, maximum = 62): string[] | null {
  const values = [
    ...new Set(
      input
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ].sort();
  if (!values.length || values.length > maximum) return null;
  for (const value of values) {
    const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;
    const year = Number(match[1]),
      month = Number(match[2]),
      day = Number(match[3]);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    if (
      parsed.getUTCFullYear() !== year ||
      parsed.getUTCMonth() !== month - 1 ||
      parsed.getUTCDate() !== day
    )
      return null;
  }
  return values;
}

export function deriveWorkOrderStatus(statuses: TaskStatus[]): WorkOrderStatus {
  const active = statuses.filter((status) => status !== "cancelled");
  if (!active.length) return "cancelled";
  if (active.includes("blocked")) return "blocked";
  if (active.includes("changes_requested")) return "changes_requested";
  if (active.every((status) => status === "completed")) return "signed_off";
  if (active.includes("completion_submitted")) return "in_progress";
  if (active.includes("in_progress")) return "in_progress";
  if (active.every((status) => ["scheduled", "completed"].includes(status))) return "scheduled";
  if (active.some((status) => ["assigned", "scheduled", "completed"].includes(status)))
    return "assigned";
  if (active.every((status) => status === "ready")) return "ready";
  return "draft";
}

export const FORBIDDEN_WORKER_KEYS = [
  "unit_rate",
  "unitRate",
  "line_total",
  "lineTotal",
  "subtotal",
  "gst_cents",
  "gstCents",
  "total_cents",
  "totalCents",
  "task_pricing",
  "work_order_totals",
] as const;

const FORBIDDEN_KEY_SET = new Set<string>(FORBIDDEN_WORKER_KEYS);

// Walks actual object keys rather than pattern-matching serialised JSON. The
// regex form also matched inside string *values*, so a task description that
// happened to contain `"subtotal":` would have taken down a worker's page.
function findForbiddenKey(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findForbiddenKey(item);
      if (found) return found;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_KEY_SET.has(key)) return key;
    const found = findForbiddenKey(item);
    if (found) return found;
  }
  return null;
}

// Deliberately fails closed: a suspected pricing leak should break the page
// rather than render. The offending key is named so the cause is visible in the
// server log instead of leaving a bare assertion to diagnose.
export function assertWorkerSafe<T>(value: T): T {
  const offending = findForbiddenKey(value);
  if (offending) throw new Error(`Unsafe worker response blocked: ${offending}`);
  return value;
}
