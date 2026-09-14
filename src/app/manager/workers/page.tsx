import { BriefcaseBusiness, UserPlus } from "lucide-react";
import {
  InviteWorkerForm,
  DisableWorkerForm,
  EnableWorkerForm,
  RemoveWorkerForm,
} from "@/components/worker-admin-forms";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { createClient } from "@/lib/supabase/server";
import { initials } from "@/lib/utils";

type WorkerRow = {
  id: number;
  trade_specialties: string[];
  default_daily_capacity: number;
  sms_opt_in: boolean;
  user_profile: {
    id: string;
    display_name: string;
    email: string;
    phone: string | null;
    is_active: boolean;
    disabled_reason: string | null;
    mfa_enrolled: boolean;
  } | null;
  assignment: Array<{ status: string; task: { status: string } | null }>;
};
export const metadata = { title: "Workers" };
export default async function WorkersPage() {
  const supabase = await createClient();
  const { data } = await supabase
    .from("worker")
    .select(
      "id,trade_specialties,default_daily_capacity,sms_opt_in,user_profile:user_id!inner(id,display_name,email,phone,is_active,disabled_reason,mfa_enrolled),assignment(status,task:task_id(status))",
    )
    .is("user_profile.deleted_at", null)
    .order("created_at");
  const workers = (data ?? []) as unknown as WorkerRow[];
  return (
    <>
      <PageHeader
        eyebrow="Team"
        title="Workers"
        description="Invite field workers, see current load, and disable or restore accounts."
      />
      <div className="grid gap-6 xl:grid-cols-[1fr_330px]">
        <Card className="overflow-hidden">
          <div className="grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-3">
            {workers.map((worker) => {
              const open = worker.assignment.filter(
                (a) =>
                  a.status !== "reassigned" &&
                  a.task &&
                  !["completed", "cancelled"].includes(a.task.status),
              ).length;
              return (
                <article
                  key={worker.id}
                  className="rounded-2xl border border-[#e0dcd3] bg-[#faf9f6] p-4"
                >
                  <div className="flex items-start gap-3">
                    <div className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-[#003f70] text-sm font-bold text-white">
                      {initials(worker.user_profile?.display_name ?? "W")}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-semibold">{worker.user_profile?.display_name}</p>
                      <p className="truncate text-xs text-[#7b8582]">
                        {worker.user_profile?.email}
                      </p>
                    </div>
                    <Badge tone={worker.user_profile?.is_active ? "green" : "neutral"}>
                      {worker.user_profile?.is_active ? "Active" : "Disabled"}
                    </Badge>
                  </div>
                  <div className="mt-4 flex items-center justify-between rounded-xl bg-white p-3">
                    <span className="flex items-center gap-2 text-sm text-[#6a7571]">
                      <BriefcaseBusiness className="h-4 w-4" />
                      Open tasks
                    </span>
                    <strong>{open}</strong>
                  </div>
                  {worker.trade_specialties.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-1">
                      {worker.trade_specialties.map((trade) => (
                        <Badge key={trade}>{trade}</Badge>
                      ))}
                    </div>
                  )}
                  {worker.user_profile &&
                    (worker.user_profile.is_active ? (
                      <details className="mt-3">
                        <summary className="cursor-pointer text-xs font-semibold text-[#913a31]">
                          Disable account
                        </summary>
                        <div className="mt-2">
                          <DisableWorkerForm userId={worker.user_profile.id} />
                        </div>
                      </details>
                    ) : (
                      <div className="mt-3 space-y-2">
                        {worker.user_profile.disabled_reason && (
                          <p className="text-xs leading-5 text-[#7b8582]">
                            Disabled: {worker.user_profile.disabled_reason}
                          </p>
                        )}
                        <EnableWorkerForm userId={worker.user_profile.id} />
                        <RemoveWorkerForm userId={worker.user_profile.id} />
                      </div>
                    ))}
                </article>
              );
            })}
            {!workers.length && (
              <div className="col-span-full py-12 text-center text-sm text-[#7a8380]">
                No workers yet. Send the first invitation.
              </div>
            )}
          </div>
        </Card>
        <Card className="h-fit p-5">
          <div className="mb-4 flex items-center gap-2">
            <UserPlus className="h-5 w-5 text-[#0077a8]" />
            <h2 className="font-semibold">Invite a worker</h2>
          </div>
          <p className="mb-4 text-sm leading-6 text-[#717b78]">
            They receive a secure email invitation and cannot see any work until the invite is
            accepted.
          </p>
          <InviteWorkerForm />
        </Card>
      </div>
    </>
  );
}
