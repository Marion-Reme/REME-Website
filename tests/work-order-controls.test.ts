// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkOrderCrewForm } from "@/components/assignment-form";
import { DeleteWorkOrderForm } from "@/components/work-order-actions";

const mocks = vi.hoisted(() => ({
  assignWorkOrderCrew: vi.fn(),
  deleteWorkOrder: vi.fn(),
}));
vi.mock("@/actions/work-orders", () => ({
  assignWorkOrderCrew: mocks.assignWorkOrderCrew,
  deleteWorkOrder: mocks.deleteWorkOrder,
  scheduleTask: vi.fn(),
  unscheduleEntry: vi.fn(),
  addWorkOrderTask: vi.fn(),
  completeWorkOrderTasks: vi.fn(),
  deleteTask: vi.fn(),
  reopenWorkOrder: vi.fn(),
}));

const workers = [
  { id: 1, name: "Alice Worker" },
  { id: 2, name: "Bob Worker" },
  { id: 3, name: "Carol Worker" },
];
const checkbox = (name: string) => screen.getByRole("checkbox", { name }) as HTMLInputElement;
const leadRadios = () => screen.getAllByRole("radio", { name: "Lead" }) as HTMLInputElement[];

beforeEach(() => {
  vi.resetAllMocks();
  mocks.assignWorkOrderCrew.mockResolvedValue({ ok: true, message: "Crew saved." });
  mocks.deleteWorkOrder.mockResolvedValue({ error: "Not deleted in this test." });
});
afterEach(cleanup);

describe("crew form", () => {
  const renderCrew = () =>
    render(
      createElement(WorkOrderCrewForm, {
        workOrderId: 7,
        workers,
        crewIds: [2],
        leadWorkerId: 2,
        today: "2026-09-28",
      }),
    );

  it("starts from the current crew and lead", () => {
    renderCrew();
    expect(checkbox("Bob Worker").checked).toBe(true);
    expect(checkbox("Alice Worker").checked).toBe(false);
    const [alice, bob] = leadRadios();
    expect(bob.checked).toBe(true);
    expect(alice.disabled).toBe(true);
  });

  it("only lets a ticked worker lead, and moves the lead when the lead is unticked", () => {
    renderCrew();
    fireEvent.click(checkbox("Alice Worker"));
    expect(leadRadios()[0].disabled).toBe(false);
    fireEvent.click(checkbox("Bob Worker"));
    expect(leadRadios()[0].checked).toBe(true);
    expect(leadRadios()[1].disabled).toBe(true);
  });

  it("submits several workers at once with the chosen lead", async () => {
    renderCrew();
    fireEvent.click(checkbox("Alice Worker"));
    fireEvent.click(checkbox("Carol Worker"));
    fireEvent.click(leadRadios()[2]);
    fireEvent.click(screen.getByRole("button", { name: "Update crew" }));
    await waitFor(() => expect(mocks.assignWorkOrderCrew).toHaveBeenCalledTimes(1));
    const formData = mocks.assignWorkOrderCrew.mock.calls[0][1] as FormData;
    expect(formData.get("workOrderId")).toBe("7");
    expect(formData.getAll("workerIds").sort()).toEqual(["1", "2", "3"]);
    expect(formData.get("leadWorkerId")).toBe("3");
    expect(formData.get("intent")).toBeNull();
    expect(await screen.findByText("Crew saved.")).toBeTruthy();
  });

  it("offers unassigning everyone only when someone is assigned", () => {
    renderCrew();
    expect(screen.getAllByText("Unassign everyone").length).toBeGreaterThan(0);
    cleanup();
    render(
      createElement(WorkOrderCrewForm, {
        workOrderId: 7,
        workers,
        crewIds: [],
        leadWorkerId: null,
        today: "2026-09-28",
      }),
    );
    expect(screen.queryByText("Unassign everyone")).toBeNull();
    expect(screen.getByRole("button", { name: "Assign whole order" })).toBeTruthy();
  });
});

describe("delete work order form", () => {
  it("stays disabled until the order number is typed", () => {
    render(createElement(DeleteWorkOrderForm, { workOrderId: 7, workOrderNumber: "20299-29572" }));
    const button = screen.getByRole("button", { name: "Delete permanently" });
    const input = screen.getByLabelText(/to confirm/);
    expect(button.closest("fieldset")?.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "20299" } });
    expect(button.closest("fieldset")?.disabled).toBe(true);
    fireEvent.change(input, { target: { value: " 20299-29572 " } });
    expect(button.closest("fieldset")?.disabled).toBe(false);
  });
});
