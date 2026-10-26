/**
 * Resolve platform-level integration keys
 * Used by stripe-billing, stripe-webhook, github-clone-repo, ai-deploy,
 * inbox-send-email, initiate-call, process-meeting-reminders, etc.
 *
 * Resolution order (platform_settings DB → env var fallback):
 * - Stripe:    platform_settings.stripe_secret_key → STRIPE_SECRET_KEY env
 * - GitHub:    user_ai_settings → platform_settings → GITHUB_TOKEN env
 * - Primeforge: platform_settings.primeforge_api_key → PRIMEFORGE_API_KEY env
 * - Resend:    platform_settings.resend_api_key → RESEND_API_KEY env
 * - Telnyx:    platform_settings.telnyx_api_key → TELNYX_API_KEY env (+ connection_id, from_number)
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

export interface PlatformIntegrations {
  stripeSecretKey: string | null;
  githubToken: string | null;
}

export async function resolvePlatformIntegrations(
  supabase: SupabaseClient
): Promise<PlatformIntegrations> {
  const { data: row } = await supabase
    .from("platform_settings")
    .select("stripe_secret_key, github_token")
    .limit(1)
    .maybeSingle();

  const stripeSecretKey =
    (row?.stripe_secret_key?.trim() || null) ??
    Deno.env.get("STRIPE_SECRET_KEY") ??
    Deno.env.get("STRIPE_CLIENT_SECRET") ??
    null;

  const githubToken =
    (row?.github_token?.trim() || null) ??
    Deno.env.get("GITHUB_TOKEN") ??
    null;

  return { stripeSecretKey, githubToken };
}

/** Resolve Stripe secret key: platform_settings first, then env */
export async function resolveStripeSecretKey(
  supabase: SupabaseClient
): Promise<string | null> {
  const { stripeSecretKey } = await resolvePlatformIntegrations(supabase);
  return stripeSecretKey;
}

/** Resolve GitHub token: platform_settings only (for functions that don't have user-level token) */
export async function resolvePlatformGitHubToken(
  supabase: SupabaseClient
): Promise<string | null> {
  const { githubToken } = await resolvePlatformIntegrations(supabase);
  return githubToken;
}

/**
 * Resolve GitHub token for user-scoped operations (e.g. clone-repo, ai-deploy).
 * Order: user_ai_settings.github_token → platform_settings.github_token → env
 */
export async function resolveGitHubTokenForUser(
  supabase: SupabaseClient,
  userId: string
): Promise<string | null> {
  const { data: userSettings } = await supabase
    .from("user_ai_settings")
    .select("github_token")
    .eq("user_id", userId)
    .maybeSingle();

  const userToken = userSettings?.github_token?.trim() || null;
  if (userToken) return userToken;

  const { githubToken } = await resolvePlatformIntegrations(supabase);
  return githubToken;
}

/** Resolve Primeforge API key: platform_settings → env */
export async function resolvePrimeforgeApiKey(
  supabase: SupabaseClient
): Promise<{ apiKey: string | null; workspaceId: string | null }> {
  const { data: row } = await supabase
    .from("platform_settings")
    .select("primeforge_api_key, primeforge_workspace_id")
    .limit(1)
    .maybeSingle();

  const apiKey =
    (row?.primeforge_api_key?.trim() || null) ??
    Deno.env.get("PRIMEFORGE_API_KEY") ??
    Deno.env.get("SALESFORGE_API_KEY") ??
    null;

  const workspaceId =
    (row?.primeforge_workspace_id?.trim() || null) ??
    null;

  return { apiKey, workspaceId };
}

/** Resolve Resend API key: platform_settings → env */
export async function resolveResendApiKey(
  supabase: SupabaseClient
): Promise<string | null> {
  const { data: row } = await supabase
    .from("platform_settings")
    .select("resend_api_key")
    .limit(1)
    .maybeSingle();

  return (
    (row?.resend_api_key?.trim() || null) ??
    Deno.env.get("RESEND_API_KEY") ??
    null
  );
}

/** Resolve Telnyx credentials: platform_settings → env */
export async function resolveTelnyxCredentials(
  supabase: SupabaseClient
): Promise<{
  apiKey: string | null;
  connectionId: string | null;
  fromNumber: string | null;
}> {
  const { data: row } = await supabase
    .from("platform_settings")
    .select("telnyx_api_key, telnyx_connection_id, telnyx_from_number")
    .limit(1)
    .maybeSingle();

  const apiKey =
    (row?.telnyx_api_key?.trim() || null) ??
    Deno.env.get("TELNYX_API_KEY") ??
    null;

  const connectionId =
    (row?.telnyx_connection_id?.trim() || null) ??
    Deno.env.get("TELNYX_CONNECTION_ID") ??
    null;

  const fromNumber =
    (row?.telnyx_from_number?.trim() || null) ??
    Deno.env.get("TELNYX_FROM_NUMBER") ??
    null;

  return { apiKey, connectionId, fromNumber };
}
