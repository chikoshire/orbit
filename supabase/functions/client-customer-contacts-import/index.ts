import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  buildInsertPayload,
  mapHeaders,
  parseCsv,
  parseCustomerContactRow,
} from "../../../src/lib/clientCustomerContacts/importMapping.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

type ImportRequest = {
  clientId: string;
  label: string;
  source: string;
  fileName?: string;
  csvText: string;
  notes?: string;
};

const BATCH_SIZE = 200;

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceKey);

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return json({ error: "missing_authorization" }, 401);
    }

    const token = authHeader.replace("Bearer ", "");
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser(token);

    if (authError || !user) {
      return json({ error: "invalid_token" }, 401);
    }

    const { data: adminRole, error: roleError } = await supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id)
      .eq("role", "admin")
      .maybeSingle();

    if (roleError || !adminRole) {
      return json({ error: "admin_required" }, 403);
    }

    const body = (await req.json()) as ImportRequest;
    if (!body.clientId || !body.label?.trim() || !body.source?.trim() || !body.csvText) {
      return json({ error: "invalid_payload" }, 400);
    }

    const matrix = parseCsv(body.csvText);
    if (matrix.length < 2) {
      return json({ error: "empty_file" }, 400);
    }

    const headerMap = mapHeaders(matrix[0]);
    const dataRows = matrix.slice(1);

    const { data: importRow, error: importError } = await supabase
      .from("client_contact_imports")
      .insert({
        client_id: body.clientId,
        label: body.label.trim(),
        source: body.source.trim(),
        file_name: body.fileName ?? null,
        row_count: dataRows.length,
        imported_by: user.id,
        notes: body.notes ?? null,
      })
      .select("*")
      .single();

    if (importError || !importRow) {
      console.error(importError);
      return json({ error: "import_row_failed" }, 500);
    }

    let created = 0;
    let skippedDuplicate = 0;
    let invalid = 0;
    const batch: Record<string, unknown>[] = [];

    const flush = async () => {
      while (batch.length > 0) {
        const payload = batch.shift();
        if (!payload) break;
        const { error } = await supabase.from("client_customer_contacts").insert(payload);
        if (error) {
          if (error.code === "23505") {
            skippedDuplicate += 1;
          } else {
            console.error(error);
            invalid += 1;
          }
        } else {
          created += 1;
        }
      }
    };

    for (const cells of dataRows) {
      const parsed = parseCustomerContactRow(cells, headerMap);
      if (!parsed.ok) {
        invalid += 1;
        continue;
      }

      batch.push(
        buildInsertPayload(
          body.clientId,
          importRow.id,
          body.source.trim(),
          parsed.row,
        ),
      );

      if (batch.length >= BATCH_SIZE) {
        await flush();
      }
    }

    await flush();

    await supabase
      .from("client_contact_imports")
      .update({ row_count: created })
      .eq("id", importRow.id);

    return json({
      ok: true,
      importId: importRow.id,
      created,
      skippedDuplicate,
      invalid,
      totalRows: dataRows.length,
    });
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : String(err);
    return json({ error: message }, 500);
  }
});

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
