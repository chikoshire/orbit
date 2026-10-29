import { readFileSync } from "node:fs";
import { join } from "node:path";

const migrationPath = join(
  import.meta.dirname,
  "..",
  "supabase",
  "migrations",
  "20261029194500_client_customer_contacts.sql",
);

const sql = readFileSync(migrationPath, "utf8");

const forbiddenPatterns = [
  /pg_notify/i,
  /net\.http/i,
  /crm-automation-executor/i,
  /auto-enroll-sequences/i,
];

const triggerMatches = [...sql.matchAll(/CREATE TRIGGER\s+(\w+)/gi)].map((m) => m[1]);
const unexpectedTriggers = triggerMatches.filter(
  (name) => name !== "client_customer_contacts_set_updated_at",
);
if (unexpectedTriggers.length > 0) {
  console.error("Unexpected triggers in migration:", unexpectedTriggers);
  failed = true;
}

let failed = false;
for (const pattern of forbiddenPatterns) {
  if (pattern.test(sql)) {
    console.error(`Migration isolation check failed for pattern: ${pattern}`);
    failed = true;
  }
}

if (!/client_customer_contacts_set_updated_at/i.test(sql)) {
  console.error("Missing updated_at trigger on client_customer_contacts");
  failed = true;
}

if (failed) {
  process.exit(1);
}

console.log("Migration isolation checks passed.");
