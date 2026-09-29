import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import {
  WorkOrderDetailsForm,
  type WorkOrderDetailsDefaults,
} from "@/components/work-order-details-form";
import { createClient } from "@/lib/supabase/server";

type EditableWorkOrder = {
  id: number;
  work_order_number: string;
  job_number: string | null;
  client_reference: string | null;
  client_supervisor_name: string | null;
  client_supervisor_phone: string | null;
  issued_at: string | null;
  start_date: string | null;
  completion_due_date: string | null;
  notes: string | null;
  additional_instructions: string | null;
  duplicate_reason: string | null;
  client: { name: string } | null;
  customer: { name: string; phone: string | null } | null;
  site: {
    street_address: string;
    suburb: string;
    state: string;
    postcode: string;
    site_contact: Array<{ id: number; name: string; phone: string | null }>;
  } | null;
  work_order_totals: { total_cents: number } | null;
};

export const metadata = { title: "Edit work order" };

// issued_at is a timestamp; the form edits the Sydney calendar date.
function sydneyDate(value: string | null) {
  if (!value) return "";
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney" }).format(new Date(value));
}

export default async function EditWorkOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const workOrderId = Number(id);
  if (!Number.isInteger(workOrderId)) notFound();
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("work_order")
    .select(
      "id,work_order_number,job_number,client_reference,client_supervisor_name,client_supervisor_phone,issued_at,start_date,completion_due_date,notes,additional_instructions,duplicate_reason,client:client_id(name),customer:customer_id(name,phone),site:site_id(street_address,suburb,state,postcode,site_contact(id,name,phone)),work_order_totals(total_cents)",
    )
    .eq("id", workOrderId)
    .single();
  if (error?.code === "PGRST116") notFound();
  if (error) throw new Error(`Could not load work order: ${error.message}`);
  if (!data) notFound();
  const order = data as unknown as EditableWorkOrder;
  const contact = [...(order.site?.site_contact ?? [])].sort((a, b) => a.id - b.id)[0];
  const defaults: WorkOrderDetailsDefaults = {
    clientName: order.client?.name ?? "",
    customerName: order.customer?.name ?? "",
    customerPhone: order.customer?.phone ?? "",
    streetAddress: order.site?.street_address ?? "",
    suburb: order.site?.suburb ?? "",
    state: order.site?.state ?? "NSW",
    postcode: order.site?.postcode ?? "",
    siteContactName: contact?.name ?? "",
    siteContactPhone: contact?.phone ?? "",
    workOrderNumber: order.work_order_number,
    jobNumber: order.job_number ?? "",
    clientReference: order.client_reference ?? "",
    supervisorName: order.client_supervisor_name ?? "",
    supervisorPhone: order.client_supervisor_phone ?? "",
    issuedAt: sydneyDate(order.issued_at),
    startDate: order.start_date ?? "",
    dueDate: order.completion_due_date ?? "",
    notes: order.notes ?? "",
    additionalInstructions: order.additional_instructions ?? "",
    totalCents: order.work_order_totals?.total_cents ?? 0,
    duplicateReason: order.duplicate_reason ?? "",
  };
  return (
    <>
      <PageHeader
        eyebrow="Edit work order"
        title={order.work_order_number}
        description="Change the client, site, references, dates, instructions or total. Jobs are edited, added and deleted on the work order page."
        actions={
          <Link
            href={`/manager/work-orders/${order.id}`}
            className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-[#d9d4c9] bg-white px-4 text-sm font-semibold"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to work order
          </Link>
        }
      />
      <WorkOrderDetailsForm workOrderId={order.id} defaults={defaults} />
    </>
  );
}
