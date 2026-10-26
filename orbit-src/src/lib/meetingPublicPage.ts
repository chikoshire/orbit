export type PublicBookingCard = { title: string; desc: string };

export type MeetingLinkLike = {
  slug?: string | null;
  category?: string | null;
  description?: string | null;
  booking_questions?: unknown;
};

export const AUDIT_BOOKING_CARDS: PublicBookingCard[] = [
  { title: "Stack Audit", desc: "Review your current tools and identify overlap" },
  { title: "Cost Analysis", desc: "See how much you're spending on disconnected systems" },
  { title: "Orbit Demo", desc: "Walk through how a unified system replaces your stack" },
];

type PublicPageMeta = {
  subtitle?: string;
  cards?: PublicBookingCard[];
};

function parsePublicPageMeta(bookingQuestions: unknown): PublicPageMeta | null {
  if (!Array.isArray(bookingQuestions)) return null;
  const entry = bookingQuestions.find(
    (q) => q && typeof q === "object" && (q as { type?: string }).type === "public_page",
  ) as { subtitle?: string; cards?: PublicBookingCard[] } | undefined;
  if (!entry) return null;
  const cards = Array.isArray(entry.cards)
    ? entry.cards.filter((c) => c && typeof c.title === "string" && typeof c.desc === "string")
    : undefined;
  return {
    subtitle: typeof entry.subtitle === "string" ? entry.subtitle : undefined,
    cards,
  };
}

function isAuditStyleLink(link: MeetingLinkLike): boolean {
  const slug = (link.slug ?? "").toLowerCase();
  const category = (link.category ?? "").toLowerCase();
  return slug.includes("audit") || category === "audit";
}

export function getPublicBookingSubtitle(
  link: MeetingLinkLike,
  durationMinutes: number,
  hostName: string,
): string | null {
  const meta = parsePublicPageMeta(link.booking_questions);
  if (meta?.subtitle) return meta.subtitle;
  if (isAuditStyleLink(link)) {
    return `${durationMinutes}-minute personalised operations audit with ${hostName}.`;
  }
  if (hostName) {
    return `${durationMinutes}-minute call with ${hostName}.`;
  }
  return `${durationMinutes}-minute call.`;
}

export function getPublicBookingCards(link: MeetingLinkLike): PublicBookingCard[] {
  const meta = parsePublicPageMeta(link.booking_questions);
  if (meta?.cards?.length) return meta.cards;
  if (isAuditStyleLink(link)) return AUDIT_BOOKING_CARDS;
  return [];
}

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
