"use client";

import { useActionState, useState } from "react";
import { Check, RotateCcw, X } from "lucide-react";
import { reviewSubmission } from "@/actions/review";
import type { ActionState } from "@/actions/types";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/field";

export function ReviewForm({ submissionId }: { submissionId: number }) {
  const [state, action] = useActionState(reviewSubmission, {} as ActionState);
  const [decision, setDecision] = useState("approved");
  return (
    <form action={action} className="mt-4 space-y-3">
      <input type="hidden" name="submissionId" value={submissionId} />
      <input type="hidden" name="decision" value={decision} />
      <div className="grid gap-2 sm:grid-cols-3">
        <Button
          type="button"
          size="sm"
          variant={decision === "approved" ? "primary" : "secondary"}
          onClick={() => setDecision("approved")}
        >
          <Check className="h-4 w-4" />
          Approve
        </Button>
        <Button
          type="button"
          size="sm"
          variant={decision === "changes_requested" ? "primary" : "secondary"}
          onClick={() => setDecision("changes_requested")}
        >
          <RotateCcw className="h-4 w-4" />
          Return
        </Button>
        <Button
          type="button"
          size="sm"
          variant={decision === "rejected" ? "danger" : "secondary"}
          onClick={() => setDecision("rejected")}
        >
          <X className="h-4 w-4" />
          Reject
        </Button>
      </div>
      <Textarea
        name="reviewNotes"
        className="min-h-20"
        placeholder={
          decision === "approved"
            ? "Optional approval note"
            : "Required: tell the worker what needs attention"
        }
        required={decision !== "approved"}
      />
      {state.error && <p className="text-sm text-[#913a31]">{state.error}</p>}
      {state.message && <p className="text-sm font-semibold text-[#2f6249]">{state.message}</p>}
      <Button
        type="submit"
        className="w-full"
        variant={decision === "rejected" ? "danger" : "primary"}
      >
        Confirm {decision.replace("_", " ")}
      </Button>
    </form>
  );
}
