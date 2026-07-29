// Static-file guard.
//
// The dashboard itself is open — it is a coordination tool for the humanitarian
// community in Somalia, and the API now serves a public-tier payload with no
// site names, site codes or coordinates (see api/lib/public_payload.py).
//
// But the repository root IS the web root. Several files under /data are the
// raw inputs the public payload is derived FROM, and they were reachable
// directly, with no JavaScript involved:
//
//   /data/master-sites.csv   6,807 sites, 6,798 with coordinates, plus
//                            household and individual population figures
//   /data/site-code-crosswalk.json, /data/form-sites.json
//                            site code -> site name lookups, which would undo
//                            the pseudonymisation in the payload
//   /data/site-reconciliation.json
//                            unresolved site references with names
//
// Publishing an aggregate payload while leaving the master list downloadable
// beside it would be theatre. This blocks them at the edge.
//
// Everything else — the dashboard, the API, assets, boundary GeoJSON — is
// served normally and needs no credential.

export const config = {
  // Only the paths that need guarding, so a middleware fault cannot take the
  // whole dashboard offline.
  matcher: "/data/:path*",
};

// Files under /data that the dashboard legitimately fetches at runtime.
// Everything else in that directory is a build input and stays server-side.
const PUBLIC_DATA = new Set([
  "/data/partner-update-status.json",
]);

function notFound() {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Not found</title><meta name="robots" content="noindex,nofollow"></head>
<body style="margin:0;font-family:system-ui,sans-serif;background:#f4f6f7;color:#1d2b30">
<main style="max-width:34rem;margin:12vh auto;padding:2rem;background:#fff;border-radius:10px;border:1px solid #dde3e5">
<h1 style="margin:0 0 .75rem;font-size:1.25rem;color:#17677A">Not available</h1>
<p style="margin:0;line-height:1.6;font-size:.95rem">This file is not published.
Site-level data is not distributed through this dashboard. For coverage figures,
use the dashboard itself or its export menu.</p>
</main></body></html>`,
    {
      // 404 rather than 403: a 403 confirms the file exists and is worth
      // pursuing. There is nothing to gain from telling a stranger that.
      status: 404,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    }
  );
}

function allow() {
  return new Response(null, { headers: { "x-middleware-next": "1" } });
}

export default function middleware(request) {
  const { pathname } = new URL(request.url);
  return PUBLIC_DATA.has(pathname) ? allow() : notFound();
}
