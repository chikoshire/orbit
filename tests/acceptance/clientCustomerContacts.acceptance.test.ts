/**
 * Acceptance tests for client_customer_contacts CRM isolation.
 *
 * Runs only when ORBIT_ACCEPTANCE_SUPABASE_URL and ORBIT_ACCEPTANCE_SERVICE_ROLE_KEY
 * are set (typically a Supabase preview branch — never production).
 */
import { createClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";

const url = process.env.ORBIT_ACCEPTANCE_SUPABASE_URL;
const serviceKey = process.env.ORBIT_ACCEPTANCE_SERVICE_ROLE_KEY;
const clientId =
  process.env.ORBIT_ACCEPTANCE_CLIENT_ID ??
  "62f5d4dc-6f81-45c7-811d-16dc895acb52";

const enabled = Boolean(url && serviceKey);

describe.skipIf(!enabled)("client_customer_contacts acceptance", () => {
  let admin: ReturnType<typeof createClient>;

  beforeAll(() => {
    admin = createClient(url!, serviceKey!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  });

  async function count(table: string, filter?: { column: string; value: string }) {
    let query = admin.from(table).select("*", { count: "exact", head: true });
    if (filter) {
      query = query.eq(filter.column, filter.value);
    }
    const { count, error } = await query;
    if (error) throw error;
    return count ?? 0;
  }

  it("bulk insert does not touch CRM side-effect tables", async () => {
    const before = {
      http: await admin.schema("net").from("_http_response").select("*", { count: "exact", head: true }).then((r) => r.count ?? 0),
      enrollments: await count("sequence_enrollments"),
      campaignLeads: await count("campaign_leads"),
      inboxContacts: await count("inbox_contacts"),
    };

    const { data: importRow, error: importError } = await admin
      .from("client_contact_imports")
      .insert({
        client_id: clientId,
        label: "acceptance bulk",
        source: "acceptance_test_bulk",
        row_count: 1000,
      })
      .select("id")
      .single();

    expect(importError).toBeNull();
    expect(importRow?.id).toBeTruthy();

    const rows = Array.from({ length: 1000 }, (_, index) => ({
      client_id: clientId,
      import_id: importRow!.id,
      name: `Acceptance Contact ${index}`,
      email: index % 2 === 0 ? `acceptance+${index}@example.com` : null,
      phone: index % 2 === 1 ? `+440000${String(index).padStart(6, "0")}` : null,
      source: "acceptance_test_bulk",
      do_not_contact: true,
      contact_permission: "do_not_contact_without_approval",
    }));

    for (let offset = 0; offset < rows.length; offset += 200) {
      const chunk = rows.slice(offset, offset + 200);
      const { error } = await admin.from("client_customer_contacts").insert(chunk);
      expect(error).toBeNull();
    }

    const after = {
      http: await admin.schema("net").from("_http_response").select("*", { count: "exact", head: true }).then((r) => r.count ?? 0),
      enrollments: await count("sequence_enrollments"),
      campaignLeads: await count("campaign_leads"),
      inboxContacts: await count("inbox_contacts"),
    };

    expect(after.http).toBe(before.http);
    expect(after.enrollments).toBe(before.enrollments);
    expect(after.campaignLeads).toBe(before.campaignLeads);
    expect(after.inboxContacts).toBe(before.inboxContacts);

    await admin.from("client_customer_contacts").delete().eq("import_id", importRow!.id);
    await admin.from("client_contact_imports").delete().eq("id", importRow!.id);
  });

  it("undo by import_id restores counts", async () => {
    const { data: importRow } = await admin
      .from("client_contact_imports")
      .insert({
        client_id: clientId,
        label: "acceptance undo",
        source: "acceptance_test_undo",
        row_count: 3,
      })
      .select("id")
      .single();

    await admin.from("client_customer_contacts").insert([
      {
        client_id: clientId,
        import_id: importRow!.id,
        name: "Undo A",
        phone: "+441111",
        source: "acceptance_test_undo",
      },
      {
        client_id: clientId,
        import_id: importRow!.id,
        name: "Undo B",
        email: "undo-b@example.com",
        source: "acceptance_test_undo",
      },
    ]);

    const beforeContacts = await count("client_customer_contacts", {
      column: "import_id",
      value: importRow!.id,
    });
    expect(beforeContacts).toBe(2);

    const { error: undoError } = await admin.rpc("undo_client_contact_import", {
      p_import_id: importRow!.id,
    });
    expect(undoError).toBeNull();

    const afterContacts = await count("client_customer_contacts", {
      column: "import_id",
      value: importRow!.id,
    });
    const importsLeft = await count("client_contact_imports", {
      column: "id",
      value: importRow!.id,
    });

    expect(afterContacts).toBe(0);
    expect(importsLeft).toBe(0);
  });
});
