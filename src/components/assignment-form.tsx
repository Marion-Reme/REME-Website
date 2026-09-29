"use client";

import { useActionState, useState } from "react";
import { assignWorkOrderCrew, scheduleTask, unscheduleEntry } from "@/actions/work-orders";
import type { ActionState } from "@/actions/types";
import { MultiDateCalendar } from "@/components/multi-date-calendar";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";

type WorkerOption = { id: number; name: string };

// The whole order is handed to a crew: every open job goes to every ticked
// worker, one of whom leads. Work days are optional.
export function WorkOrderCrewForm({
  workOrderId,
  workers,
  crewIds,
  leadWorkerId,
  today,
}: {
  workOrderId: number;
  workers: WorkerOption[];
  crewIds: number[];
  leadWorkerId: number | null;
  today: string;
}) {
  const [state, action] = useActionState(assignWorkOrderCrew, {} as ActionState);
  const [selected, setSelected] = useState<number[]>(crewIds);
  const [lead, setLead] = useState<number | null>(leadWorkerId ?? crewIds[0] ?? null);
  // The lead must be one of the ticked workers, so fall back to the first.
  const effectiveLead = lead !== null && selected.includes(lead) ? lead : (selected[0] ?? null);
  const toggle = (id: number) =>
    setSelected((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="workOrderId" value={workOrderId} />
      <fieldset>
        <legend className="mb-1.5 block text-sm font-semibold text-[#35423f]">Workers</legend>
        {workers.length ? (
          <ul className="divide-y divide-[#ebe7df] rounded-xl border border-[#d9d4c9] bg-white">
            {workers.map((worker) => {
              const checked = selected.includes(worker.id);
              return (
                <li key={worker.id} className="flex items-center justify-between gap-3 px-3 py-2">
                  <label className="flex min-h-9 min-w-0 flex-1 cursor-pointer items-center gap-2.5 text-sm font-medium">
                    <input
                      type="checkbox"
                      name="workerIds"
                      value={worker.id}
                      checked={checked}
                      onChange={() => toggle(worker.id)}
                      className="h-4 w-4 shrink-0"
                    />
                    <span className="truncate">{worker.name}</span>
                  </label>
                  <label
                    className={`flex shrink-0 items-center gap-1.5 text-xs font-semibold ${checked ? "cursor-pointer text-[#0077a8]" : "text-[#b3b8b6]"}`}
                  >
                    <input
                      type="radio"
                      name="leadWorkerId"
                      value={worker.id}
                      checked={effectiveLead === worker.id}
                      disabled={!checked}
                      onChange={() => setLead(worker.id)}
                    />
                    Lead
                  </label>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-sm text-[#77817e]">Invite a worker before assigning this order.</p>
        )}
      </fieldset>
      <div>
        <Label>
          Work days <span className="font-normal text-[#89918e]">optional</span>
        </Label>
        <MultiDateCalendar name="dates" today={today} />
        <p className="mt-2 text-xs leading-5 text-[#77817e]">
          Every ticked worker is booked on the whole order for each chosen day. Leave this empty to
          keep the days already planned.
        </p>
      </div>
      {state.error && (
        <p role="alert" className="text-sm text-[#913a31]">
          {state.error}
        </p>
      )}
      {state.message && (
        <p role="status" className="text-sm font-medium text-[#2f6249]">
          {state.message}
        </p>
      )}
      <SubmitButton className="w-full" pendingText="Saving crew...">
        {crewIds.length ? "Update crew" : "Assign whole order"}
      </SubmitButton>
      {crewIds.length > 0 && (
        <details className="rounded-xl border border-[#e1ddd4] bg-[#faf9f6] p-3">
          <summary className="cursor-pointer text-sm font-semibold text-[#913a31]">
            Unassign everyone
          </summary>
          <p className="mt-2 text-xs leading-5 text-[#77817e]">
            Removes every worker from this order and clears its days ahead. Each worker is told.
          </p>
          <Button
            type="submit"
            name="intent"
            value="clear"
            variant="secondary"
            size="sm"
            className="mt-3 w-full text-[#913a31]"
          >
            Unassign everyone
          </Button>
        </details>
      )}
    </form>
  );
}

export function ScheduleTaskForm({
  taskId,
  workers,
  defaultWorkerId,
  today,
}: {
  taskId: number;
  workers: WorkerOption[];
  defaultWorkerId?: number;
  today: string;
}) {
  const [state, action] = useActionState(scheduleTask, {} as ActionState);
  return (
    <form action={action} className="grid gap-3 sm:grid-cols-2">
      <input type="hidden" name="taskId" value={taskId} />
      <div>
        <Label>Worker</Label>
        <Select name="workerId" defaultValue={defaultWorkerId ?? ""} required>
          <option value="" disabled>
            Choose worker
          </option>
          {workers.map((worker) => (
            <option key={worker.id} value={worker.id}>
              {worker.name}
            </option>
          ))}
        </Select>
      </div>
      <div>
        <Label>Start time</Label>
        <Input name="startTime" type="time" />
      </div>
      <div>
        <Label>Dates</Label>
        <MultiDateCalendar name="dates" today={today} compact />
      </div>
      <div>
        <Label>Estimated hours per selected day</Label>
        <Input name="estimatedHours" type="number" min="0.25" max="24" step="0.25" />
      </div>
      {state.error && (
        <p role="alert" className="text-sm text-[#913a31] sm:col-span-2">
          {state.error}
        </p>
      )}
      {state.message && (
        <p role="status" className="text-sm font-medium text-[#2f6249] sm:col-span-2">
          {state.message}
        </p>
      )}
      <div className="sm:col-span-2">
        <Button type="submit" variant="secondary" className="w-full">
          Save schedule
        </Button>
      </div>
    </form>
  );
}

// Removing one date is a routine planning correction, so it is a single press:
// no disclosure to open and no reason to type. The audit event still records it.
export function UnscheduleEntryForm({ scheduleEntryId }: { scheduleEntryId: number }) {
  const [state, action] = useActionState(unscheduleEntry, {} as ActionState);
  return (
    <div className="shrink-0 text-left">
      <form action={action}>
        <input type="hidden" name="scheduleEntryId" value={scheduleEntryId} />
        <SubmitButton
          variant="ghost"
          className="min-h-9 px-2 py-1 text-xs font-semibold text-[#913a31] hover:bg-[#f5dfdc]"
          pendingText="Removing..."
        >
          Remove
        </SubmitButton>
      </form>
      {state.error && (
        <p role="alert" className="mt-1 text-xs text-[#913a31]">
          {state.error}
        </p>
      )}
    </div>
  );
}
