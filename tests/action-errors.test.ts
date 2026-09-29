import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { actionError, throwActionError } from "@/actions/errors";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

afterEach(() => vi.restoreAllMocks());

const silence = () => vi.spyOn(console, "error").mockImplementation(() => {});

describe("action error handling", () => {
  // P0001 is what a bare `raise exception` in our own RPCs produces, and those
  // messages are written for the user.
  it("shows a message our own RPC raised deliberately", () => {
    silence();
    expect(actionError("task.assign", { code: "P0001", message: "Worker is unavailable" })).toEqual(
      {
        error: "Worker is unavailable",
      },
    );
  });

  it.each([
    ["23505", 'duplicate key value violates unique constraint "work_order_number_key"'],
    ["42703", "column task.unit_rate_cents does not exist"],
    ["22P02", 'invalid input syntax for type bigint: "abc"'],
  ])("hides infrastructure detail from SQLSTATE %s", (code, message) => {
    silence();
    const result = actionError("task.assign", { code, message });
    expect(result.error).not.toContain(message);
    expect(result.error).toMatch(/something went wrong/i);
  });

  it("hides an error with no code at all", () => {
    silence();
    expect(actionError("task.assign", { message: "fetch failed" }).error).toMatch(
      /something went wrong/i,
    );
  });

  it("uses a caller-supplied fallback when given one", () => {
    silence();
    expect(actionError("worker.disable", { code: "23503", message: "fk violation" })).toEqual({
      error: "Something went wrong. Try again, and tell your manager if it keeps happening.",
    });
    expect(
      actionError("worker.disable", { code: "23503", message: "fk" }, "Custom fallback.").error,
    ).toBe("Custom fallback.");
  });

  it("always logs, including when the message is shown", () => {
    const spy = silence();
    actionError("task.assign", { code: "P0001", message: "Forbidden" });
    expect(spy).toHaveBeenCalledOnce();
    expect(String(spy.mock.calls[0][0])).toContain("task.assign.failed");
  });

  it("throws the same vetted text for void actions", () => {
    silence();
    expect(() => throwActionError("task.start", { code: "P0001", message: "Forbidden" })).toThrow(
      "Forbidden",
    );
    expect(() =>
      throwActionError("task.start", { code: "42601", message: "syntax error at or near" }),
    ).toThrow(/something went wrong/i);
  });
});

describe("no action returns a raw database message", () => {
  const rpcBacked = ["work-orders", "worker", "review", "settings"];

  it.each(rpcBacked)("%s.ts routes database errors through actionError", (name) => {
    const source = read(`src/actions/${name}.ts`);
    expect(source).toContain("actionError(");
    expect(source).not.toMatch(/return \{ error: error\.message \}/);
  });

  // Supabase Auth admin messages are written for the manager reading them
  // ("already been registered"), so those are kept — but they must be logged.
  it.each(["team", "workers", "auth"])("%s.ts logs the auth messages it does surface", (name) => {
    const source = read(`src/actions/${name}.ts`);
    expect(source).toContain("logger.error(");
  });
});

describe("reopenTask", () => {
  const source = read("src/actions/work-orders.ts").replace(/\s+/g, " ");
  // Bounded by the next export so actions added after it are not counted.
  const start = source.indexOf("export async function reopenTask");
  const next = source.indexOf("export async function", start + 1);
  const body = source.slice(start, next === -1 ? undefined : next);

  it("authorises once instead of three times", () => {
    expect(body.match(/assertRole\("manager"\)/g)).toHaveLength(1);
  });

  it("scopes the update to the manager's own tenant", () => {
    expect(body).toContain('.eq("tenant_id", profile.tenant_id)');
  });

  it("validates the reason rather than only checking it is truthy", () => {
    expect(body).toContain("reason.length < 2 || reason.length > 500");
  });

  it("records a failed note insert instead of discarding it", () => {
    expect(body).toContain("task.reopen_note_failed");
  });

  it("revalidates the worker's view of the reopened task", () => {
    expect(body).toContain("/worker/tasks/${taskId}");
  });
});
