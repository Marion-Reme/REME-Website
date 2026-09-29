"use client";

import {
  startTransition,
  useActionState,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { Archive, CheckCircle2, LoaderCircle, Plus, RotateCcw, Trash2 } from "lucide-react";
import {
  addWorkOrderTask,
  completeWorkOrderTasks,
  deleteTask,
  deleteWorkOrder,
  reopenWorkOrder,
} from "@/actions/work-orders";
import type { ActionState } from "@/actions/types";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import { TRADE_CATEGORIES, UNITS } from "@/lib/domain";

function Feedback({ state, className }: { state: ActionState; className?: string }) {
  if (state.error)
    return (
      <p role="alert" className={`text-sm text-[#913a31] ${className ?? ""}`}>
        {state.error}
      </p>
    );
  if (state.message)
    return (
      <p role="status" className={`text-sm font-medium text-[#2f6249] ${className ?? ""}`}>
        {state.message}
      </p>
    );
  return null;
}

export function CompleteJobForm({ workOrderId, taskId }: { workOrderId: number; taskId: number }) {
  const [state, action] = useActionState(completeWorkOrderTasks, {} as ActionState);
  return (
    <form action={action} className="shrink-0">
      <input type="hidden" name="workOrderId" value={workOrderId} />
      <input type="hidden" name="taskId" value={taskId} />
      <SubmitButton
        variant="secondary"
        size="sm"
        className="text-[#2f6249]"
        pendingText="Completing..."
      >
        <CheckCircle2 className="h-4 w-4" />
        Mark complete
      </SubmitButton>
      <Feedback state={state} className="mt-1 text-xs" />
    </form>
  );
}

// Permanent, so it sits behind a disclosure with the consequences spelled out.
export function DeleteJobForm({ taskId }: { taskId: number }) {
  const [state, action] = useActionState(deleteTask, {} as ActionState);
  return (
    <details className="mt-3 rounded-xl border border-[#ecd6d2] bg-[#fdf6f5] p-3">
      <summary className="inline-flex cursor-pointer list-none items-center gap-2 text-sm font-semibold text-[#913a31]">
        <Trash2 className="h-4 w-4" />
        Delete job
      </summary>
      <form action={action} className="mt-3 space-y-3">
        <input type="hidden" name="taskId" value={taskId} />
        <p className="text-sm leading-6 text-[#6b4a45]">
          This permanently removes the job, its scheduled dates and any photos or notes workers sent
          for it. Assigned workers are told if the job was still open.
        </p>
        <SubmitButton variant="danger" size="sm" pendingText="Deleting job...">
          Delete job permanently
        </SubmitButton>
        <Feedback state={state} />
      </form>
    </details>
  );
}

export function AddJobForm({ workOrderId }: { workOrderId: number }) {
  const [state, action, pending] = useActionState(addWorkOrderTask, {} as ActionState);
  const formRef = useRef<HTMLFormElement>(null);
  // Cleared only after a successful add. Dispatching by hand keeps what was typed
  // when the add is refused, which <form action> would otherwise reset.
  useEffect(() => {
    if (state.ok) formRef.current?.reset();
  }, [state]);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    startTransition(() => action(formData));
  };
  return (
    <details className="rounded-xl border border-[#d8e3e1] bg-[#f5fafc] p-3">
      <summary className="inline-flex cursor-pointer list-none items-center gap-2 text-sm font-semibold text-[#0077a8]">
        <Plus className="h-4 w-4" />
        Add a job
      </summary>
      <form
        ref={formRef}
        onSubmit={submit}
        className="mt-4 grid gap-3 md:grid-cols-[150px_minmax(0,1fr)_7rem_6.5rem]"
      >
        <input type="hidden" name="workOrderId" value={workOrderId} />
        <div>
          <Label htmlFor="new-job-trade">Trade</Label>
          <Select id="new-job-trade" name="trade" defaultValue="Painting">
            {TRADE_CATEGORIES.map((trade) => (
              <option key={trade}>{trade}</option>
            ))}
          </Select>
        </div>
        <div>
          <Label htmlFor="new-job-area">
            Area <span className="font-normal text-[#89918e]">optional</span>
          </Label>
          <Input id="new-job-area" name="area" maxLength={120} placeholder="For example, Lounge" />
        </div>
        <div>
          <Label htmlFor="new-job-quantity">Quantity</Label>
          <Input
            id="new-job-quantity"
            name="quantity"
            type="number"
            required
            min="0.001"
            max="999999"
            step="0.001"
            defaultValue={1}
          />
        </div>
        <div>
          <Label htmlFor="new-job-unit">Unit</Label>
          <Select id="new-job-unit" name="unit" defaultValue="ea">
            {UNITS.map((unit) => (
              <option key={unit}>{unit}</option>
            ))}
          </Select>
        </div>
        <div className="md:col-span-4">
          <Label htmlFor="new-job-description">Description</Label>
          <Textarea
            id="new-job-description"
            name="description"
            required
            minLength={2}
            maxLength={1000}
            placeholder="Describe the work"
            className="min-h-20"
          />
          {state.fieldErrors?.description?.map((error) => (
            <p key={error} className="mt-1 text-xs text-[#913a31]">
              {error}
            </p>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-3 md:col-span-4">
          <Button type="submit" disabled={pending}>
            {pending && <LoaderCircle className="h-4 w-4 animate-spin" />}
            {pending ? "Adding job..." : "Add job"}
          </Button>
          <p className="text-xs text-[#77817e]">
            The new job goes to everyone already assigned to this work order.
          </p>
        </div>
        <Feedback state={state} className="md:col-span-4" />
      </form>
    </details>
  );
}

export function CompleteWorkOrderForm({
  workOrderId,
  openJobs,
}: {
  workOrderId: number;
  openJobs: number;
}) {
  const [state, action] = useActionState(completeWorkOrderTasks, {} as ActionState);
  return (
    <details>
      <summary className="inline-flex cursor-pointer list-none items-center gap-2 text-sm font-semibold text-[#2f6249]">
        <Archive className="h-4 w-4" />
        Mark work order complete
      </summary>
      <form action={action} className="mt-3 space-y-3">
        <input type="hidden" name="workOrderId" value={workOrderId} />
        <p className="text-sm leading-6 text-[#5d6865]">
          Marks {openJobs === 1 ? "the last open job" : `all ${openJobs} open jobs`} complete,
          approves anything workers have sent in for review, clears the days ahead and moves the
          order to the Completed tab. You can reopen it later.
        </p>
        <SubmitButton className="w-full" pendingText="Completing...">
          Complete work order
        </SubmitButton>
        <Feedback state={state} />
      </form>
    </details>
  );
}

export function ReopenWorkOrderForm({ workOrderId }: { workOrderId: number }) {
  const [state, action] = useActionState(reopenWorkOrder, {} as ActionState);
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="workOrderId" value={workOrderId} />
      <div>
        <Label htmlFor="reopen-reason">
          Reason <span className="font-normal text-[#89918e]">optional, kept in the audit log</span>
        </Label>
        <Input
          id="reopen-reason"
          name="reason"
          maxLength={500}
          placeholder="Client asked for touch-ups"
        />
      </div>
      <SubmitButton variant="secondary" className="w-full" pendingText="Reopening...">
        <RotateCcw className="h-4 w-4" />
        Reopen work order
      </SubmitButton>
      <Feedback state={state} />
    </form>
  );
}

// Typing the order number is the confirmation. The button stays disabled until it
// matches, and the database checks the same thing again.
export function DeleteWorkOrderForm({
  workOrderId,
  workOrderNumber,
}: {
  workOrderId: number;
  workOrderNumber: string;
}) {
  const [state, action] = useActionState(deleteWorkOrder, {} as ActionState);
  const [typed, setTyped] = useState("");
  const matches = typed.trim().toLowerCase() === workOrderNumber.trim().toLowerCase();
  return (
    <details>
      <summary className="inline-flex cursor-pointer list-none items-center gap-2 text-sm font-semibold text-[#913a31]">
        <Trash2 className="h-4 w-4" />
        Delete work order
      </summary>
      <form action={action} className="mt-3 space-y-3">
        <input type="hidden" name="workOrderId" value={workOrderId} />
        <p className="text-sm leading-6 text-[#6b4a45]">
          This permanently deletes the order, every job on it, its schedule, the original PDF and
          all worker photos and notes. It cannot be undone. To keep the history, cancel the order
          instead.
        </p>
        <div>
          <Label htmlFor="delete-confirmation">
            Type <span className="font-mono">{workOrderNumber}</span> to confirm
          </Label>
          <Input
            id="delete-confirmation"
            name="confirmation"
            autoComplete="off"
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
          />
        </div>
        <fieldset disabled={!matches} className="disabled:opacity-50">
          <SubmitButton variant="danger" className="w-full" pendingText="Deleting...">
            Delete permanently
          </SubmitButton>
        </fieldset>
        <Feedback state={state} />
      </form>
    </details>
  );
}
