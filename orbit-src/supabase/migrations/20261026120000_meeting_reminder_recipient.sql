-- Track reminder recipient and delivery failures for meeting reminders.
alter table public.meeting_reminders
  add column if not exists recipient text not null default 'guest';

alter table public.meeting_reminders
  add column if not exists error_message text;

alter table public.meeting_reminders drop constraint if exists meeting_reminders_recipient_check;

alter table public.meeting_reminders
  add constraint meeting_reminders_recipient_check
  check (recipient = any (array['guest'::text, 'host'::text]));
