"use client";

import { useActionState } from "react";
import { requestPasswordReset, updatePassword, type AuthState } from "@/actions/auth";
import { Input, Label } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";

export function PasswordForm({
  mode,
  intent = "recovery",
}: {
  mode: "request" | "update";
  intent?: "invite" | "recovery";
}) {
  const [state, action] = useActionState(
    mode === "request" ? requestPasswordReset : updatePassword,
    {} as AuthState,
  );
  return (
    <form action={action} className="space-y-4">
      {mode === "request" ? (
        <div>
          <Label htmlFor="email">Email</Label>
          <Input id="email" name="email" type="email" required autoComplete="email" />
        </div>
      ) : (
        <>
          <input type="hidden" name="intent" value={intent} />
          <div>
            <Label htmlFor="password">
              New password <span className="font-normal text-[#7c8582]">(8+ characters)</span>
            </Label>
            <Input
              id="password"
              name="password"
              type="password"
              required
              minLength={8}
              autoComplete="new-password"
            />
          </div>
          <div>
            <Label htmlFor="confirmPassword">Confirm new password</Label>
            <Input
              id="confirmPassword"
              name="confirmPassword"
              type="password"
              required
              minLength={8}
              autoComplete="new-password"
            />
          </div>
        </>
      )}
      {state.error && (
        <p role="alert" className="rounded-xl bg-[#f5dfdc] p-3 text-sm text-[#913a31]">
          {state.error}
        </p>
      )}
      {state.message && (
        <p role="status" className="rounded-xl bg-[#e1eee8] p-3 text-sm text-[#2f6249]">
          {state.message}
        </p>
      )}
      <SubmitButton className="w-full">
        {mode === "request"
          ? "Send reset link"
          : intent === "invite"
            ? "Create password"
            : "Set new password"}
      </SubmitButton>
    </form>
  );
}
