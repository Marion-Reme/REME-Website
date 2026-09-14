import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  role: vi.fn(),
  client: vi.fn(),
  admin: vi.fn(),
  remove: vi.fn(),
  revalidate: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ assertRole: mocks.role }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.client }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mocks.admin }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
vi.mock("@/lib/redact", () => ({ logger: { error: vi.fn() } }));
import { removeWorker } from "@/actions/workers";

const profiles = [
  { id: "disabled", tenant_id: "ours", role: "worker", is_active: false, deleted_at: null },
  { id: "active", tenant_id: "ours", role: "worker", is_active: true, deleted_at: null },
  { id: "outsider", tenant_id: "theirs", role: "worker", is_active: false, deleted_at: null },
  { id: "manager", tenant_id: "ours", role: "manager", is_active: false, deleted_at: null },
  { id: "removed", tenant_id: "ours", role: "worker", is_active: false, deleted_at: "2026-09-14" },
];
function form(id: string, confirm = true) {
  const data = new FormData();
  data.set("userId", id);
  if (confirm) data.set("confirmRemoval", "yes");
  return data;
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.role.mockResolvedValue({ tenant_id: "ours" });
  mocks.remove.mockResolvedValue({ error: null });
  mocks.admin.mockReturnValue({ auth: { admin: { deleteUser: mocks.remove } } });
  mocks.client.mockImplementation(() => {
    let rows = [...profiles];
    const query = {
      select: () => query,
      eq: (key: string, value: unknown) => {
        rows = rows.filter((row) => row[key as keyof typeof row] === value);
        return query;
      },
      is: (key: string, value: unknown) => {
        rows = rows.filter((row) => row[key as keyof typeof row] === value);
        return query;
      },
      maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
    };
    return { from: () => query };
  });
});
describe("worker removal", () => {
  it.each(["active", "outsider", "manager", "removed", "missing"])(
    "rejects %s without invoking privileged deletion",
    async (id) => {
      expect((await removeWorker({}, form(id))).error).toBeTruthy();
      expect(mocks.admin).not.toHaveBeenCalled();
    },
  );
  it("requires an explicit confirmation", async () => {
    expect((await removeWorker({}, form("disabled", false))).error).toBeTruthy();
    expect(mocks.admin).not.toHaveBeenCalled();
  });
  it("removes a disabled member while retaining historical identity", async () => {
    expect((await removeWorker({}, form("disabled"))).ok).toBe(true);
    expect(mocks.role).toHaveBeenCalledWith("manager");
    expect(mocks.remove).toHaveBeenCalledWith("disabled", true);
    expect(mocks.revalidate).toHaveBeenCalledWith("/manager/workers");
    expect(mocks.revalidate).toHaveBeenCalledWith("/manager/settings");
  });
  it("reports an Auth failure and does not report success", async () => {
    mocks.remove.mockResolvedValue({ error: { message: "service unavailable" } });
    expect((await removeWorker({}, form("disabled"))).error).toBeTruthy();
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });
  it("stops when manager authorization fails", async () => {
    mocks.role.mockRejectedValue(new Error("Forbidden"));
    await expect(removeWorker({}, form("disabled"))).rejects.toThrow("Forbidden");
    expect(mocks.admin).not.toHaveBeenCalled();
  });
});
