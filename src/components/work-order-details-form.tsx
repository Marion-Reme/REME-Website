"use client";

import { startTransition, useActionState, useState, type FormEvent } from "react";
import { LoaderCircle } from "lucide-react";
import { updateWorkOrderDetails } from "@/actions/work-orders";
import type { ActionState } from "@/actions/types";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input, Label, Select, Textarea } from "@/components/ui/field";
import { AU_STATES } from "@/lib/domain";
import { toCents } from "@/lib/utils";

export type WorkOrderDetailsDefaults = {
  clientName: string;
  customerName: string;
  customerPhone: string;
  streetAddress: string;
  suburb: string;
  state: string;
  postcode: string;
  siteContactName: string;
  siteContactPhone: string;
  workOrderNumber: string;
  jobNumber: string;
  clientReference: string;
  supervisorName: string;
  supervisorPhone: string;
  issuedAt: string;
  startDate: string;
  dueDate: string;
  notes: string;
  additionalInstructions: string;
  totalCents: number;
  duplicateReason: string;
};

function FieldError({ errors }: { errors?: string[] }) {
  return errors?.map((error) => (
    <p key={error} className="mt-1 text-xs text-[#913a31]">
      {error}
    </p>
  ));
}

// Same sections as the create form, minus the scope: jobs are edited one at a
// time on the work order page.
export function WorkOrderDetailsForm({
  workOrderId,
  defaults,
}: {
  workOrderId: number;
  defaults: WorkOrderDetailsDefaults;
}) {
  const [state, action, pending] = useActionState(updateWorkOrderDetails, {} as ActionState);
  const [totalCost, setTotalCost] = useState((defaults.totalCents / 100).toFixed(2));
  const totalCents = toCents(totalCost);
  const errors = state.fieldErrors ?? {};
  // Dispatched by hand rather than through <form action>, which resets every
  // uncontrolled field once the action returns. A refused save (a duplicate order
  // number, say) must leave the manager's edits in place.
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    startTransition(() => action(formData));
  };
  return (
    <form onSubmit={submit} className="space-y-6">
      <input type="hidden" name="workOrderId" value={workOrderId} />
      {state.error && (
        <div
          role="alert"
          className="rounded-2xl border border-[#e7c8c4] bg-[#f8e7e4] px-4 py-3 text-sm font-medium text-[#8b3730]"
        >
          {state.error}
        </div>
      )}
      <Card className="p-5 sm:p-6">
        <div className="mb-5">
          <p className="text-xs font-bold tracking-[.14em] text-[#b44a00] uppercase">
            1 · Client and site
          </p>
          <h2 className="mt-1 text-xl font-semibold">Who issued the work, and where is it?</h2>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <Label htmlFor="clientName">Client (principal)</Label>
            <Input id="clientName" name="clientName" required defaultValue={defaults.clientName} />
            <FieldError errors={errors.clientName} />
          </div>
          <div>
            <Label htmlFor="customerName">
              Customer / occupant <span className="font-normal text-[#89918e]">optional</span>
            </Label>
            <Input id="customerName" name="customerName" defaultValue={defaults.customerName} />
          </div>
          <div>
            <Label htmlFor="customerPhone">Customer phone</Label>
            <Input
              id="customerPhone"
              name="customerPhone"
              type="tel"
              defaultValue={defaults.customerPhone}
            />
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor="streetAddress">Site address</Label>
            <Input
              id="streetAddress"
              name="streetAddress"
              required
              defaultValue={defaults.streetAddress}
            />
            <FieldError errors={errors.streetAddress} />
          </div>
          <div>
            <Label htmlFor="suburb">Suburb</Label>
            <Input id="suburb" name="suburb" required defaultValue={defaults.suburb} />
            <FieldError errors={errors.suburb} />
          </div>
          <div>
            <Label htmlFor="state">State</Label>
            <Select id="state" name="state" defaultValue={defaults.state || "NSW"}>
              {AU_STATES.map((state) => (
                <option key={state}>{state}</option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="postcode">Postcode</Label>
            <Input
              id="postcode"
              name="postcode"
              required
              inputMode="numeric"
              maxLength={4}
              pattern="\d{4}"
              defaultValue={defaults.postcode}
            />
            <FieldError errors={errors.postcode} />
          </div>
          <div>
            <Label htmlFor="siteContactName">
              Site contact <span className="font-normal text-[#89918e]">clear to remove</span>
            </Label>
            <Input
              id="siteContactName"
              name="siteContactName"
              defaultValue={defaults.siteContactName}
            />
          </div>
          <div>
            <Label htmlFor="siteContactPhone">Site contact phone</Label>
            <Input
              id="siteContactPhone"
              name="siteContactPhone"
              type="tel"
              defaultValue={defaults.siteContactPhone}
            />
          </div>
        </div>
      </Card>
      <Card className="p-5 sm:p-6">
        <div className="mb-5">
          <p className="text-xs font-bold tracking-[.14em] text-[#b44a00] uppercase">
            2 · Order details
          </p>
          <h2 className="mt-1 text-xl font-semibold">Reference and timing</h2>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <Label htmlFor="workOrderNumber">Work order number</Label>
            <Input
              id="workOrderNumber"
              name="workOrderNumber"
              required
              defaultValue={defaults.workOrderNumber}
            />
            <FieldError errors={errors.workOrderNumber} />
          </div>
          <div>
            <Label htmlFor="jobNumber">Job number</Label>
            <Input id="jobNumber" name="jobNumber" defaultValue={defaults.jobNumber} />
          </div>
          <div>
            <Label htmlFor="clientReference">Client reference</Label>
            <Input
              id="clientReference"
              name="clientReference"
              defaultValue={defaults.clientReference}
            />
          </div>
          <div>
            <Label htmlFor="supervisorName">Client supervisor</Label>
            <Input
              id="supervisorName"
              name="supervisorName"
              defaultValue={defaults.supervisorName}
            />
          </div>
          <div>
            <Label htmlFor="supervisorPhone">Supervisor phone</Label>
            <Input
              id="supervisorPhone"
              name="supervisorPhone"
              type="tel"
              defaultValue={defaults.supervisorPhone}
            />
          </div>
          <div>
            <Label htmlFor="issuedAt">Issued</Label>
            <Input id="issuedAt" name="issuedAt" type="date" defaultValue={defaults.issuedAt} />
            <FieldError errors={errors.issuedAt} />
          </div>
          <div>
            <Label htmlFor="startDate">Start date</Label>
            <Input id="startDate" name="startDate" type="date" defaultValue={defaults.startDate} />
            <FieldError errors={errors.startDate} />
          </div>
          <div>
            <Label htmlFor="dueDate">Completion due</Label>
            <Input id="dueDate" name="dueDate" type="date" defaultValue={defaults.dueDate} />
            <FieldError errors={errors.dueDate} />
          </div>
          <div className="sm:col-span-2 lg:col-span-3">
            <Label htmlFor="additionalInstructions">
              Site instructions{" "}
              <span className="font-normal text-[#89918e]">visible to assigned workers</span>
            </Label>
            <Textarea
              id="additionalInstructions"
              name="additionalInstructions"
              defaultValue={defaults.additionalInstructions}
            />
          </div>
          <div className="sm:col-span-2 lg:col-span-3">
            <Label htmlFor="notes">Internal notes</Label>
            <Textarea id="notes" name="notes" defaultValue={defaults.notes} />
          </div>
        </div>
      </Card>
      <Card className="p-5 sm:p-6">
        <div className="mb-5">
          <p className="text-xs font-bold tracking-[.14em] text-[#b44a00] uppercase">
            3 · Manager-only cost
          </p>
          <h2 className="mt-1 text-xl font-semibold">Work order total cost</h2>
        </div>
        <div className="max-w-sm">
          <Label htmlFor="totalCost">Total cost</Label>
          <Input
            id="totalCost"
            inputMode="decimal"
            min="0"
            step="0.01"
            type="number"
            required
            value={totalCost}
            onChange={(event) => setTotalCost(event.target.value)}
          />
          <FieldError errors={errors.totalCents} />
        </div>
        <input type="hidden" name="totalCents" value={totalCents ?? ""} />
        <div className="mt-5">
          <Label htmlFor="duplicateReason">
            Duplicate reason{" "}
            <span className="font-normal text-[#89918e]">
              only if this intentionally duplicates another order&apos;s number
            </span>
          </Label>
          <Input
            id="duplicateReason"
            name="duplicateReason"
            defaultValue={defaults.duplicateReason}
          />
        </div>
      </Card>
      <div className="sticky bottom-4 flex items-center justify-between gap-4 rounded-2xl border border-[#d4cec2] bg-[#faf9f6]/95 p-3 shadow-xl backdrop-blur">
        <p className="hidden text-sm text-[#707a77] sm:block">
          Workers on open jobs are told if the address, dates or site details change.
        </p>
        <Button type="submit" className="ml-auto min-w-40" disabled={pending}>
          {pending && <LoaderCircle className="h-4 w-4 animate-spin" />}
          {pending ? "Saving..." : "Save changes"}
        </Button>
      </div>
    </form>
  );
}
