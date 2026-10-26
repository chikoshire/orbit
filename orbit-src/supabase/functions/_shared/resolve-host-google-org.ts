import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

export type GoogleOrgIntegration = {
  org_id: string;
  access_token: string | null;
  refresh_token: string;
  expires_at: string | null;
};

/**
 * Pick the host's org that has Google connected (deterministic: lowest org_id).
 */
export async function resolveHostGoogleIntegration(
  supabase: SupabaseClient,
  hostUserId: string,
): Promise<GoogleOrgIntegration | null> {
  const { data: memberships } = await supabase
    .from("orbit_org_members")
    .select("org_id")
    .eq("user_id", hostUserId);

  const orgIds = (memberships ?? [])
    .map((m) => m.org_id as string)
    .filter(Boolean)
    .sort();

  for (const orgId of orgIds) {
    const { data: integration } = await supabase
      .from("org_integrations")
      .select("access_token, refresh_token, expires_at")
      .eq("org_id", orgId)
      .eq("provider", "google")
      .maybeSingle();

    if (integration?.refresh_token) {
      return {
        org_id: orgId,
        access_token: integration.access_token,
        refresh_token: integration.refresh_token,
        expires_at: integration.expires_at,
      };
    }
  }

  return null;
}
