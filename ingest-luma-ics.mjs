import "dotenv/config";
import fetch from "node-fetch";
import ICAL from "ical.js";
import { createClient } from "@supabase/supabase-js";

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE,
  LUMA_ICS_URL,
  DEFAULT_CITY = "San Francisco",
  DEFAULT_TZ = "America/Los_Angeles",
} = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE || !LUMA_ICS_URL) {
  console.error(
    "Missing env vars. Need SUPABASE_URL, SUPABASE_SERVICE_ROLE, LUMA_ICS_URL."
  );
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, {
  auth: { persistSession: false },
});

/**
 * Lightweight heuristics to split location into venue/address when possible.
 * ICS location is often a single string.
 */
function parseLocation(loc) {
  if (!loc) return { venue_name: null, address: null };

  // Common patterns: "Venue Name - Address" or "Venue Name, Address"
  const dashSplit = loc.split(" - ");
  if (dashSplit.length >= 2) {
    return {
      venue_name: dashSplit[0].trim().slice(0, 120),
      address: dashSplit.slice(1).join(" - ").trim().slice(0, 200),
    };
  }

  const commaSplit = loc.split(",");
  if (commaSplit.length >= 2) {
    return {
      venue_name: commaSplit[0].trim().slice(0, 120),
      address: commaSplit.slice(1).join(",").trim().slice(0, 200),
    };
  }

  return { venue_name: loc.trim().slice(0, 120), address: null };
}

/**
 * Create a stable ID for deduping.
 * ICS UID is best if present.
 */
function stableSourceId(uid, fallbackUrl) {
  if (uid) return `luma_ics:${uid}`;
  if (fallbackUrl) return `luma_ics_url:${fallbackUrl}`;
  return `luma_ics:${Math.random().toString(36).slice(2)}`;
}

/**
 * Prefer the URL in the ICS (often in URL property).
 */
function getEventUrl(component) {
  const url = component.getFirstPropertyValue("url");
  if (typeof url === "string" && url.startsWith("http")) return url;

  // Sometimes there are links embedded in description; we won't regex extract in v1.
  return null;
}

function toISO(v) {
  if (!v) return null;
  // v might be ICAL.Time or Date
  if (v.toJSDate) return v.toJSDate().toISOString();
  if (v instanceof Date) return v.toISOString();
  return null;
}

async function main() {
  console.log("Fetching ICS:", LUMA_ICS_URL);

  const res = await fetch(LUMA_ICS_URL);
  if (!res.ok) {
    throw new Error(`Failed to fetch ICS: ${res.status} ${await res.text()}`);
  }
  const icsText = await res.text();

  const jcalData = ICAL.parse(icsText);
  const comp = new ICAL.Component(jcalData);
  const vevents = comp.getAllSubcomponents("vevent");

  console.log(`Parsed ${vevents.length} vevent items`);

  let upserted = 0;
  let failed = 0;

  for (const vevent of vevents) {
    try {
      const event = new ICAL.Event(vevent);

      const uid = vevent.getFirstPropertyValue("uid") || event.uid || null;
      const title = event.summary || vevent.getFirstPropertyValue("summary") || "Untitled event";
      const description =
        event.description ||
        vevent.getFirstPropertyValue("description") ||
        "Imported from Luma discover feed.";
      const location = event.location || vevent.getFirstPropertyValue("location") || null;

      const startAt = toISO(event.startDate);
      const endAt = toISO(event.endDate) || (startAt ? new Date(new Date(startAt).getTime() + 2 * 60 * 60 * 1000).toISOString() : null);

      const eventUrl = getEventUrl(vevent);
      const sourceId = stableSourceId(uid, eventUrl);

      const { venue_name, address } = parseLocation(location);

      // A stable thumbnail per event (does not require scraping images)
      const thumbnail = `https://picsum.photos/seed/${encodeURIComponent(sourceId)}/1024/1024`;

      // summary: short excerpt
      const summary = description.length > 140 ? `${description.slice(0, 137)}...` : description;

      const row = {
        provider: "luma",
        source_event_id: uid ?? sourceId, // ICS UID = stable dedupe key (fallback to derived ID)
        source_feed_url: LUMA_ICS_URL,

        source: "luma",
        title,
        description,
        long_description: description,
        summary: summary,
        start_at: startAt,
        end_at: endAt,
        timezone: DEFAULT_TZ,
        venue_name,
        address,
        city: DEFAULT_CITY,
        price: "unknown",
        organizer_name: "Luma Discover",

        status: "inbox",
        featured: false,

        event_url: eventUrl,
        thumbnail,

        agenda: ["Imported via Luma ICS"],
        speakers: ["TBA"],

        capacity: 0,
        attendees: 0,
        last_verified_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      const { error } = await supabase.from("events").upsert(row, {
        onConflict: "provider,source_event_id",
      });
      if (error) throw error;

      upserted += 1;
    } catch (e) {
      failed += 1;
      console.error("Failed event:", e?.message || e);
    }
  }

  console.log(`Done. Upserted=${upserted}, Failed=${failed}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
