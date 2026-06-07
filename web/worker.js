// context-mode.com router — Context Mode Insight at /, OSS at /oss.
//
// File layout matches the desired URL structure so plain asset routing
// produces the right result even if Workers Builds runs an older wrangler
// that does not yet support `run_worker_first`:
//
//   web/index.html  → served at /          (Context Mode Insight landing)
//   web/oss.html    → served at /oss       (OSS plugin landing)
//
// This worker only handles routing + asset fallthrough. No legacy
// /insights alias — the site only ships /, /oss, /robots.txt, /sitemap.xml.

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (path === "/") {
      return env.ASSETS.fetch(new Request(new URL("/index.html", url), req));
    }
    if (path === "/oss") {
      return env.ASSETS.fetch(new Request(new URL("/oss.html", url), req));
    }
    return env.ASSETS.fetch(req);
  }
};
