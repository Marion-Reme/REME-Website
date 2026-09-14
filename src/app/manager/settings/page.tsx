import { DatabaseBackup, KeyRound, MessageSquareText, ShieldCheck } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { SettingsForm } from "@/components/settings-form";
import { TeamSettings, type TeamMember } from "@/components/team-settings";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Settings" };
export default async function SettingsPage() {
  const profile = await requireRole("manager");
  const supabase = await createClient();
  const [{ data: tenant }, { data: teamData }] = await Promise.all([
    supabase
      .from("tenant")
      .select("name,abn,retention_years,sms_enabled,mfa_required_for_managers")
      .eq("id", profile.tenant_id)
      .single(),
    supabase
      .from("user_profile")
      .select("id,display_name,email,phone,role,is_active")
      .eq("tenant_id", profile.tenant_id)
      .is("deleted_at", null)
      .order("display_name"),
  ]);
  if (!tenant) return null;
  const team = (teamData ?? []) as TeamMember[];

  return (
    <>
      <PageHeader
        eyebrow="Configuration"
        title="Company settings"
        description="Manage company defaults, security and who can access your organisation."
      />
      <div className="grid gap-6 xl:grid-cols-[1fr_380px]">
        <Card className="p-5 sm:p-6">
          <SettingsForm tenant={tenant} />
        </Card>
        <div className="space-y-4">
          <Card className="p-5">
            <div className="flex items-start gap-3">
              <div className="grid h-10 w-10 place-items-center rounded-xl bg-[#e1eee8] text-[#2f6249]">
                <ShieldCheck className="h-5 w-5" />
              </div>
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="font-semibold">Pricing isolation</h2>
                  <Badge tone="green">Enforced</Badge>
                </div>
                <p className="mt-1 text-sm leading-6 text-[#707a77]">
                  Financial rows, original PDFs and full audit values are manager-only under
                  Postgres RLS.
                </p>
              </div>
            </div>
          </Card>
          <Card className="p-5">
            <div className="flex items-start gap-3">
              <KeyRound className="mt-0.5 h-5 w-5 text-[#0077a8]" />
              <div>
                <h2 className="font-semibold">Multi-factor authentication</h2>
                <p className="mt-1 text-sm leading-6 text-[#707a77]">
                  {profile.mfa_enrolled
                    ? "Your authenticator is enrolled."
                    : "Your account still needs an authenticator."}
                </p>
                {!profile.mfa_enrolled && (
                  <a
                    href="/security/mfa-enrol"
                    className="mt-2 inline-block text-sm font-semibold text-[#0077a8]"
                  >
                    Set up MFA
                  </a>
                )}
              </div>
            </div>
          </Card>
          <Card className="p-5">
            <div className="flex items-start gap-3">
              <MessageSquareText className="mt-0.5 h-5 w-5 text-[#0077a8]" />
              <div>
                <h2 className="font-semibold">External services</h2>
                <p className="mt-1 text-sm leading-6 text-[#707a77]">
                  Resend and Twilio stay dormant until credentials are configured. In-app
                  notifications work without them.
                </p>
              </div>
            </div>
          </Card>
          <Card className="p-5">
            <div className="flex items-start gap-3">
              <DatabaseBackup className="mt-0.5 h-5 w-5 text-[#0077a8]" />
              <div>
                <h2 className="font-semibold">Backups</h2>
                <p className="mt-1 text-sm leading-6 text-[#707a77]">
                  Enable Supabase PITR and schedule the provided weekly logical-backup workflow
                  before live data is entered.
                </p>
              </div>
            </div>
          </Card>
        </div>
      </div>
      <Card className="mt-6 p-5 sm:p-6">
        <TeamSettings members={team} currentUserId={profile.id} />
      </Card>
    </>
  );
}
