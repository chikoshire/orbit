import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { Resend } from "https://esm.sh/resend@2.0.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { checkRateLimit, getClientIP, rateLimitExceededResponse } from "../_shared/rate-limiter.ts";
import { resolveResendApiKey, resolveTelnyxCredentials } from "../_shared/resolve-platform-integrations.ts";
import { MEETING_CALENDAR_FROM, MEETING_CALENDAR_FROM_ADDRESS } from "../_shared/meeting-calendar-email.ts";
import { buildMeetingEventDescription } from "../_shared/meeting-event-description.ts";
import { resolveHostGoogleIntegration } from "../_shared/resolve-host-google-org.ts";

// Lazy-init: resolved at first invocation so we can read from platform_settings
let _resend: Resend | null = null;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Rate limit: 10 bookings per IP per 15 minutes
const RATE_LIMIT_CONFIG = {
  maxRequests: 10,
  windowMs: 15 * 60 * 1000, // 15 minutes
  keyPrefix: "meeting-book",
};

function generateICS(event: {
  uid: string;
  title: string;
  description?: string;
  location?: string;
  startTime: string;
  endTime: string;
  organizerName: string;
  organizerEmail: string;
  attendees: Array<{ name: string; email: string }>;
}): string {
  const formatDate = (date: string) => {
    return new Date(date).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  };

  const escapeText = (text: string) => {
    return text.replace(/[\\;,\n]/g, (match) => {
      if (match === '\n') return '\\n';
      return '\\' + match;
    });
  };

  const attendeeLines = event.attendees
    .map(a => `ATTENDEE;CN=${escapeText(a.name)};RSVP=TRUE:mailto:${a.email}`)
    .join('\r\n');

  return `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Orbit//Calendar//EN
METHOD:REQUEST
BEGIN:VEVENT
UID:${event.uid}
DTSTAMP:${formatDate(new Date().toISOString())}
DTSTART:${formatDate(event.startTime)}
DTEND:${formatDate(event.endTime)}
SUMMARY:${escapeText(event.title)}
${event.description ? `DESCRIPTION:${escapeText(event.description)}` : ''}
${event.location ? `LOCATION:${escapeText(event.location)}` : ''}
ORGANIZER;CN=${escapeText(event.organizerName)}:mailto:${event.organizerEmail}
${attendeeLines}
STATUS:CONFIRMED
SEQUENCE:0
END:VEVENT
END:VCALENDAR`.replace(/\n/g, '\r\n');
}

function generateGoogleCalendarUrl(event: {
  title: string;
  description?: string;
  location?: string;
  startTime: string;
  endTime: string;
}): string {
  const formatGoogleDate = (date: string) => {
    return new Date(date).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  };

  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: event.title,
    dates: `${formatGoogleDate(event.startTime)}/${formatGoogleDate(event.endTime)}`,
  });

  if (event.description) params.set('details', event.description);
  if (event.location) params.set('location', event.location);

  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

interface BookingRequest {
  meetingLinkId: string;
  guestName: string;
  guestEmail: string;
  guestTimeZone?: string;
  guestNotes?: string;
  startTime: string;
  bookingResponses?: Record<string, string>;
  selectedDuration?: number;
  audit_id?: string;
  audit_full_url?: string;
}

const handler = async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Rate limiting check
    const clientIP = getClientIP(req);
    const rateLimitResult = checkRateLimit(clientIP, RATE_LIMIT_CONFIG);
    
    if (!rateLimitResult.allowed) {
      console.log(`[MEETING-BOOK] Rate limit exceeded for IP: ${clientIP}`);
      return rateLimitExceededResponse(rateLimitResult, corsHeaders);
    }

    // Use service role for public booking
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    const { 
      meetingLinkId, 
      guestName, 
      guestEmail, 
      guestTimeZone, 
      guestNotes, 
      startTime, 
      bookingResponses, 
      selectedDuration,
      audit_id: payloadAuditId,
      audit_full_url: payloadAuditUrl
    }: BookingRequest = await req.json();

    // Resolve integration keys from platform_settings → env fallback
    if (!_resend) {
      const resendKey = await resolveResendApiKey(supabase);
      if (resendKey) _resend = new Resend(resendKey);
    }
    const telnyxCreds = await resolveTelnyxCredentials(supabase);

    console.log("Booking request:", { meetingLinkId, guestName, guestEmail, startTime, selectedDuration });

    // Fetch meeting link with calendar
    const { data: meetingLink, error: linkError } = await supabase
      .from('meeting_links')
      .select(`
        *,
        calendar:calendars(*)
      `)
      .eq('id', meetingLinkId)
      .eq('is_active', true)
      .single();

    if (linkError || !meetingLink) {
      console.error("Meeting link fetch error:", linkError);
      return new Response(JSON.stringify({ error: "Meeting link not found or inactive" }), {
        status: 404,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // Calculate end time (use selected duration if multi-duration enabled)
    const effectiveDuration = (meetingLink.allow_multiple_durations && selectedDuration)
      ? selectedDuration
      : meetingLink.duration_minutes;
    const startDate = new Date(startTime);
    const endDate = new Date(startDate.getTime() + effectiveDuration * 60 * 1000);
    const endTime = endDate.toISOString();

    // Determine if this needs host confirmation
    const needsConfirmation = meetingLink.requires_confirmation === true;
    const eventStatus = needsConfirmation ? 'tentative' : 'confirmed';
    const bookingStatus = needsConfirmation ? 'pending' : 'scheduled';

    // Resolve location
    let eventLocation: string | null = null;
    if (meetingLink.location_type === 'custom_link' && meetingLink.location_value) {
      eventLocation = meetingLink.location_value;
    } else if (meetingLink.location_type === 'in_person' && meetingLink.location_value) {
      eventLocation = meetingLink.location_value;
    } else if (meetingLink.location_type === 'phone' && meetingLink.location_value) {
      eventLocation = `Phone: ${meetingLink.location_value}`;
    }

    // Resolve availability from schedule if applicable
    if (meetingLink.availability_schedule_id) {
      const bookingDateStr = startDate.toISOString().split('T')[0];
      const { data: overrides } = await supabase
        .from('availability_overrides')
        .select('*')
        .eq('schedule_id', meetingLink.availability_schedule_id)
        .eq('override_date', bookingDateStr);

      if (overrides && overrides.length > 0) {
        const override = overrides[0];
        if (override.is_unavailable) {
          return new Response(JSON.stringify({ error: "This date is not available for bookings" }), {
            status: 409,
            headers: { "Content-Type": "application/json", ...corsHeaders },
          });
        }

        // Validate booking falls within custom override hours
        if (override.start_time && override.end_time) {
          const bookingTimeStr = startDate.toTimeString().substring(0, 5); // "HH:MM"
          const bookingEndTimeStr = endDate.toTimeString().substring(0, 5);
          if (bookingTimeStr < override.start_time || bookingEndTimeStr > override.end_time) {
            return new Response(JSON.stringify({ error: "This time slot is outside available hours for this date" }), {
              status: 409,
              headers: { "Content-Type": "application/json", ...corsHeaders },
            });
          }
        }
      }
    }

    // Check for conflicts in Orbit events
    const { data: conflicts } = await supabase
      .from('events')
      .select('id')
      .eq('calendar_id', meetingLink.calendar_id)
      .eq('status', 'confirmed')
      .lt('start_time', endTime)
      .gt('end_time', startTime);

    if (conflicts && conflicts.length > 0) {
      return new Response(JSON.stringify({ error: "Time slot is no longer available" }), {
        status: 409,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // Also check Google Calendar for conflicts
    try {
      const gcalIntegration = await resolveHostGoogleIntegration(supabase, meetingLink.user_id);

      if (gcalIntegration?.refresh_token) {
          let gcalToken = gcalIntegration.access_token;
          const gcalExpiry = gcalIntegration.expires_at ? new Date(gcalIntegration.expires_at) : new Date(0);

          if (!gcalToken || gcalExpiry < new Date()) {
            const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
            const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");
            if (clientId && clientSecret) {
              const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({
                  client_id: clientId, client_secret: clientSecret,
                  refresh_token: gcalIntegration.refresh_token, grant_type: "refresh_token",
                }),
              });
              if (tokenRes.ok) {
                const tokens = await tokenRes.json();
                gcalToken = tokens.access_token;
                await supabase.from('org_integrations').update({
                  access_token: tokens.access_token,
                  expires_at: new Date(Date.now() + (tokens.expires_in || 3600) * 1000).toISOString(),
                }).eq('org_id', gcalIntegration.org_id).eq('provider', 'google');
              }
            }
          }

          if (gcalToken) {
            const freeBusyRes = await fetch("https://www.googleapis.com/calendar/v3/freeBusy", {
              method: "POST",
              headers: { Authorization: `Bearer ${gcalToken}`, "Content-Type": "application/json" },
              body: JSON.stringify({
                timeMin: startTime, timeMax: endTime,
                items: [{ id: "primary" }],
              }),
            });

            if (freeBusyRes.ok) {
              const fbData = await freeBusyRes.json();
              const busySlots = fbData.calendars?.primary?.busy || [];
              if (busySlots.length > 0) {
                console.log("[meeting-book] Google Calendar conflict detected:", busySlots);
                return new Response(JSON.stringify({ error: "Time slot conflicts with an existing calendar event" }), {
                  status: 409,
                  headers: { "Content-Type": "application/json", ...corsHeaders },
                });
              }
            }
          }
      }
    } catch (gcalErr) {
      console.error("[meeting-book] Google Calendar conflict check failed (non-blocking):", gcalErr);
    }

    // Booking limits enforcement
    const now = new Date();

    // Daily limit
    if (meetingLink.max_bookings_per_day != null) {
      const dayStart = new Date(startDate);
      dayStart.setHours(0, 0, 0, 0);
      const dayEnd = new Date(dayStart);
      dayEnd.setDate(dayEnd.getDate() + 1);

      const { count: dayCount } = await supabase
        .from('meeting_bookings')
        .select('*', { count: 'exact', head: true })
        .eq('meeting_link_id', meetingLinkId)
        .in('status', ['scheduled', 'pending'])
        .gte('start_time', dayStart.toISOString())
        .lt('start_time', dayEnd.toISOString());

      if ((dayCount ?? 0) >= meetingLink.max_bookings_per_day) {
        return new Response(JSON.stringify({ error: "No more bookings available for this day" }), {
          status: 409,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
    }

    // Weekly limit
    if (meetingLink.max_bookings_per_week != null) {
      const weekStart = new Date(startDate);
      weekStart.setDate(weekStart.getDate() - weekStart.getDay());
      weekStart.setHours(0, 0, 0, 0);
      const weekEnd = new Date(weekStart);
      weekEnd.setDate(weekEnd.getDate() + 7);

      const { count: weekCount } = await supabase
        .from('meeting_bookings')
        .select('*', { count: 'exact', head: true })
        .eq('meeting_link_id', meetingLinkId)
        .in('status', ['scheduled', 'pending'])
        .gte('start_time', weekStart.toISOString())
        .lt('start_time', weekEnd.toISOString());

      if ((weekCount ?? 0) >= meetingLink.max_bookings_per_week) {
        return new Response(JSON.stringify({ error: "No more bookings available for this week" }), {
          status: 409,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
    }

    // Monthly limit
    if (meetingLink.max_bookings_per_month != null) {
      const monthStart = new Date(startDate.getFullYear(), startDate.getMonth(), 1);
      const monthEnd = new Date(startDate.getFullYear(), startDate.getMonth() + 1, 1);

      const { count: monthCount } = await supabase
        .from('meeting_bookings')
        .select('*', { count: 'exact', head: true })
        .eq('meeting_link_id', meetingLinkId)
        .in('status', ['scheduled', 'pending'])
        .gte('start_time', monthStart.toISOString())
        .lt('start_time', monthEnd.toISOString());

      if ((monthCount ?? 0) >= meetingLink.max_bookings_per_month) {
        return new Response(JSON.stringify({ error: "No more bookings available for this month" }), {
          status: 409,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
    }

    // Per-booker limit
    if (meetingLink.limit_per_booker_frequency) {
      let periodStart: Date;
      const periodEnd = new Date(now);

      switch (meetingLink.limit_per_booker_frequency) {
        case 'day': {
          periodStart = new Date(now);
          periodStart.setHours(0, 0, 0, 0);
          periodEnd.setDate(periodEnd.getDate() + 1);
          periodEnd.setHours(0, 0, 0, 0);
          break;
        }
        case 'week': {
          periodStart = new Date(now);
          periodStart.setDate(periodStart.getDate() - periodStart.getDay());
          periodStart.setHours(0, 0, 0, 0);
          periodEnd.setDate(periodStart.getDate() + 7);
          periodEnd.setHours(0, 0, 0, 0);
          break;
        }
        case 'month': {
          periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
          periodEnd.setMonth(periodEnd.getMonth() + 1);
          periodEnd.setDate(1);
          periodEnd.setHours(0, 0, 0, 0);
          break;
        }
        default:
          periodStart = new Date(0);
      }

      const { count: bookerCount } = await supabase
        .from('meeting_bookings')
        .select('*', { count: 'exact', head: true })
        .eq('meeting_link_id', meetingLinkId)
        .eq('guest_email', guestEmail)
        .in('status', ['scheduled', 'pending'])
        .gte('created_at', periodStart.toISOString())
        .lt('created_at', periodEnd.toISOString());

      const maxPerBooker = meetingLink.limit_per_booker_count || 1;
      if ((bookerCount ?? 0) >= maxPerBooker) {
        return new Response(JSON.stringify({ error: `You've reached the booking limit for this ${meetingLink.limit_per_booker_frequency}` }), {
          status: 409,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
    }

    // Fetch host profile
    const { data: hostProfile } = await supabase
      .from('profiles')
      .select('name, email')
      .eq('id', meetingLink.user_id)
      .single();

    const hostName = hostProfile?.name || 'Orbit User';
    const hostEmail = hostProfile?.email || 'noreply@orbit.app';

    // Generate ICS UID
    const icsUid = `${crypto.randomUUID()}@orbit.app`;

    // Create video conference room based on location type
    let videoRoomId: string | null = null;
    let videoConferenceLink: string | null = null;
    let googleEventId: string | null = null;

    const calendarEventDescription = buildMeetingEventDescription(
      meetingLink.description,
      guestNotes,
    );

    // Create Google Calendar event once when Google OAuth is connected (includes Meet + reminders).
    try {
      const googleIntegration = await resolveHostGoogleIntegration(supabase, meetingLink.user_id);

      if (googleIntegration?.refresh_token) {
          console.log("[meeting-book] Google OAuth found, creating Calendar event...");
          
          // Refresh access token if needed
          let accessToken = googleIntegration.access_token;
          const expiresAt = googleIntegration.expires_at ? new Date(googleIntegration.expires_at) : new Date(0);

          if (!accessToken || expiresAt < new Date()) {
            const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
            const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");

            if (clientId && clientSecret) {
              const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({
                  client_id: clientId,
                  client_secret: clientSecret,
                  refresh_token: googleIntegration.refresh_token,
                  grant_type: "refresh_token",
                }),
              });

              if (tokenRes.ok) {
                const tokens = await tokenRes.json();
                accessToken = tokens.access_token;
                await supabase
                  .from('org_integrations')
                  .update({
                    access_token: tokens.access_token,
                    expires_at: new Date(Date.now() + (tokens.expires_in || 3600) * 1000).toISOString(),
                  })
                  .eq('org_id', googleIntegration.org_id)
                  .eq('provider', 'google');
              }
            }
          }

          if (accessToken) {
            const conferenceData = meetingLink.location_type === 'google_meet' ? {
              createRequest: {
                requestId: crypto.randomUUID(),
                conferenceSolutionKey: { type: 'hangoutsMeet' },
              },
            } : undefined;

            const gcalEvent: Record<string, unknown> = {
              summary: `${meetingLink.name} with ${guestName}`,
              description: calendarEventDescription,
              start: {
                dateTime: startTime,
                timeZone: meetingLink.time_zone || 'Europe/London',
              },
              end: {
                dateTime: endTime,
                timeZone: meetingLink.time_zone || 'Europe/London',
              },
              attendees: [
                { email: hostEmail, displayName: hostName, organizer: true, responseStatus: 'accepted' },
                { email: guestEmail, displayName: guestName, responseStatus: 'needsAction' },
              ],
              reminders: {
                useDefault: false,
                overrides: [
                  { method: 'email', minutes: 60 },
                  { method: 'popup', minutes: 10 },
                ],
              },
            };

            // Add conference data if using Google Meet
            if (conferenceData) {
              gcalEvent.conferenceData = conferenceData;
            }

            const gcalRes = await fetch(
              `https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1&sendUpdates=all`,
              {
                method: 'POST',
                headers: {
                  Authorization: `Bearer ${accessToken}`,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify(gcalEvent),
              }
            );

            if (gcalRes.ok) {
              const gcalData = await gcalRes.json();
              googleEventId = gcalData.id;
              
              // Only use Meet link if location_type is google_meet
              if (meetingLink.location_type === 'google_meet') {
                videoConferenceLink = gcalData.conferenceData?.entryPoints?.find(
                  (ep: any) => ep.entryPointType === 'video'
                )?.uri || gcalData.hangoutLink || null;
              }
              
              eventLocation = videoConferenceLink || gcalData.htmlLink;
              console.log("[meeting-book] Google Calendar event created:", gcalData.htmlLink);
            } else {
              const errText = await gcalRes.text();
              console.error("[meeting-book] Google Calendar API error:", gcalRes.status, errText);
            }
          }
      } else {
        console.log("[meeting-book] No Google OAuth integration found");
      }
    } catch (gcalErr) {
      console.error("[meeting-book] Google Calendar creation error:", gcalErr);
      // Non-fatal — continue without Google Calendar
    }

    if (meetingLink.location_type === 'orbit_meet') {
      const roomSlug = `${crypto.randomUUID().substring(0, 8)}-${crypto.randomUUID().substring(0, 4)}-${crypto.randomUUID().substring(0, 4)}`;
      const { data: videoRoom, error: roomError } = await supabase
        .from('video_rooms')
        .insert({
          name: `${meetingLink.name} with ${guestName}`,
          room_slug: roomSlug,
          host_user_id: meetingLink.user_id,
          meeting_link_id: meetingLink.id,
          status: 'pending',
        })
        .select()
        .single();

      if (!roomError && videoRoom) {
        videoRoomId = videoRoom.id;
        videoConferenceLink = `https://orbit.tuxxagency.com/meet/room/${roomSlug}`;
        eventLocation = videoConferenceLink;
      } else {
        console.error("Failed to create Orbit Meet room:", roomError);
        return new Response(JSON.stringify({ error: "Failed to create video room for this meeting" }), {
          status: 500,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
    }

    // Create event
    const { data: event, error: eventError } = await supabase
      .from('events')
      .insert({
        calendar_id: meetingLink.calendar_id,
        owner_user_id: meetingLink.user_id,
        title: `${meetingLink.name} with ${guestName}`,
        description: calendarEventDescription || meetingLink.description,
        location: eventLocation,
        video_conference_link: videoConferenceLink,
        video_room_id: videoRoomId,
        start_time: startTime,
        end_time: endTime,
        status: eventStatus,
        created_via: 'meeting_link',
        external_ics_uid: icsUid,
        google_event_id: googleEventId,
      })
      .select()
      .single();

    if (eventError || !event) {
      console.error("Event creation error:", eventError);
      return new Response(JSON.stringify({ error: "Failed to create event" }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // Link video room to event
    if (videoRoomId) {
      await supabase
        .from('video_rooms')
        .update({ event_id: event.id })
        .eq('id', videoRoomId);
    }

    // Create attendees
    await supabase.from('event_attendees').insert([
      {
        event_id: event.id,
        name: hostName,
        email: hostEmail,
        is_host: true,
        rsvp_status: 'accepted',
      },
      {
        event_id: event.id,
        name: guestName,
        email: guestEmail,
        is_host: false,
        rsvp_status: 'accepted',
        invited_at: new Date().toISOString(),
      }
    ]);

    // Create booking record
    const { data: booking, error: bookingError } = await supabase
      .from('meeting_bookings')
      .insert({
        meeting_link_id: meetingLinkId,
        event_id: event.id,
        host_user_id: meetingLink.user_id,
        guest_name: guestName,
        guest_email: guestEmail,
        guest_time_zone: guestTimeZone,
        guest_notes: guestNotes,
        start_time: startTime,
        end_time: endTime,
        status: bookingStatus,
        booking_responses: bookingResponses || {},
        selected_duration: selectedDuration || null,
      })
      .select()
      .single();

    if (bookingError) {
      console.error("Booking creation error:", bookingError);
    }

    // Auto-create or update CRM contact for the guest
    let crmContactId: string | null = null;
    try {
      const guestPhone = bookingResponses?.phone || null;
      const { data: existingContact } = await supabase
        .from('inbox_contacts')
        .select('id')
        .eq('primary_email', guestEmail)
        .maybeSingle();

      if (existingContact) {
        crmContactId = existingContact.id;
        // Update last_contacted and fill in missing fields
        const updates: Record<string, any> = { last_contacted_at: new Date().toISOString() };
        if (guestPhone) updates.primary_phone = guestPhone;
        await supabase.from('inbox_contacts').update(updates).eq('id', existingContact.id);
      } else {
        // Create new contact
        const { data: newContact } = await supabase.from('inbox_contacts').insert({
          display_name: guestName,
          primary_email: guestEmail,
          primary_phone: guestPhone,
          source: 'meeting_booking',
          lifecycle_stage: 'lead',
          assigned_to: meetingLink.user_id,
          last_contacted_at: new Date().toISOString(),
        } as any).select('id').single();
        crmContactId = newContact?.id || null;
      }
    } catch (contactErr) {
      console.error("Auto-contact creation error (non-fatal):", contactErr);
    }

    // Booking confirmed → enroll into meeting_booked sequences (Post-Meeting
    // Nurture). Strictly trigger-type matched: cold sequences are
    // signup/manual and can never be enrolled by this path. Chiko-approved
    // 2026-06-11: booking-triggered nurture is live; cold outreach stays off.
    if (crmContactId) {
      try {
        await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/auto-enroll-sequences`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            trigger_type: "meeting_booked",
            contact_id: crmContactId,
            contact_name: guestName,
            contact_email: guestEmail,
          }),
        });
      } catch (enrollErr) {
        console.error("Post-booking sequence enrollment failed (non-fatal):", enrollErr);
      }
    }

    // Auto-create or update CRM deal card for the booking
    try {
      if (crmContactId) {
        // Look up any audit data associated with this contact's email if not provided in payload
        const { data: auditSubmission } = await supabase
          .from('audit_submissions')
          .select('id, selected_tools, team_size, monthly_team_cost, annual_team_cost, weekly_hours_wasted, business_name, website_url')
          .eq('email', guestEmail)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        // Build audit URLs (prioritize payload over DB lookup)
        const auditId = payloadAuditId || auditSubmission?.id || null;
        const siteOrigin = 'https://tuxxagency.com';
        
        let auditFullUrl = payloadAuditUrl || null;
        let auditPreviewUrl = payloadAuditUrl || null;
        
        // If we didn't get a URL from the payload but we did find an DB ID, construct the tuxxagency URL
        if (!auditFullUrl && auditId) {
          auditFullUrl = `${siteOrigin}/audit/${auditId}?view=owner`;
          auditPreviewUrl = `${siteOrigin}/audit/${auditId}`;
        }

        // Check if a deal already exists for this contact
        const { data: existingDeal } = await supabase
          .from('deals')
          .select('id')
          .eq('contact_id', crmContactId)
          .eq('user_id', meetingLink.user_id)
          .in('status', ['open'])
          .maybeSingle();

        if (existingDeal) {
          // Update existing deal with call and audit info
          await supabase.from('deals').update({
            audit_id: auditId,
            audit_full_url: auditFullUrl,
            audit_preview_url: auditPreviewUrl,
            call_start_at: startTime,
            call_end_at: endTime,
            calendar_event_id: event.id,
            updated_at: new Date().toISOString(),
          }).eq('id', existingDeal.id);

          console.log(`[meeting-book] ✅ Existing deal ${existingDeal.id} updated with audit + call data`);
        } else {
          // Find the "New Leads" stage (order_index = 1), falling back to first stage
          const { data: newLeadStage } = await supabase
            .from('deal_stages')
            .select('id')
            .eq('order_index', 1)
            .limit(1)
            .maybeSingle();

          const dealTitle = auditSubmission?.business_name
            ? `${auditSubmission.business_name} — Audit Call`
            : `${guestName} — Audit Call`;

          await supabase.from('deals').insert({
            user_id: meetingLink.user_id,
            contact_id: crmContactId,
            stage_id: newLeadStage?.id || null,
            title: dealTitle,
            source: 'website_audit',
            status: 'open',
            probability: 50,
            notes: guestNotes || `Booked via ${meetingLink.name}`,
            // First-class audit + call fields
            audit_id: auditId,
            audit_full_url: auditFullUrl,
            audit_preview_url: auditPreviewUrl,
            call_start_at: startTime,
            call_end_at: endTime,
            calendar_event_id: event.id,
            // Keep custom_fields for backwards compat with Orion queries
            custom_fields: auditSubmission ? {
              audit: {
                audit_id: auditSubmission.id,
                tools: auditSubmission.selected_tools,
                team_size: auditSubmission.team_size,
                monthly_cost: auditSubmission.monthly_team_cost,
                annual_cost: auditSubmission.annual_team_cost,
                weekly_hours_wasted: auditSubmission.weekly_hours_wasted,
                business_name: auditSubmission.business_name,
                website_url: auditSubmission.website_url,
              },
            } : {},
          });

          console.log(`[meeting-book] ✅ Deal card created for ${guestEmail} with first-class audit + call fields`);
        }
      }
    } catch (dealErr) {
      console.error("[meeting-book] Auto-deal creation error (non-blocking):", dealErr);
    }

    // Generate ICS and email content
    const googleMeetLink = videoConferenceLink;

    const icsContent = generateICS({
      uid: icsUid,
      title: `${meetingLink.name} with ${guestName}`,
      description: calendarEventDescription,
      location: eventLocation || undefined,
      startTime,
      endTime,
      organizerName: hostName,
      organizerEmail: hostEmail,
      attendees: [
        { name: hostName, email: hostEmail },
        { name: guestName, email: guestEmail },
      ],
    });

    const googleCalUrl = generateGoogleCalendarUrl({
      title: `${meetingLink.name} with ${guestName}`,
      description: calendarEventDescription,
      location: eventLocation || undefined,
      startTime,
      endTime,
    });

    const formatDateTime = (dateStr: string, tz?: string) => {
      return new Date(dateStr).toLocaleString('en-GB', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: tz || 'UTC',
        timeZoneName: 'short'
      });
    };

    // Send confirmation to guest
    const guestEmailSubject = needsConfirmation
      ? `Pending: ${meetingLink.name} with ${hostName}`
      : `Confirmed: ${meetingLink.name} with ${hostName}`;
    const guestEmailHeading = needsConfirmation
      ? '⏳ Booking Request Received'
      : '✅ Meeting Confirmed';
    const guestEmailNote = needsConfirmation
      ? '<p style="color: #92400e; margin-top: 16px;">Your booking is pending confirmation from the host. You will receive another email once it is confirmed.</p>'
      : '';

    try {
      const guestHtml = `
          <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #1f2937;">${guestEmailHeading}</h2>
            <h3 style="color: #374151; margin-top: 24px;">${meetingLink.name}</h3>
            <div style="background: #f3f4f6; padding: 16px; border-radius: 8px; margin: 16px 0;">
              <p style="margin: 4px 0;"><strong>When:</strong> ${formatDateTime(startTime, guestTimeZone)}</p>
              <p style="margin: 4px 0;"><strong>Duration:</strong> ${effectiveDuration} minutes</p>
              <p style="margin: 4px 0;"><strong>Host:</strong> ${hostName}</p>
              ${eventLocation ? `<p style="margin: 4px 0;"><strong>Location:</strong> ${eventLocation}</p>` : ''}
              ${meetingLink.description ? `<p style="margin: 8px 0 0;"><strong>What to expect:</strong> ${meetingLink.description}</p>` : ''}
              ${guestNotes ? `<p style="margin: 4px 0;"><strong>Your notes:</strong> ${guestNotes}</p>` : ''}
            </div>
            ${guestEmailNote}
            ${!needsConfirmation ? `
            ${googleMeetLink ? `
            <div style="margin-top: 20px;">
              <p style="font-weight: 600; margin-bottom: 8px;">Join your meeting:</p>
              <a href="${googleMeetLink}" style="display: inline-block; padding: 12px 24px; background: #00897B; color: white; text-decoration: none; border-radius: 6px; font-weight: 500;">Join with Google Meet</a>
            </div>` : ''}
            <div style="margin-top: 16px;">
              <p style="font-weight: 600; margin-bottom: 8px;">Add to your calendar:</p>
              <a href="${googleCalUrl}" style="display: inline-block; padding: 10px 20px; background: #3b82f6; color: white; text-decoration: none; border-radius: 6px; margin-right: 8px;">Google Calendar</a>
              <span style="color: #6b7280;">or download the attached .ics file</span>
            </div>` : ''}
          </div>`;

      const guestEmailPayload: any = {
        from: MEETING_CALENDAR_FROM,
        to: [guestEmail],
        subject: guestEmailSubject,
        html: guestHtml,
      };
      if (!needsConfirmation) {
        guestEmailPayload.attachments = [{
          filename: 'meeting.ics',
          content: btoa(icsContent),
        }];
      }
      const guestResult = await _resend!.emails.send(guestEmailPayload);
      console.log("Guest confirmation sent:", JSON.stringify(guestResult));
    } catch (e: any) {
      console.error("Failed to send guest email:", JSON.stringify(e?.message || e));
    }

    // Send notification to host
    const hostSubject = needsConfirmation
      ? `Action required: ${guestName} wants to book ${meetingLink.name}`
      : `New booking: ${meetingLink.name} with ${guestName}`;

    try {
      await _resend!.emails.send({
        from: MEETING_CALENDAR_FROM,
        to: [hostEmail],
        subject: hostSubject,
        html: `
          <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #1f2937;">${needsConfirmation ? '⏳ Booking Request' : '📅 New Meeting Booked'}</h2>
            <h3 style="color: #374151; margin-top: 24px;">${meetingLink.name}</h3>
            <div style="background: #f3f4f6; padding: 16px; border-radius: 8px; margin: 16px 0;">
              <p style="margin: 4px 0;"><strong>Guest:</strong> ${guestName} (${guestEmail})</p>
              <p style="margin: 4px 0;"><strong>When:</strong> ${formatDateTime(startTime, meetingLink.time_zone)}</p>
              <p style="margin: 4px 0;"><strong>Duration:</strong> ${effectiveDuration} minutes</p>
              ${eventLocation ? `<p style="margin: 4px 0;"><strong>Location:</strong> ${eventLocation}</p>` : ''}
              ${guestNotes ? `<p style="margin: 4px 0;"><strong>Notes:</strong> ${guestNotes}</p>` : ''}
            </div>
            ${needsConfirmation ? '<p style="color: #92400e;">This booking requires your confirmation. Please review and confirm in Orbit.</p>' : ''}
            <a href="https://orbit.tuxxagency.com/admin/calendar" style="display: inline-block; padding: 10px 20px; background: #3b82f6; color: white; text-decoration: none; border-radius: 6px;">View in Orbit</a>
          </div>
        `,
        attachments: [
          {
            filename: 'meeting.ics',
            content: btoa(icsContent),
          }
        ],
      });
      console.log("Host notification sent");
    } catch (e: any) {
      console.error("Failed to send host email:", JSON.stringify(e?.message || e));
    }

    // Send SMS confirmation to guest via Telnyx (if phone number available)
    try {
      // Check if guest has a phone number (from audit_submissions or booking responses)
      let guestPhone: string | null = null;

      if (bookingResponses?.phone) {
        guestPhone = bookingResponses.phone;
      } else {
        // Try to find phone from audit_submissions or inbox_contacts
        const { data: contact } = await supabase
          .from('inbox_contacts')
          .select('primary_phone')
          .eq('primary_email', guestEmail)
          .maybeSingle();
        guestPhone = contact?.primary_phone || null;
      }

      if (guestPhone) {
        const telnyxApiKey = telnyxCreds.apiKey;
        const telnyxFrom = telnyxCreds.fromNumber;

        if (telnyxApiKey && telnyxFrom) {
          const smsBody = needsConfirmation
            ? `Hi ${guestName}, your booking request for ${meetingLink.name} on ${formatDateTime(startTime, guestTimeZone)} has been received. We'll confirm shortly. — TUXX`
            : `Hi ${guestName}, your call with TUXX is confirmed for ${formatDateTime(startTime, guestTimeZone)} (${effectiveDuration} mins).${videoConferenceLink ? ` Join: ${videoConferenceLink}` : ''} — TUXX`;

          const smsRes = await fetch("https://api.telnyx.com/v2/messages", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${telnyxApiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              from: telnyxFrom,
              to: guestPhone,
              text: smsBody,
            }),
          });

          if (smsRes.ok) {
            console.log("[meeting-book] SMS confirmation sent to", guestPhone);
          } else {
            const smsErr = await smsRes.text();
            console.error("[meeting-book] SMS send failed:", smsRes.status, smsErr);
          }
        }
      }
    } catch (smsError) {
      console.error("[meeting-book] SMS error (non-blocking):", smsError);
    }

    // Schedule reminders (24h and 1h before)
    try {
      const reminderTimes = [
        { minutes_before: 1440, label: "24h" }, // 24 hours
        { minutes_before: 60, label: "1h" },    // 1 hour
      ];

      const reminderRecipients = [
        {
          recipient: "guest",
          name: guestName,
          email: guestEmail,
          phone: bookingResponses?.phone || null,
        },
        {
          recipient: "host",
          name: hostName,
          email: hostEmail,
          phone: null,
        },
      ];

      for (const reminder of reminderTimes) {
        const reminderAt = new Date(new Date(startTime).getTime() - reminder.minutes_before * 60 * 1000);

        if (reminderAt <= new Date()) continue;

        for (const who of reminderRecipients) {
          if (!who.email) continue;

          const { error } = await supabase.from("meeting_reminders").insert({
            booking_id: booking?.id,
            event_id: event.id,
            guest_name: who.name,
            guest_email: who.email,
            guest_phone: who.phone,
            host_email: hostEmail,
            meeting_name: meetingLink.name,
            start_time: startTime,
            duration_minutes: effectiveDuration,
            video_link: videoConferenceLink,
            reminder_at: reminderAt.toISOString(),
            minutes_before: reminder.minutes_before,
            status: "pending",
            recipient: who.recipient,
          });

          if (error) {
            console.error(
              `[meeting-book] Failed to schedule ${reminder.label} ${who.recipient} reminder:`,
              error.message,
            );
          } else {
            console.log(
              `[meeting-book] ${reminder.label} ${who.recipient} reminder scheduled for`,
              reminderAt.toISOString(),
            );
          }
        }
      }
    } catch (reminderError) {
      console.error("[meeting-book] Reminder scheduling error (non-blocking):", reminderError);
    }

    // Log to inbox for tracking
    try {
      const { data: emailChannel } = await supabase
        .from("inbox_channels")
        .select("id")
        .eq("key", "email")
        .single();

      if (emailChannel) {
        // Log guest confirmation
        const guestSubject = guestEmailSubject;
        const { data: guestConv } = await supabase
          .from("inbox_conversations")
          .insert({
            user_id: meetingLink.user_id,
            channel_id: emailChannel.id,
            contact_address: guestEmail,
            contact_name: guestName,
            subject: guestSubject,
            last_message_snippet: guestSubject,
            last_message_at: new Date().toISOString(),
            folder: "sent",
            labels: ["calendar"],
          })
          .select()
          .single();

        if (guestConv) {
          await supabase
            .from("inbox_messages")
            .insert({
              conversation_id: guestConv.id,
              user_id: meetingLink.user_id,
              channel_id: emailChannel.id,
              direction: "outgoing",
              from_address: MEETING_CALENDAR_FROM_ADDRESS,
              from_name: "TUXX Calendar",
              to_addresses: [{ address: guestEmail }],
              subject: guestSubject,
              body_text: `Meeting confirmation sent: ${meetingLink.name} on ${formatDateTime(startTime, guestTimeZone)}`,
              status: "sent",
            });
        }
        console.log("[meeting-book] Logged to inbox");
      }
    } catch (inboxError) {
      console.error("[meeting-book] Failed to log to inbox (non-blocking):", inboxError);
    }

    return new Response(
      JSON.stringify({ 
        success: true, 
        booking: booking,
        event: event,
        googleCalendarUrl: googleCalUrl,
      }),
      { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
    );
  } catch (error: any) {
    console.error("Error in meeting-book:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
    );
  }
};

serve(handler);
