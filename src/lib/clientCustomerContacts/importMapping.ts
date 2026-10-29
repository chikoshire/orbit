/**
 * Maps spreadsheet columns to client_customer_contacts fields.
 * Customer type values are split on ';' into contact_types.
 */
export type ParsedCustomerContactRow = {
  name: string | null;
  company: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  postcode: string | null;
  contact_types: string[];
  source_detail: string | null;
  date_added: string | null;
};

export type RowParseResult =
  | { ok: true; row: ParsedCustomerContactRow }
  | { ok: false; reason: string };

const HEADER_ALIASES: Record<string, keyof ParsedCustomerContactRow | "skip"> = {
  name: "name",
  company: "company",
  email: "email",
  phone: "phone",
  address: "address",
  postcode: "postcode",
  "customer type": "contact_types",
  "customer types": "contact_types",
  source: "source_detail",
  "date added": "date_added",
};

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function splitContactTypes(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);
}

function parseDateAdded(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const iso = trimmed.match(/^(\d{4}-\d{2}-\d{2})/);
  if (iso) return iso[1];
  const d = new Date(trimmed);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

export function mapHeaders(headers: string[]): Map<number, keyof ParsedCustomerContactRow> {
  const mapping = new Map<number, keyof ParsedCustomerContactRow>();
  headers.forEach((header, index) => {
    const key = HEADER_ALIASES[normalizeHeader(header)];
    if (key && key !== "skip") {
      mapping.set(index, key);
    }
  });
  return mapping;
}

export function parseCustomerContactRow(
  cells: string[],
  headerMap: Map<number, keyof ParsedCustomerContactRow>,
): RowParseResult {
  const draft: ParsedCustomerContactRow = {
    name: null,
    company: null,
    email: null,
    phone: null,
    address: null,
    postcode: null,
    contact_types: [],
    source_detail: null,
    date_added: null,
  };

  headerMap.forEach((field, index) => {
    const raw = (cells[index] ?? "").trim();
    if (!raw) return;
    switch (field) {
      case "contact_types":
        draft.contact_types = splitContactTypes(raw);
        break;
      case "date_added":
        draft.date_added = parseDateAdded(raw);
        break;
      default:
        draft[field] = raw;
    }
  });

  const hasIdentity =
    Boolean(draft.name?.trim()) ||
    Boolean(draft.email?.trim()) ||
    Boolean(draft.phone?.trim());

  if (!hasIdentity) {
    return { ok: false, reason: "missing_name_email_or_phone" };
  }

  if (draft.email) {
    draft.email = draft.email.toLowerCase();
  }

  return { ok: true, row: draft };
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cell += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      continue;
    }

    if (ch === ",") {
      row.push(cell);
      cell = "";
      continue;
    }

    if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && next === "\n") {
        i += 1;
      }
      row.push(cell);
      cell = "";
      if (row.some((value) => value.trim() !== "")) {
        rows.push(row);
      }
      row = [];
      continue;
    }

    cell += ch;
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    if (row.some((value) => value.trim() !== "")) {
      rows.push(row);
    }
  }

  return rows;
}

export type ImportRowInsert = ParsedCustomerContactRow & {
  client_id: string;
  import_id: string;
  source: string;
  do_not_contact: true;
  contact_permission: "do_not_contact_without_approval";
};

/**
 * Client customer contacts must never be copied into inbox_contacts (TUXX CRM).
 * Imports write only to client_customer_contacts / client_contact_imports.
 */
export function buildInsertPayload(
  clientId: string,
  importId: string,
  source: string,
  row: ParsedCustomerContactRow,
): ImportRowInsert {
  return {
    ...row,
    client_id: clientId,
    import_id: importId,
    source,
    do_not_contact: true,
    contact_permission: "do_not_contact_without_approval",
  };
}
