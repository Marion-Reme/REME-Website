"use server";

import { redirect } from "next/navigation";
import { hasSupabaseConfig } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";
import { logger } from "@/lib/redact";

export type AuthState = { error?: string; message?: string };

export async function signIn(_: AuthState, formData: FormData): Promise<AuthState> {
  if (!hasSupabaseConfig())
    return {
      error:
        "Supabase is not configured. Copy .env.example to .env.local and add your project keys.",
    };
  const email = String(formData.get("email") ?? "")
    .trim()
    .toLowerCase();
  const password = String(formData.get("password") ?? "");
  if (!email || !password) return { error: "Enter your email and password." };
  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return { error: "The email or password is incorrect." };
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { data: profile } = await supabase
    .from("user_profile")
    .select("role, mfa_enrolled, tenant_id")
    .eq("id", user!.id)
    .single();
  if (!profile) return { error: "Your account is not provisioned. Ask a manager for help." };
  if (profile.role === "manager") {
    const { data: tenant } = await supabase
      .from("tenant")
      .select("mfa_required_for_managers")
      .eq("id", profile.tenant_id)
      .single();
    if (tenant?.mfa_required_for_managers && !profile.mfa_enrolled) redirect("/security/mfa-enrol");
    if (profile.mfa_enrolled) {
      const { data } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      if (!data || data.currentLevel !== "aal2") redirect("/mfa");
    }
    redirect("/manager");
  }
  redirect("/worker");
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/sign-in");
}

export async function requestPasswordReset(_: AuthState, formData: FormData): Promise<AuthState> {
  const email = String(formData.get("email") ?? "")
    .trim()
    .toLowerCase();
  if (!email) return { error: "Enter your email address." };
  if (!hasSupabaseConfig()) return { error: "Supabase is not configured." };
  const supabase = await createClient();
  await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"}/auth/callback?next=/update-password`,
  });
  return { message: "If that account exists, a reset link is on its way." };
}

export async function updatePassword(_: AuthState, formData: FormData): Promise<AuthState> {
  const password = String(formData.get("password") ?? "");
  const confirmPassword = String(formData.get("confirmPassword") ?? "");
  const intent = formData.get("intent") === "invite" ? "invite" : "recovery";
  if (password.length < 8) return { error: "Use at least 8 characters." };
  if (password !== confirmPassword) return { error: "The passwords do not match." };
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return {
      error: "This password link is invalid or has expired. Request a new link and try again.",
    };
  const { error } = await supabase.auth.updateUser({ password });
  // Auth validation messages ("should be different from the old password")
  // are the only guidance the user gets here, so they are kept.
  if (error) {
    logger.error("auth.update_password_rejected", error);
    return { error: error.message };
  }
  if (intent === "invite") {
    await supabase.auth.signOut();
    redirect("/sign-in?setup=complete");
  }
  redirect("/");
}
