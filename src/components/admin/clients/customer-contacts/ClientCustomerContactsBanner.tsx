import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ShieldAlert } from "lucide-react";

export function ClientCustomerContactsBanner() {
  return (
    <Alert
      variant="destructive"
      className="border-amber-500/40 bg-amber-500/10 text-amber-950 dark:text-amber-100"
      data-orbit-id="src/components/admin/clients/customer-contacts/ClientCustomerContactsBanner.tsx:8:5"
    >
      <ShieldAlert className="h-4 w-4" />
      <AlertTitle>Client data — not TUXX CRM</AlertTitle>
      <AlertDescription>
        These contacts belong to the client. Do not contact anyone without the
        client&apos;s approval. There is no sequence, enrichment, or CRM export
        from this list.
      </AlertDescription>
    </Alert>
  );
}
