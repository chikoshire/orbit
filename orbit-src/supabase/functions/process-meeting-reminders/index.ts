/**
 * process-meeting-reminders — Sends a specific meeting reminder via email + SMS.
 *
 * Called by pg_cron + pg_net at the exact scheduled time for each reminder.
 * Receives { reminder_id } in the request body.
 */

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { Resend } from "https://esm.sh/resend@2.0.0";
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { resolveResendApiKey, resolveTelnyxCredentials } from "../_shared/resolve-platform-integrations.ts";
import { MEETING_CALENDAR_FROM } from "../_shared/meeting-calendar-email.ts";

let _resend: Resend | null = null;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const formatDateTime = (dateStr: string) => {
  return new Date(dateStr).toLocaleString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/London",
    timeZoneName: "short",
  });
};

function reminderEmailHtml(reminder: {
  meeting_name: string;
  start_time: string;
  duration_minutes: number;
  video_link: string | null;
  guest_name: string;
  minutes_before: number;
  recipient?: string;
}): string {
  const isOneHour = reminder.minutes_before <= 60;
  const timeLabel = isOneHour ? "1 hour" : "24 hours";
  const isHost = reminder.recipient === "host";
  const heading = isHost
    ? `⏰ Your hosted call is in ${timeLabel}`
    : `⏰ Your call is in ${timeLabel}`;

  return `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #1f2937;">${heading}</h2>
          <h3 style="color: #374151; margin-top: 24px;">${reminder.meeting_name}</h3>
          <div style="background: #f3f4f6; padding: 16px; border-radius: 8px; margin: 16px 0;">
            <p style="margin: 4px 0;"><strong>When:</strong> ${formatDateTime(reminder.start_time)}</p>
            <p style="margin: 4px 0;"><strong>Duration:</strong> ${reminder.duration_minutes} minutes</p>
            ${reminder.video_link ? `<p style="margin: 4px 0;"><strong>Join:</strong> <a href="${reminder.video_link}">${reminder.video_link}</a></p>` : ""}
          </div>
          ${reminder.video_link ? `
          <div style="margin-top: 24px;">
            <a href="${reminder.video_link}" style="display: inline-block; padding: 12px 24px; background: #1a1a1a; color: white; text-decoration: none; border-radius: 8px; font-weight: 600;">Join Google Meet</a>
          </div>` : ""}
          <p style="color: #9ca3af; font-size: 12px; margin-top: 24px;">— TUXX Team</p>
        </div>
      `;
}

async function markReminderFailed(
  supabase: SupabaseClient,
  reminderId: string,
  message: string,
): Promise<void> {
  await supabase
    .from("meeting_reminders")
    .update({
      status: "failed",
      error_message: message.slice(0, 2000),
    } as Record<string, string>)
    .eq("id", reminderId);
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );

  let reminderId: string | null = null;
  let processDue = false;

  try {
    const body = await req.json();
    reminderId = body.reminder_id || null;
    processDue = body.process_due === true;
  } catch {
    // No body
  }

  if (processDue && !reminderId) {
    const { data: dueReminders } = await supabase
      .from("meeting_reminders")
      .select("id")
      .eq("status", "pending")
      .lte("reminder_at", new Date().toISOString())
      .limit(20);

    if (!dueReminders || dueReminders.length === 0) {
      return new Response(JSON.stringify({ processed: 0 }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const results: string[] = [];
    for (const r of dueReminders) {
      try {
        const selfUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/process-meeting-reminders`;
        await fetch(selfUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
          },
          body: JSON.stringify({ reminder_id: r.id }),
        });
        results.push(r.id);
      } catch (e) {
        console.error(`[reminders] Failed to process ${r.id}:`, e);
      }
    }

    return new Response(JSON.stringify({ processed: results.length, ids: results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (!reminderId) {
    return new Response(JSON.stringify({ error: "Missing reminder_id or process_due" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const { data: reminder, error } = await supabase
    .from("meeting_reminders")
    .select("*")
    .eq("id", reminderId)
    .eq("status", "pending")
    .single();

  if (error || !reminder) {
    console.log(`[reminders] Reminder ${reminderId} not found or already processed`);
    return new Response(JSON.stringify({ skipped: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (reminder.booking_id) {
    const { data: booking } = await supabase
      .from("meeting_bookings")
      .select("status")
      .eq("id", reminder.booking_id)
      .single();

    if (booking && booking.status === "cancelled") {
      await supabase.from("meeting_reminders").update({ status: "skipped" }).eq("id", reminderId);
      return new Response(JSON.stringify({ skipped: true, reason: "cancelled" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }

  const isOneHour = reminder.minutes_before <= 60;
  const timeLabel = isOneHour ? "1 hour" : "24 hours";
  const isHostReminder = reminder.recipient === "host";

  if (!_resend) {
    const resendKey = await resolveResendApiKey(supabase);
    if (resendKey) _resend = new Resend(resendKey);
  }
  const telnyxCreds = await resolveTelnyxCredentials(supabase);

  let emailOk = false;
  let emailError: string | null = null;

  try {
    if (!_resend) throw new Error("Resend API key not configured");

    const subjectPrefix = isHostReminder ? "Host reminder" : "Reminder";
    const result = await _resend.emails.send({
      from: MEETING_CALENDAR_FROM,
      to: [reminder.guest_email],
      subject: `${subjectPrefix}: ${reminder.meeting_name} in ${timeLabel}`,
      html: reminderEmailHtml(reminder),
    });

    if (result.error) {
      throw new Error(result.error.message || JSON.stringify(result.error));
    }

    emailOk = true;
    console.log(`[reminders] Email sent to ${reminder.guest_email} (${reminder.recipient ?? "guest"})`);
  } catch (emailErr) {
    emailError = emailErr instanceof Error ? emailErr.message : String(emailErr);
    console.error(`[reminders] Email failed:`, emailError);
  }

  if (!emailOk) {
    await markReminderFailed(supabase as SupabaseClient, reminderId, emailError ?? "Email send failed");
    return new Response(
      JSON.stringify({ success: false, reminder_id: reminderId, error: emailError }),
      { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  if (!isHostReminder && reminder.guest_phone) {
    const telnyxApiKey = telnyxCreds.apiKey;
    const telnyxFrom = telnyxCreds.fromNumber;

    if (telnyxApiKey && telnyxFrom) {
      try {
        const smsBody = `Hi ${reminder.guest_name}, reminder: your call with TUXX is in ${timeLabel} (${formatDateTime(reminder.start_time)}).${reminder.video_link ? ` Join: ${reminder.video_link}` : ""} — TUXX`;

        const smsRes = await fetch("https://api.telnyx.com/v2/messages", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${telnyxApiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            from: telnyxFrom,
            to: reminder.guest_phone,
            text: smsBody,
          }),
        });

        if (!smsRes.ok) {
          console.error(`[reminders] SMS failed:`, await smsRes.text());
        } else {
          console.log(`[reminders] SMS sent to ${reminder.guest_phone}`);
        }
      } catch (smsErr) {
        console.error(`[reminders] SMS error:`, smsErr);
      }
    }
  }

  await supabase
    .from("meeting_reminders")
    .update({ status: "sent", sent_at: new Date().toISOString(), error_message: null })
    .eq("id", reminderId);

  return new Response(
    JSON.stringify({ success: true, reminder_id: reminderId }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
