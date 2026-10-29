import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      if (entry === "node_modules" || entry === ".git") continue;
      walk(path, out);
    } else {
      out.push(path);
    }
  }
  return out;
}

describe("CRM isolation guardrails", () => {
  it("never copies client_customer_contacts into inbox_contacts", () => {
    const files = walk(ROOT).filter((path) => /\.(ts|tsx)$/.test(path));
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      if (/insert\s+into\s+inbox_contacts[\s\S]{0,400}client_customer_contacts/i.test(text)) {
        offenders.push(file);
      }
      if (/from\s+client_customer_contacts[\s\S]{0,200}into\s+inbox_contacts/i.test(text)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("does not reference client_customer_contacts from edge CRM executors", () => {
    const fnDir = join(ROOT, "supabase", "functions");
    const files = walk(fnDir).filter((f) => f.endsWith(".ts"));
    const forbidden = [
      "crm-automation-executor",
      "auto-enroll-sequences",
      "sequence",
    ];
    for (const file of files) {
      const base = file.split("/").slice(-2, -1)[0] ?? "";
      if (!forbidden.some((part) => base.includes(part))) continue;
      const text = readFileSync(file, "utf8");
      expect(text.includes("client_customer_contacts")).toBe(false);
    }
  });
});
