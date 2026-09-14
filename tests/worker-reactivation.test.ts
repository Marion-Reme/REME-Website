import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

const workers = () => source("src/actions/workers.ts");
const section = (text: string, marker: string) => text.slice(text.indexOf(marker));

describe("re-enabling a disabled worker", () => {
  it("reverses both halves of a disable", () => {
    const enable = section(workers(), "export async function enableWorker");
    expect(enable).toContain("is_active: true, disabled_at: null, disabled_reason: null");
    expect(enable).toContain('ban_duration: "none"');
  });

  it("lifts the sign-in ban before the profile is marked active", () => {
    const enable = section(workers(), "export async function enableWorker");
    expect(enable.indexOf('ban_duration: "none"')).toBeLessThan(enable.indexOf("is_active: true"));
  });

  it("reports a failed unban instead of showing an account as active", () => {
    const enable = section(workers(), "export async function enableWorker");
    expect(enable).toContain("banError");
    expect(enable.indexOf("banError")).toBeLessThan(enable.indexOf("is_active: true"));
  });

  it("confirms the worker belongs to the manager's tenant before using the admin client", () => {
    const enable = section(workers(), "export async function enableWorker");
    expect(enable).toContain('assertRole("manager")');
    expect(enable).toContain("manager.tenant_id");
    expect(enable.indexOf("manager.tenant_id")).toBeLessThan(enable.indexOf("createAdminClient()"));
  });

  it("offers the control on disabled worker cards only", () => {
    const page = source("src/app/manager/workers/page.tsx");
    expect(page).toContain("EnableWorkerForm");
    expect(page).toContain("disabled_reason");
    const forms = source("src/components/worker-admin-forms.tsx");
    expect(forms).toContain("export function EnableWorkerForm");
    expect(forms).toContain("Re-enable account");
  });
});

describe("disabling a worker", () => {
  it("only bans an account the tenant-scoped update actually matched", () => {
    const disable = workers().slice(
      workers().indexOf("export async function disableWorker"),
      workers().indexOf("export async function enableWorker"),
    );
    expect(disable).toContain("updated?.length");
    expect(disable.indexOf("updated?.length")).toBeLessThan(disable.indexOf("ban_duration"));
  });

  it("no longer claims that open work is reassigned automatically", () => {
    expect(workers()).not.toContain("flagged for reassignment");
  });
});
