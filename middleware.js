// EMERGENCY ACCESS CONTROL — TEMPORARY. EXPIRES 2026-08-12.
//
// Why this exists
// ---------------
// The unauthenticated payload carried 1,905 site names, 1,808 CCCM Site IDs
// and 1,792 precise coordinates, including 874 named sites publicly flagged as
// having no protection or site-management actor present. In the Somalia
// operating context that combination is exploitable, so the whole site is
// gated until the public aggregate tier ships (PR #1) and the public tier can
// reopen safely.
//
// This is containment, NOT the access design. A single shared credential gives
// no per-user revocation and no audit trail; it is proportionate only as a
// short bridge, because the alternative is leaving the data open while a
// better control is built. It is replaced by per-user magic-link auth in
// PR #2, and the credential is rotated on the day the public tier reopens.
//
// REMOVE OR REPLACE BY 2026-08-12. If that date has passed and this file is
// still here, the migration stalled — escalate rather than extending silently.
//
// Fails CLOSED. With no credential configured the site serves 503, never open
// content: a misconfiguration must not silently re-expose the dataset. 503
// (not 401) is deliberate — an unconfigured deployment is an outage, and
// prompting partners for a password that cannot work would read as a broken
// login rather than a maintenance window.

export const config = {
  // Every route. No allowlisted paths — the API is the actual exposure, and a
  // static-asset exemption is how these gates leak.
  matcher: "/:path*",
};

const REALM = "CCCM Somalia Service Mapping — partner access";

// Constant-time comparison. A naive === leaks the credential a character at a
// time to anyone willing to measure; the cost of doing this properly is four
// lines.
function safeEqual(a, b) {
  const enc = new TextEncoder();
  const ba = enc.encode(a || "");
  const bb = enc.encode(b || "");
  // Compare a fixed number of bytes so length alone is not a side channel.
  const len = Math.max(ba.length, bb.length);
  let diff = ba.length ^ bb.length;
  for (let i = 0; i < len; i++) {
    diff |= (ba[i] || 0) ^ (bb[i] || 0);
  }
  return diff === 0;
}

function unconfigured() {
  return new Response(
    page(
      "Service temporarily unavailable",
      "The dashboard is being reconfigured and will return shortly. No action is needed from partners."
    ),
    {
      status: 503,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Retry-After": "3600",
      },
    }
  );
}

function challenge() {
  return new Response(
    page(
      "Partner access required",
      "This dashboard is temporarily restricted to CCCM Cluster partners while a public summary view is prepared. " +
        "Partners: use the access details circulated by the Cluster. If you do not have them, contact the CCCM Cluster Somalia coordination team."
    ),
    {
      status: 401,
      headers: {
        "WWW-Authenticate": `Basic realm="${REALM}", charset="UTF-8"`,
        "Content-Type": "text/html; charset=utf-8",
        // Never let a challenge or a rejection be cached and replayed.
        "Cache-Control": "no-store",
      },
    }
  );
}

// Self-contained: the gate covers static assets too, so this page cannot
// reference a stylesheet or a script.
function page(heading, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${heading} — CCCM Cluster Somalia</title>
<meta name="robots" content="noindex,nofollow"></head>
<body style="margin:0;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;background:#f4f6f7;color:#1d2b30">
<main style="max-width:34rem;margin:12vh auto;padding:2rem;background:#fff;border-radius:10px;border:1px solid #dde3e5">
<h1 style="margin:0 0 .75rem;font-size:1.25rem;color:#17677A">${heading}</h1>
<p style="margin:0;line-height:1.6;font-size:.95rem">${body}</p>
</main></body></html>`;
}

export default function middleware(request) {
  const user = process.env.DASHBOARD_BASIC_AUTH_USER;
  const password = process.env.DASHBOARD_BASIC_AUTH_PASSWORD;

  if (!user || !password) return unconfigured();

  const header = request.headers.get("authorization") || "";

  // Scheduled refresh. Vercel sends `Authorization: Bearer $CRON_SECRET` on
  // cron invocations when CRON_SECRET is set, so the daily 03:00 refresh can
  // authenticate as a service principal rather than needing a path exemption.
  // This is NOT an allowlisted path: an unauthenticated request to the same
  // URL is still rejected. If CRON_SECRET is unset the cron fails closed and
  // the data goes stale — which is why PR #9 adds refresh-failure alerting.
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && header.startsWith("Bearer ")) {
    return safeEqual(header.slice(7), cronSecret) ? allow() : challenge();
  }

  if (!header.toLowerCase().startsWith("basic ")) return challenge();

  let decoded;
  try {
    decoded = atob(header.slice(6).trim());
  } catch {
    return challenge();
  }

  // Split on the FIRST colon only: a password may legitimately contain one.
  const sep = decoded.indexOf(":");
  if (sep === -1) return challenge();

  // Both comparisons always run — short-circuiting on the username would
  // reveal whether a username was correct.
  const userOk = safeEqual(decoded.slice(0, sep), user);
  const passOk = safeEqual(decoded.slice(sep + 1), password);
  if (!(userOk && passOk)) return challenge();

  return allow();
}

// Nothing behind this gate may be cached by a shared CDN: a cached
// partner-tier response served to a client that never authenticated would
// defeat the whole control.
function allow() {
  const response = new Response(null, { headers: { "x-middleware-next": "1" } });
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
