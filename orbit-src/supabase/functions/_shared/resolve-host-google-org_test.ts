import { resolveHostGoogleIntegration } from "./resolve-host-google-org.ts";

Deno.test("resolveHostGoogleIntegration picks lowest org_id with Google refresh_token", async () => {
  const calls: string[] = [];
  const supabase = {
    from(table: string) {
      if (table === "orbit_org_members") {
        return {
          select() {
            return {
              eq() {
                return Promise.resolve({
                  data: [{ org_id: "org-b" }, { org_id: "org-a" }],
                });
              },
            };
          },
        };
      }
      if (table === "org_integrations") {
        return {
          select() {
            return {
              eq(_col: string, orgId: string) {
                return {
                  eq() {
                    return {
                      maybeSingle() {
                        calls.push(orgId);
                        if (orgId === "org-a") {
                          return Promise.resolve({
                            data: {
                              access_token: "tok",
                              refresh_token: "ref",
                              expires_at: new Date(Date.now() + 3600_000).toISOString(),
                            },
                          });
                        }
                        return Promise.resolve({ data: null });
                      },
                    };
                  },
                };
              },
            };
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };

  const result = await resolveHostGoogleIntegration(supabase as never, "user-1");
  if (!result || result.org_id !== "org-a") {
    throw new Error(`expected org-a, got ${result?.org_id}`);
  }
  if (calls[0] !== "org-a") {
    throw new Error(`expected org-a checked first, order was ${calls.join(",")}`);
  }
});
