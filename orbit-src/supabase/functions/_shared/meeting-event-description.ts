export function buildMeetingEventDescription(
  meetingDescription: string | null | undefined,
  guestNotes: string | null | undefined,
): string {
  const base = (meetingDescription ?? "").trim();
  const notes = (guestNotes ?? "").trim();
  if (!base) return notes;
  if (!notes) return base;
  return `${base}\n\nGuest notes:\n${notes}`;
}
