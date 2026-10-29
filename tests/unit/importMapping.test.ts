import { describe, expect, it } from "vitest";
import {
  mapHeaders,
  parseCsv,
  parseCustomerContactRow,
} from "../../src/lib/clientCustomerContacts/importMapping";

describe("client customer contact import mapping", () => {
  it("parses semicolon-separated customer types and phone-only rows", () => {
    const csv = parseCsv(
      "Name,Company,Email,Phone,Customer type\nJane Doe,,,07700900123,Landlord; Society member\n",
    );
    const headerMap = mapHeaders(csv[0]);
    const parsed = parseCustomerContactRow(csv[1], headerMap);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.row.email).toBeNull();
    expect(parsed.row.phone).toBe("07700900123");
    expect(parsed.row.contact_types).toEqual(["Landlord", "Society member"]);
  });

  it("rejects rows with no name, email, or phone", () => {
    const headerMap = mapHeaders(["Name", "Email", "Phone"]);
    const parsed = parseCustomerContactRow(["", "", ""], headerMap);
    expect(parsed.ok).toBe(false);
  });
});
