"use server";

import { revalidatePath } from "next/cache";
import { assertRole } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { logger } from "@/lib/redact";
import { actionError } from "@/actions/errors";
import type { ActionState } from "@/actions/types";

export async function inviteWorker(_: ActionState, formData: FormData): Promise<ActionState> {
  const manager = await assertRole("manager");
  const displayName = String(formData.get("displayName") ?? "").trim();
  const email = String(formData.get("email") ?? "")
    .trim()
    .toLowerCase();
  const phone = String(formData.get("phone") ?? "").trim();
  if (displayName.length < 2 || !email.includes("@"))
    return { error: "Enter the worker's name and a valid email." };
  try {
    const admin = createAdminClient();
    const { error } = await admin.auth.admin.inviteUserByEmail(email, {
      data: { tenant_id: manager.tenant_id, role: "worker", display_name: displayName, phone },
      redirectTo: `${process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"}/auth/callback?next=/update-password&intent=invite`,
    });
    if (error) {
      logger.error("worker.invite_rejected", error);
      return { error: error.message };
    }
  } catch (error) {
    logger.error("worker.invite_failed", error);
    return { error: error instanceof Error ? error.message : "The invitation could not be sent." };
  }
  revalidatePath("/manager/workers");
  return { ok: true, message: `Invitation sent to ${email}.` };
}

export async function disableWorker(_: ActionState, formData: FormData): Promise<ActionState> {
  const manager = await assertRole("manager");
  const userId = String(formData.get("userId") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();
  if (!userId || !reason) return { error: "A reason is required." };
  const supabase = await createClient();
  const { data: updated, error } = await supabase
    .from("user_profile")
    .update({ is_active: false, disabled_at: new Date().toISOString(), disabled_reason: reason })
    .eq("id", userId)
    .eq("tenant_id", manager.tenant_id)
    .eq("role", "worker")
    .select("id");
  if (error) return actionError("worker.disable", error, "The worker could not be disabled.");
  // A filtered update that matches nothing is not an error. Banning before
  // confirming the match handed the admin client -- which has no RLS -- a user
  // id that may belong to another tenant.
  if (!updated?.length) return { error: "That worker is not on your team." };
  const admin = createAdminClient();
  await admin.auth.admin.updateUserById(userId, { ban_duration: "876000h" });
  revalidatePath("/manager/workers");
  revalidatePath("/manager/settings");
  return {
    ok: true,
    message: "Worker disabled. They can no longer sign in - reassign their open work.",
  };
}

export async function enableWorker(_: ActionState, formData: FormData): Promise<ActionState> {
  const manager = await assertRole("manager");
  const userId = String(formData.get("userId") ?? "");
  if (!userId) return { error: "Choose the worker to re-enable." };
  const supabase = await createClient();
  // The tenant and role check happens here, on the RLS-bound client, because
  // the admin client below would happily unban an id from another tenant.
  const { data: target, error: lookupError } = await supabase
    .from("user_profile")
    .select("id")
    .eq("id", userId)
    .eq("tenant_id", manager.tenant_id)
    .eq("role", "worker")
    .maybeSingle();
  if (lookupError)
    return actionError("worker.enable_lookup", lookupError, "The worker could not be re-enabled.");
  if (!target) return { error: "That worker is not on your team." };

  // The sign-in ban is lifted first. The other order would paint the card green
  // while the ban still locked the worker out, which is the silent half of a
  // disable that nobody could see from the app.
  const admin = createAdminClient();
  const { error: banError } = await admin.auth.admin.updateUserById(userId, {
    ban_duration: "none",
  });
  if (banError) {
    logger.error("worker.enable_unban_failed", banError);
    return { error: "The sign-in ban could not be lifted. Try again." };
  }

  const { error } = await supabase
    .from("user_profile")
    .update({ is_active: true, disabled_at: null, disabled_reason: null })
    .eq("id", userId)
    .eq("tenant_id", manager.tenant_id)
    .eq("role", "worker");
  if (error) return actionError("worker.enable", error, "The worker could not be re-enabled.");
  revalidatePath("/manager/workers");
  revalidatePath("/manager/settings");
  return {
    ok: true,
    message: "Worker re-enabled. They can sign in again with their existing password.",
  };
}
