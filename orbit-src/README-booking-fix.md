# Public meeting booking fixes (TUXX Orbit)

Apply `src/pages/PublicBooking.tsx.patch` in the main Orbit web app (`orbit-src` on your machine), then deploy:

1. **Supabase migration** — `supabase/migrations/20261026120000_meeting_reminder_recipient.sql` on project `ahwgejxbmympgnumkoby` (TUXX · Orbit).
2. **Edge functions** — redeploy `meeting-book` and `process-meeting-reminders`.
3. **Web** — rebuild/deploy the Vite app (e.g. myorbit.dev) after merging the PublicBooking patch.

Optional env override: `MEETING_CALENDAR_FROM` / `MEETING_CALENDAR_FROM_ADDRESS` (default `calendar@tuxxagency.com`).

Per-link copy overrides: add a `booking_questions` entry `{ "type": "public_page", "subtitle": "...", "cards": [{ "title", "desc" }] }`.
