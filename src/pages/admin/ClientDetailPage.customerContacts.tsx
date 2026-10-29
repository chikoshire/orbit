/**
 * Admin client detail (/clients/:id) — add the Customer contacts tab here.
 * Stakeholder contacts (client_contacts) stay on their existing tab.
 */
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAdminAccess } from "@/hooks/useAdminAccess";
import { ClientCustomerContactsTab } from "@/components/admin/clients/customer-contacts/ClientCustomerContactsTab";

type Props = {
  clientId: string;
};

export function ClientDetailCustomerContactsSection({ clientId }: Props) {
  const { isAdmin } = useAdminAccess();

  if (!isAdmin) {
    return null;
  }

  return (
    <Tabs defaultValue="stakeholders" data-orbit-id="src/pages/admin/ClientDetailPage.customerContacts.tsx:21:5">
      <TabsList>
        <TabsTrigger value="stakeholders">Stakeholder contacts</TabsTrigger>
        <TabsTrigger value="customer-contacts">Customer contacts</TabsTrigger>
      </TabsList>
      <TabsContent value="stakeholders">
        {/* Existing client_contacts UI remains here in the private app tree. */}
      </TabsContent>
      <TabsContent value="customer-contacts">
        <ClientCustomerContactsTab clientId={clientId} isAdmin={isAdmin} />
      </TabsContent>
    </Tabs>
  );
}
