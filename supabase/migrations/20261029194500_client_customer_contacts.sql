-- Client-owned customer contact lists (isolated from TUXX CRM / inbox_contacts).
-- IMPORTANT: Never copy rows from client_customer_contacts into inbox_contacts.

-- ---------------------------------------------------------------------------
-- Imports metadata
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.client_contact_imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  label text NOT NULL,
  source text NOT NULL,
  file_name text,
  row_count integer NOT NULL DEFAULT 0,
  imported_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS client_contact_imports_client_id_idx
  ON public.client_contact_imports (client_id);

CREATE INDEX IF NOT EXISTS client_contact_imports_client_source_idx
  ON public.client_contact_imports (client_id, source);

-- ---------------------------------------------------------------------------
-- Customer contacts (client data — not CRM)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.client_customer_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  import_id uuid REFERENCES public.client_contact_imports(id) ON DELETE SET NULL,
  name text,
  company text,
  email text,
  phone text,
  address text,
  postcode text,
  contact_types text[] NOT NULL DEFAULT '{}'::text[],
  tags text[] NOT NULL DEFAULT '{}'::text[],
  source text NOT NULL,
  source_detail text,
  date_added date,
  do_not_contact boolean NOT NULL DEFAULT true,
  contact_permission text NOT NULL DEFAULT 'do_not_contact_without_approval',
  notes text,
  custom_fields jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT client_customer_contacts_identity_check CHECK (
    NULLIF(btrim(coalesce(email, '')), '') IS NOT NULL
    OR NULLIF(btrim(coalesce(phone, '')), '') IS NOT NULL
    OR NULLIF(btrim(coalesce(name, '')), '') IS NOT NULL
  ),
  CONSTRAINT client_customer_contacts_contact_permission_check CHECK (
    contact_permission IN (
      'do_not_contact_without_approval',
      'approved',
      'opted_out'
    )
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS client_customer_contacts_client_email_unique
  ON public.client_customer_contacts (client_id, lower(email))
  WHERE email IS NOT NULL;

CREATE INDEX IF NOT EXISTS client_customer_contacts_client_id_idx
  ON public.client_customer_contacts (client_id);

CREATE INDEX IF NOT EXISTS client_customer_contacts_client_source_idx
  ON public.client_customer_contacts (client_id, source);

CREATE INDEX IF NOT EXISTS client_customer_contacts_tags_gin_idx
  ON public.client_customer_contacts USING gin (tags);

CREATE INDEX IF NOT EXISTS client_customer_contacts_contact_types_gin_idx
  ON public.client_customer_contacts USING gin (contact_types);

CREATE TRIGGER client_customer_contacts_set_updated_at
  BEFORE UPDATE ON public.client_customer_contacts
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at();

COMMENT ON TABLE public.client_customer_contacts IS
  'Per-client customer lists. Isolated from TUXX CRM (inbox_contacts). Do not sync to sequences, outreach, or inbox_contacts.';

COMMENT ON TABLE public.client_contact_imports IS
  'Batch import metadata for client_customer_contacts. No CRM automation side effects.';

-- ---------------------------------------------------------------------------
-- Permission change audit (admin-only reads)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.client_contact_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  contact_id uuid REFERENCES public.client_customer_contacts(id) ON DELETE SET NULL,
  import_id uuid REFERENCES public.client_contact_imports(id) ON DELETE SET NULL,
  actor_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  action text NOT NULL,
  old_value jsonb,
  new_value jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS client_contact_audit_client_id_idx
  ON public.client_contact_audit (client_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Portal flag on clients
-- ---------------------------------------------------------------------------
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS portal_can_view_customer_contacts boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.clients.portal_can_view_customer_contacts IS
  'When true, client portal users may SELECT client_customer_contacts for this client.';

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
ALTER TABLE public.client_contact_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_customer_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_contact_audit ENABLE ROW LEVEL SECURITY;

CREATE POLICY client_contact_imports_admin_all
  ON public.client_contact_imports
  FOR ALL
  TO authenticated
  USING (public.has_role((SELECT auth.uid()), 'admin'))
  WITH CHECK (public.has_role((SELECT auth.uid()), 'admin'));

CREATE POLICY client_customer_contacts_admin_all
  ON public.client_customer_contacts
  FOR ALL
  TO authenticated
  USING (public.has_role((SELECT auth.uid()), 'admin'))
  WITH CHECK (public.has_role((SELECT auth.uid()), 'admin'));

CREATE POLICY client_customer_contacts_portal_select
  ON public.client_customer_contacts
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.clients c
      WHERE c.id = client_customer_contacts.client_id
        AND c.portal_can_view_customer_contacts = true
        AND public.user_belongs_to_client((SELECT auth.uid()), c.id)
    )
  );

CREATE POLICY client_contact_audit_admin_select
  ON public.client_contact_audit
  FOR SELECT
  TO authenticated
  USING (public.has_role((SELECT auth.uid()), 'admin'));

CREATE POLICY client_contact_audit_admin_insert
  ON public.client_contact_audit
  FOR INSERT
  TO authenticated
  WITH CHECK (public.has_role((SELECT auth.uid()), 'admin'));

-- ---------------------------------------------------------------------------
-- Grants: authenticated via RLS; never expose to anon
-- ---------------------------------------------------------------------------
REVOKE ALL ON public.client_contact_imports FROM anon;
REVOKE ALL ON public.client_customer_contacts FROM anon;
REVOKE ALL ON public.client_contact_audit FROM anon;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.client_contact_imports TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.client_customer_contacts TO authenticated;
GRANT SELECT, INSERT ON public.client_contact_audit TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.client_contact_imports TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.client_customer_contacts TO service_role;
GRANT SELECT, INSERT ON public.client_contact_audit TO service_role;

-- ---------------------------------------------------------------------------
-- Admin RPC: update contact_permission with audit trail
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_client_customer_contact_permission(
  p_contact_id uuid,
  p_contact_permission text
)
RETURNS public.client_customer_contacts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  v_row public.client_customer_contacts;
  v_old text;
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'admin role required';
  END IF;

  IF p_contact_permission NOT IN (
    'do_not_contact_without_approval',
    'approved',
    'opted_out'
  ) THEN
    RAISE EXCEPTION 'invalid contact_permission';
  END IF;

  SELECT * INTO v_row
  FROM public.client_customer_contacts
  WHERE id = p_contact_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'contact not found';
  END IF;

  v_old := v_row.contact_permission;

  UPDATE public.client_customer_contacts
  SET contact_permission = p_contact_permission
  WHERE id = p_contact_id
  RETURNING * INTO v_row;

  IF v_old IS DISTINCT FROM p_contact_permission THEN
    INSERT INTO public.client_contact_audit (
      client_id,
      contact_id,
      actor_id,
      action,
      old_value,
      new_value
    ) VALUES (
      v_row.client_id,
      v_row.id,
      auth.uid(),
      'contact_permission_changed',
      jsonb_build_object('contact_permission', v_old),
      jsonb_build_object('contact_permission', p_contact_permission)
    );
  END IF;

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.set_client_customer_contact_permission(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_client_customer_contact_permission(uuid, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- Admin RPC: undo import (delete contacts by import_id, then import row)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.undo_client_contact_import(p_import_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  v_import public.client_contact_imports;
  v_deleted integer;
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'admin role required';
  END IF;

  SELECT * INTO v_import
  FROM public.client_contact_imports
  WHERE id = p_import_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'import not found';
  END IF;

  DELETE FROM public.client_customer_contacts
  WHERE import_id = p_import_id;

  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  DELETE FROM public.client_contact_imports
  WHERE id = p_import_id;

  INSERT INTO public.client_contact_audit (
    client_id,
    import_id,
    actor_id,
    action,
    new_value
  ) VALUES (
    v_import.client_id,
    p_import_id,
    auth.uid(),
    'import_undone',
    jsonb_build_object('deleted_contacts', v_deleted)
  );

  RETURN jsonb_build_object(
    'import_id', p_import_id,
    'deleted_contacts', v_deleted
  );
END;
$$;

REVOKE ALL ON FUNCTION public.undo_client_contact_import(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.undo_client_contact_import(uuid) TO authenticated;
