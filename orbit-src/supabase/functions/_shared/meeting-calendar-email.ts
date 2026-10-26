/** Verified Resend sender for meeting booking + reminder emails. */
export const MEETING_CALENDAR_FROM =
  Deno.env.get("MEETING_CALENDAR_FROM") ?? "TUXX Calendar <calendar@tuxxagency.com>";

export const MEETING_CALENDAR_FROM_ADDRESS =
  Deno.env.get("MEETING_CALENDAR_FROM_ADDRESS") ?? "calendar@tuxxagency.com";
