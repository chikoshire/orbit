-- Rollback: client customer contacts store (20261029194500_client_customer_contacts.sql)

DROP FUNCTION IF EXISTS public.undo_client_contact_import(uuid);
DROP FUNCTION IF EXISTS public.set_client_customer_contact_permission(uuid, text);

DROP POLICY IF EXISTS client_contact_audit_admin_insert ON public.client_contact_audit;
DROP POLICY IF EXISTS client_contact_audit_admin_select ON public.client_contact_audit;
DROP POLICY IF EXISTS client_customer_contacts_portal_select ON public.client_customer_contacts;
DROP POLICY IF EXISTS client_customer_contacts_admin_all ON public.client_customer_contacts;
DROP POLICY IF EXISTS client_contact_imports_admin_all ON public.client_contact_imports;

DROP TRIGGER IF EXISTS client_customer_contacts_set_updated_at ON public.client_customer_contacts;

DROP TABLE IF EXISTS public.client_contact_audit;
DROP TABLE IF EXISTS public.client_customer_contacts;
DROP TABLE IF EXISTS public.client_contact_imports;

ALTER TABLE public.clients
  DROP COLUMN IF EXISTS portal_can_view_customer_contacts;
