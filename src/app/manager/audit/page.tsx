import { History } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Card } from "@/components/ui/card";
import { createClient } from "@/lib/supabase/server";
import { formatDate, titleCase } from "@/lib/utils";

type AuditRow = {
  id: number;
  action: string;
  entity_type: string;
  entity_id: string;
  before: unknown;
  after: unknown;
  created_at: string;
  actor: { display_name: string; role: string } | null;
};
export const metadata = { title: "Audit history" };
export default async function AuditPage() {
  const supabase = await createClient();
  const { data } = await supabase
    .from("audit_event")
    .select(
      "id,action,entity_type,entity_id,before,after,created_at,actor:actor_user_id(display_name,role)",
    )
    .order("created_at", { ascending: false })
    .limit(200);
  const events = (data ?? []) as unknown as AuditRow[];
  return (
    <>
      <PageHeader
        eyebrow="Accountability"
        title="Audit history"
        description="An append-only record of scope, schedule, assignment, status and pricing changes."
      />
      <Card className="overflow-hidden">
        <div className="divide-y divide-[#e9e5dd]">
          {events.map((event) => (
            <details key={event.id} className="group">
              <summary className="grid cursor-pointer grid-cols-[38px_minmax(0,1fr)] items-center gap-3 px-5 py-4 hover:bg-[#faf9f6] sm:grid-cols-[38px_minmax(0,1fr)_auto]">
                <div className="grid h-9 w-9 place-items-center rounded-xl bg-[#e6f3f8] text-[#0077a8]">
                  <History className="h-4 w-4" />
                </div>
                <div className="min-w-0 break-words">
                  <p className="text-sm font-semibold">
                    {titleCase(event.action.replace(".", " "))}
                  </p>
                  <p className="mt-0.5 text-xs text-[#78817f]">
                    {event.actor?.display_name ?? "System"} · {event.entity_type} #{event.entity_id}
                  </p>
                </div>
                <time className="col-start-2 text-xs text-[#78817f] sm:col-start-auto">
                  {formatDate(event.created_at, "d MMM yyyy, h:mm a")}
                </time>
              </summary>
              <div className="grid gap-3 border-t border-[#eeeae3] bg-[#f8f6f1] p-4 md:grid-cols-2">
                <div className="min-w-0 break-words">
                  <p className="mb-2 text-xs font-bold tracking-wider text-[#7a8380] uppercase">
                    Before
                  </p>
                  <pre className="max-h-72 overflow-auto rounded-xl bg-[#23312f] p-3 text-xs leading-5 text-[#e9eeec]">
                    {JSON.stringify(event.before, null, 2) ?? "-"}
                  </pre>
                </div>
                <div className="min-w-0 break-words">
                  <p className="mb-2 text-xs font-bold tracking-wider text-[#7a8380] uppercase">
                    After
                  </p>
                  <pre className="max-h-72 overflow-auto rounded-xl bg-[#23312f] p-3 text-xs leading-5 text-[#e9eeec]">
                    {JSON.stringify(event.after, null, 2) ?? "-"}
                  </pre>
                </div>
              </div>
            </details>
          ))}
          {!events.length && (
            <p className="p-12 text-center text-sm text-[#7a8380]">
              Audit events will appear after the first change.
            </p>
          )}
        </div>
      </Card>
    </>
  );
}
