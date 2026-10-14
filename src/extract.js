// Ask Claude to pull calendar events out of an ordinary email (school newsletters,
// booking confirmations, party invites). Used for forwarded mail and pasted text.
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

const EventSchema = z.object({
  events: z.array(z.object({
    title: z.string(),
    date: z.string(),
    allDay: z.boolean(),
    start: z.string().nullable(),
    end: z.string().nullable(),
    location: z.string().nullable(),
    notes: z.string().nullable(),
  })),
});

const HHMM = /^\d{2}:\d{2}$/;

export async function extractEvents(env, { subject, from, sentAt, text, timeZone }) {
  if (!env.ANTHROPIC_API_KEY) return { events: [], skipped: "no_api_key" };
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const today = new Intl.DateTimeFormat("en-CA", { timeZone, dateStyle: "full" }).format(new Date());
  const response = await client.messages.parse({
    model: "claude-opus-5-5",
    max_tokens: 4000,
    output_config: { effort: "low", format: zodOutputFormat(EventSchema) },
    messages: [{
      role: "user",
      content:
`You read emails for a family calendar. Today is ${today}; the family's time zone is ${timeZone}.
List every event, appointment, booking, deadline or reminder in this email that belongs on a calendar.
- Use dates as YYYY-MM-DD and times as 24-hour HH:MM in the family's time zone (convert if the email names another zone).
- Resolve relative dates ("next Tuesday") against the email's sent date when given, otherwise today.
- allDay is true when no time is given; then start and end are null.
- Keep titles short, like a calendar entry. notes is one line on what the email said, or null.
- Skip marketing, past events, and anything without a specific date. Return an empty list if there is nothing.

From: ${from || "unknown"}
Sent: ${sentAt || "unknown"}
Subject: ${subject || "(none)"}

${text.slice(0, 60000)}`,
    }],
  });
  if (response.stop_reason === "refusal" || !response.parsed_output) return { events: [] };
  const events = response.parsed_output.events
    .filter((e) => /^\d{4}-\d{2}-\d{2}$/.test(e.date))
    .map((e) => {
      const start = e.start && HHMM.test(e.start) ? e.start : null;
      const allDay = e.allDay || !start;
      return {
        title: e.title.slice(0, 120) || "Untitled",
        date: e.date,
        allDay,
        start: allDay ? null : start,
        end: !allDay && e.end && HHMM.test(e.end) ? e.end : null,
        location: e.location ? e.location.slice(0, 160) : null,
        notes: e.notes ? e.notes.slice(0, 300) : null,
      };
    });
  return { events };
}

// Turn an HTML email body into readable text for Claude.
export function htmlToText(html) {
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
