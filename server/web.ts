import path from 'node:path'
import { fileURLToPath } from 'node:url'
import http from 'node:http'
import { readFile } from 'node:fs/promises'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
/**
 * Vite build output: see vite.config.ts. Absent until `npm run build`.
 * Two layouts: from source this file is <repo>/server/index.ts and the build
 * is <repo>/dist/web; in the published package it is <pkg>/dist/server/index.js
 * sitting next to <pkg>/dist/web.
 */
export const WEB_DIR =
  path.basename(path.dirname(__dirname)) === 'dist'
    ? path.join(__dirname, '..', 'web')
    : path.join(__dirname, '..', 'dist', 'web')

// HTTP: JSON API + the built SPA
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
}

const NO_BUILD_HTML = `<!doctype html><meta charset="utf-8">
<title>junior — no build</title>
<body style="font:14px/1.6 system-ui;max-width:34em;margin:12vh auto;color:#dce3f0;background:#0d1017">
<h2 style="color:#e8b04b">No web build found</h2>
<p>This server is serving the production bundle from <code>dist/web</code>, which does not exist yet.</p>
<p>For development, run <code>npm run dev</code> and open the Vite URL it prints — it proxies
<code>/ws</code> and <code>/api</code> back here.</p>
<p>For a production-style run: <code>npm run build &amp;&amp; npm start</code>.</p>
</body>`

/**
 * Only this origin may frame the app. Without it any site could put the UI in
 * an invisible frame and steer a click onto Approve. `SAMEORIGIN`, not `DENY`:
 * the UI frames its own artifact and PDF URLs (ArtifactCard, artifact/HtmlView),
 * which are served by server/artifact-serve.ts with their own headers, not these.
 * Junior.app loads the page top-level (BrowserWindow.loadURL in
 * desktop/src/main.ts), so it is unaffected. In dev, Vite serves the HTML
 * shell, so these only apply to the built bundle.
 */
export const SPA_FRAME_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'Content-Security-Policy': "frame-ancestors 'self'",
  'X-Frame-Options': 'SAMEORIGIN',
})

/** The headers every SPA response (the HTML shell and its static assets) is sent with. */
export function spaHeaders(contentType: string): Record<string, string> {
  return { 'content-type': contentType, ...SPA_FRAME_HEADERS }
}

export async function serveWeb(pathname: string, res: http.ServerResponse) {
  // Any path that is not a real asset falls back to index.html (SPA routing).
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  const resolved = path.resolve(WEB_DIR, rel)
  const candidate = resolved.startsWith(WEB_DIR + path.sep) ? resolved : path.join(WEB_DIR, 'index.html')

  for (const file of [candidate, path.join(WEB_DIR, 'index.html')]) {
    try {
      const body = await readFile(file)
      res.writeHead(200, spaHeaders(CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream'))
      res.end(body)
      return
    } catch {
      // try the SPA fallback next
    }
  }
  res.writeHead(200, spaHeaders('text/html; charset=utf-8'))
  res.end(NO_BUILD_HTML)
}
