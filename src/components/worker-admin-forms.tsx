"use client";

import { useActionState } from "react";
import { disableWorker, enableWorker, inviteWorker, removeWorker } from "@/actions/workers";
import type { ActionState } from "@/actions/types";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";

export function InviteWorkerForm() {
  const [state, action] = useActionState(inviteWorker, {} as ActionState);
  return (
    <form action={action} className="space-y-3">
      <div>
        <Label>Name</Label>
        <Input name="displayName" required />
      </div>
      <div>
        <Label>Email</Label>
        <Input name="email" type="email" required />
      </div>
      <div>
        <Label>Mobile</Label>
        <Input name="phone" type="tel" />
      </div>
      {state.error && <p className="text-sm text-[#913a31]">{state.error}</p>}
      {state.message && <p className="text-sm font-semibold text-[#2f6249]">{state.message}</p>}
      <SubmitButton className="w-full" pendingText="Sending invite...">
        Invite worker
      </SubmitButton>
    </form>
  );
}

export function DisableWorkerForm({ userId }: { userId: string }) {
  const [state, action] = useActionState(disableWorker, {} as ActionState);
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="userId" value={userId} />
      <Input name="reason" required placeholder="Reason for disabling" />
      {state.error && <p className="text-xs text-[#913a31]">{state.error}</p>}
      {state.message && <p className="text-xs text-[#2f6249]">{state.message}</p>}
      <Button type="submit" variant="danger" size="sm" className="w-full">
        Disable worker
      </Button>
    </form>
  );
}

export function EnableWorkerForm({ userId }: { userId: string }) {
  const [state, action] = useActionState(enableWorker, {} as ActionState);
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="userId" value={userId} />
      {state.error && (
        <p role="alert" className="text-xs text-[#913a31]">
          {state.error}
        </p>
      )}
      {state.message && (
        <p role="status" className="text-xs text-[#2f6249]">
          {state.message}
        </p>
      )}
      <SubmitButton className="w-full" variant="secondary" size="sm" pendingText="Re-enabling...">
        Re-enable account
      </SubmitButton>
    </form>
  );
}

export function RemoveWorkerForm({ userId }: { userId: string }) {
  const [state, action] = useActionState(removeWorker, {} as ActionState);
  return (
    <details className="mt-3">
      <summary className="min-h-11 cursor-pointer py-3 text-sm font-semibold text-[#913a31]">
        Remove worker
      </summary>
      <form action={action} className="space-y-3">
        <input type="hidden" name="userId" value={userId} />
        <p className="text-sm">
          Permanently delete this sign-in account. Previous work records remain. Reassign any open
          tasks. This cannot be undone.
        </p>
        <label className="flex min-h-11 items-center gap-3 text-sm">
          <input
            type="checkbox"
            name="confirmRemoval"
            value="yes"
            required
            className="h-5 w-5 shrink-0"
          />
          I confirm removal of this account.
        </label>
        {state.error && (
          <p role="alert" className="text-sm text-[#913a31]">
            {state.error}
          </p>
        )}
        {state.message && (
          <p role="status" className="text-sm text-[#2f6249]">
            {state.message}
          </p>
        )}
        <SubmitButton variant="danger" className="w-full" pendingText="Removing...">
          Delete account permanently
        </SubmitButton>
      </form>
    </details>
  );
}
