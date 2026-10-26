import { describe, expect, it } from "vitest";
import {
  AUDIT_BOOKING_CARDS,
  buildMeetingEventDescription,
  getPublicBookingCards,
  getPublicBookingSubtitle,
} from "./meetingPublicPage";

describe("getPublicBookingSubtitle", () => {
  it("uses public_page meta when present", () => {
    const subtitle = getPublicBookingSubtitle(
      {
        booking_questions: [{ type: "public_page", subtitle: "Custom intro" }],
      },
      30,
      "Alex",
    );
    expect(subtitle).toBe("Custom intro");
  });

  it("falls back to audit copy for audit slugs", () => {
    expect(getPublicBookingSubtitle({ slug: "tuxx-audit" }, 30, "Chiko")).toBe(
      "30-minute personalised operations audit with Chiko.",
    );
  });

  it("uses generic copy for other links", () => {
    expect(getPublicBookingSubtitle({ slug: "quick-chat" }, 15, "Chiko")).toBe(
      "15-minute call with Chiko.",
    );
  });
});

describe("getPublicBookingCards", () => {
  it("returns audit cards for audit links without meta", () => {
    expect(getPublicBookingCards({ slug: "tuxx-audit" })).toEqual(AUDIT_BOOKING_CARDS);
  });

  it("returns empty for non-audit links without meta", () => {
    expect(getPublicBookingCards({ slug: "quick-chat" })).toEqual([]);
  });
});

describe("buildMeetingEventDescription", () => {
  it("appends guest notes under meeting description", () => {
    expect(buildMeetingEventDescription("What to expect", "Bring Q4 numbers")).toBe(
      "What to expect\n\nGuest notes:\nBring Q4 numbers",
    );
  });
});
