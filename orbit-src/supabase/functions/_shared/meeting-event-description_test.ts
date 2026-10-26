import { buildMeetingEventDescription } from "./meeting-event-description.ts";

Deno.test("buildMeetingEventDescription keeps description when no notes", () => {
  if (buildMeetingEventDescription("Audit walkthrough", "") !== "Audit walkthrough") {
    throw new Error("expected description only");
  }
});

Deno.test("buildMeetingEventDescription appends guest notes", () => {
  const out = buildMeetingEventDescription("Audit walkthrough", "We use HubSpot");
  if (!out.includes("Guest notes:") || !out.includes("HubSpot")) {
    throw new Error(`unexpected: ${out}`);
  }
});
