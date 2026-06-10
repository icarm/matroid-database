import { Hono } from 'hono'
import type { MiddlewareHandler } from 'hono'
import { cloudflareAccess } from '@hono/cloudflare-access'

type Bindings = {
  BUCKET: R2Bucket
  // Cloudflare Access team name (the <team> in <team>.cloudflareaccess.com)
  // and the Application Audience (AUD) tag of the Access app covering
  // /admin/*. Set in wrangler.jsonc vars. If unset, /admin/* fails closed.
  ACCESS_TEAM?: string
  ACCESS_AUD?: string
  // Set to '1' in .dev.vars ONLY, to use /admin/* under `wrangler dev`
  // where there is no Access edge in front of the Worker.
  ACCESS_DEV_BYPASS?: string
}

const app = new Hono<{ Bindings: Bindings }>()

const footer = `<footer>
    <a href="https://github.com/icarm/matroid-database">source</a>
    ·
    <a href="https://icarm.io">icarm.io</a>
  </footer>`

app.get('/', async (c) => {
  const slugs = await listManifestSlugs(c.env.BUCKET)
  const items = slugs
    .map((slug) => {
      const m = slug.match(SLUG_RE)!
      return `<li><a href="/enumeration/${slug}">${slug}</a> — matroids on ${Number(m[1])} elements of rank ${Number(m[2])}</li>`
    })
    .join('\n    ')
  c.header('Cache-Control', PUBLIC_CACHE)
  return c.html(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>matroids.icarm.cloud</title>
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <h1>matroid database</h1>
  <p>Enumerations of matroids by (n, r), where n is the number of elements and r is the rank.</p>
  <ul>
    ${items || '<li>no enumerations published yet</li>'}
  </ul>
  <p>Tooling for downloading and reading the data is available at
    <a href="https://github.com/icarm/matroid-database-client">matroid-database-client</a>.</p>
  ${footer}
</body>
</html>`)
})

type Chunk = {
  key: string
  filename: string
  size: number
  uploaded: Date
  firstIdx: number
  lastIdx: number
}

// Counts and indexes top out in the tens of trillions, well below
// Number.MAX_SAFE_INTEGER; guard anyway so an out-of-range value fails
// loudly instead of silently losing precision.
function toSafeInteger(s: string | bigint): number {
  const n = Number(s)
  if (!Number.isSafeInteger(n)) throw new Error(`integer out of safe range: ${s}`)
  return n
}

function binomial(n: number, r: number): number {
  if (r < 0 || r > n) return 0
  const k = Math.min(r, n - r)
  let num = 1n
  let den = 1n
  for (let i = 0; i < k; i++) {
    num *= BigInt(n - i)
    den *= BigInt(i + 1)
  }
  return toSafeInteger(num / den)
}

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KiB', 'MiB', 'GiB', 'TiB']
  let v = bytes / 1024
  let u = 0
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024
    u++
  }
  return `${v.toFixed(2)} ${units[u]}`
}

function fmtInt(n: number): string {
  const s = n.toString()
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function fmtTimestamp(iso: string): string {
  return iso.slice(0, 19).replace('T', ' ')
}

async function listAllChunks(bucket: R2Bucket, prefix: string): Promise<Chunk[]> {
  const chunks: Chunk[] = []
  let cursor: string | undefined
  for (;;) {
    const page: R2Objects = await bucket.list({ prefix, cursor, limit: 1000 })
    for (const obj of page.objects) {
      const filename = obj.key.slice(prefix.length)
      // Only <firstIdx>-<lastIdx>.sz.xz files are chunks; anything else
      // under the prefix is ignored.
      const m = filename.match(/^(\d+)-(\d+)\.sz\.xz$/)
      if (!m) continue
      chunks.push({
        key: obj.key,
        filename,
        size: obj.size,
        uploaded: obj.uploaded,
        firstIdx: toSafeInteger(m[1]),
        lastIdx: toSafeInteger(m[2]),
      })
    }
    if (!page.truncated) break
    cursor = page.cursor
  }
  chunks.sort((a, b) => a.firstIdx - b.firstIdx || a.lastIdx - b.lastIdx)
  return chunks
}

const DOWNLOAD_BASE = 'https://matroids-download.icarm.cloud'

function chunkUrl(key: string): string {
  return `${DOWNLOAD_BASE}/${encodeURI(key)}`
}

// ---------------------------------------------------------------------------
// Manifest
//
// A precomputed listing of all chunks of an enumeration, stored at
// enumeration-manifest/<slug>.json so the public pages never have to page
// through the (possibly 30k+) chunk objects.
// ---------------------------------------------------------------------------

type ManifestChunk = {
  url: string
  filename: string
  firstIdx: number
  lastIdx: number
  count: number
  size: number
  uploaded: string
}

type Manifest = {
  slug: string
  n: number
  r: number
  lineLen: number
  generatedAt: string
  chunkCount: number
  totalMatroids: number
  totalBytes: number
  chunks: ManifestChunk[]
}

const SLUG_RE = /^n(\d+)r(\d+)$/

function chunkPrefix(slug: string): string {
  return `enumeration/${slug}:`
}

function manifestKey(slug: string): string {
  return `enumeration-manifest/${slug}.json`
}

async function buildManifest(bucket: R2Bucket, slug: string): Promise<Manifest | null> {
  const m = slug.match(SLUG_RE)
  if (!m) return null
  const n = Number(m[1])
  const r = Number(m[2])

  const chunks = await listAllChunks(bucket, chunkPrefix(slug))
  const totalBytes = chunks.reduce((s, c) => s + c.size, 0)
  const totalMatroids = chunks.reduce((s, c) => s + (c.lastIdx - c.firstIdx + 1), 0)

  return {
    slug,
    n,
    r,
    lineLen: binomial(n, r),
    generatedAt: new Date().toISOString(),
    chunkCount: chunks.length,
    totalMatroids,
    totalBytes,
    chunks: chunks.map((c) => ({
      url: chunkUrl(c.key),
      filename: c.filename,
      firstIdx: c.firstIdx,
      lastIdx: c.lastIdx,
      count: c.lastIdx - c.firstIdx + 1,
      size: c.size,
      uploaded: c.uploaded.toISOString(),
    })),
  }
}

async function regenerateManifest(bucket: R2Bucket, slug: string): Promise<Manifest | null> {
  const manifest = await buildManifest(bucket, slug)
  if (!manifest) return null
  if (manifest.chunkCount === 0) {
    // No chunks left; remove any stale manifest rather than storing an empty one.
    await bucket.delete(manifestKey(slug))
    return manifest
  }
  await bucket.put(manifestKey(slug), JSON.stringify(manifest), {
    httpMetadata: { contentType: 'application/json' },
    customMetadata: {
      generatedAt: manifest.generatedAt,
      chunkCount: String(manifest.chunkCount),
      totalMatroids: String(manifest.totalMatroids),
      totalBytes: String(manifest.totalBytes),
    },
  })
  return manifest
}

async function loadStoredManifest(bucket: R2Bucket, slug: string): Promise<Manifest | null> {
  const obj = await bucket.get(manifestKey(slug))
  if (!obj) return null
  return obj.json<Manifest>()
}

// Enumerations that have a manifest; these are the published ones the
// home page links to.
async function listManifestSlugs(bucket: R2Bucket): Promise<string[]> {
  const slugs: string[] = []
  let cursor: string | undefined
  for (;;) {
    const page: R2Objects = await bucket.list({
      prefix: 'enumeration-manifest/',
      cursor,
      limit: 1000,
    })
    for (const obj of page.objects) {
      const m = obj.key.match(/^enumeration-manifest\/(n\d+r\d+)\.json$/)
      if (m) slugs.push(m[1])
    }
    if (!page.truncated) break
    cursor = page.cursor
  }
  return slugs.sort()
}

async function discoverSlugs(bucket: R2Bucket): Promise<string[]> {
  const slugs: string[] = []
  let cursor: string | undefined
  for (;;) {
    const page: R2Objects = await bucket.list({
      prefix: 'enumeration/',
      delimiter: ':',
      cursor,
      limit: 1000,
    })
    for (const p of page.delimitedPrefixes) {
      const m = p.match(/^enumeration\/(n\d+r\d+):$/)
      if (m) slugs.push(m[1])
    }
    if (!page.truncated) break
    cursor = page.cursor
  }
  return slugs.sort()
}

// ---------------------------------------------------------------------------
// Public routes
// ---------------------------------------------------------------------------

const PUBLIC_CACHE = 'public, max-age=300'

app.get('/enumeration/:slug', async (c) => {
  const slug = c.req.param('slug')
  if (!SLUG_RE.test(slug)) {
    return c.html(renderError(slug, 'Slug must look like n<N>r<R>, e.g. n13r03.'), 400)
  }
  const manifest = await loadStoredManifest(c.env.BUCKET, slug)
  if (!manifest || manifest.chunkCount === 0) {
    return c.html(renderError(slug, `No manifest found for ${slug}.`), 404)
  }
  const pageCount = Math.max(1, Math.ceil(manifest.chunks.length / PAGE_SIZE))
  const rawPage = Number(c.req.query('page') ?? '1')
  const page = Number.isInteger(rawPage) ? Math.min(Math.max(rawPage, 1), pageCount) : 1
  c.header('Cache-Control', PUBLIC_CACHE)
  return c.html(renderPage(manifest, page, pageCount))
})

app.get('/enumeration/:slug/manifest.json', async (c) => {
  const slug = c.req.param('slug')
  if (!SLUG_RE.test(slug)) {
    return c.json({ error: 'Slug must look like n<N>r<R>, e.g. n13r03.', slug }, 400)
  }
  const obj = await c.env.BUCKET.get(manifestKey(slug))
  if (!obj) {
    return c.json({ error: `No manifest found for ${slug}.`, slug }, 404)
  }
  return new Response(obj.body, {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': PUBLIC_CACHE,
    },
  })
})

// Chunk rows per page; a 30k-row table is ~10 MB of HTML, so large
// enumerations are split into pages.
const PAGE_SIZE = 500

function pageUrl(slug: string, page: number): string {
  return page === 1 ? `/enumeration/${slug}` : `/enumeration/${slug}?page=${page}`
}

function renderPagination(m: Manifest, page: number, pageCount: number): string {
  if (pageCount === 1) return ''
  const first = (page - 1) * PAGE_SIZE + 1
  const last = Math.min(page * PAGE_SIZE, m.chunks.length)
  const link = (target: number, label: string, enabled: boolean) =>
    enabled ? `<a href="${pageUrl(m.slug, target)}">${label}</a>` : `<span class="disabled">${label}</span>`
  return `<nav class="pagination">
    ${link(1, '« first', page > 1)}
    ${link(page - 1, '‹ prev', page > 1)}
    <span>page ${fmtInt(page)} of ${fmtInt(pageCount)} (chunks ${fmtInt(first)}–${fmtInt(last)} of ${fmtInt(m.chunks.length)})</span>
    ${link(page + 1, 'next ›', page < pageCount)}
    ${link(pageCount, 'last »', page < pageCount)}
  </nav>`
}

function renderPage(m: Manifest, page: number, pageCount: number): string {
  const row = (c: ManifestChunk) => `<tr>
        <td><a href="${c.url}"><code>${c.filename}</code></a></td>
        <td>${fmtInt(c.firstIdx)} – ${fmtInt(c.lastIdx)}</td>
        <td>${fmtInt(c.count)}</td>
        <td>${fmtBytes(c.size)}</td>
        <td>${fmtTimestamp(c.uploaded)}</td>
      </tr>`

  const rows = m.chunks.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map(row).join('')
  const pagination = renderPagination(m, page, pageCount)

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${m.slug} — matroid enumeration</title>
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <p class="breadcrumb"><a href="/">← all enumerations</a></p>
  <h1>${m.slug}</h1>
  <p class="subtitle">Matroids on ${m.n} elements of rank ${m.r}. <a href="/enumeration/${m.slug}/manifest.json">manifest.json</a></p>
  <dl>
    <dt>n</dt><dd>${m.n}</dd>
    <dt>r</dt><dd>${m.r}</dd>
    <dt>line length</dt><dd>C(${m.n},${m.r}) = ${fmtInt(m.lineLen)}</dd>
    <dt>chunks</dt><dd>${fmtInt(m.chunkCount)}</dd>
    <dt>matroids stored</dt><dd>${fmtInt(m.totalMatroids)}</dd>
    <dt>total size</dt><dd>${fmtBytes(m.totalBytes)}</dd>
  </dl>
  <p>Tooling for downloading and reading the chunks below is available at
    <a href="https://github.com/icarm/matroid-database-client">matroid-database-client</a>.</p>
  ${pagination}
  <table>
    <thead>
      <tr>
        <th>file</th>
        <th>index range</th>
        <th>count</th>
        <th>size</th>
        <th>uploaded (UTC)</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
  ${pagination}
  ${footer}
</body>
</html>`
}

// ---------------------------------------------------------------------------
// Admin routes (behind Cloudflare Access)
// ---------------------------------------------------------------------------

let accessMiddleware: MiddlewareHandler | null = null

app.use('/admin/*', async (c, next) => {
  if (c.env.ACCESS_DEV_BYPASS === '1') return next()
  const team = c.env.ACCESS_TEAM
  if (!team) {
    return c.text('Admin is not configured: set the ACCESS_TEAM and ACCESS_AUD vars.', 503)
  }
  if (!accessMiddleware) {
    accessMiddleware = cloudflareAccess(team, c.env.ACCESS_AUD || undefined)
  }
  return accessMiddleware(c, next)
})

app.get('/admin', async (c) => {
  const bucket = c.env.BUCKET
  const slugs = await discoverSlugs(bucket)
  const heads = await Promise.all(slugs.map((s) => bucket.head(manifestKey(s))))

  const rows = slugs
    .map((slug, i) => {
      const meta = heads[i]?.customMetadata
      const status = meta
        ? `<td>${fmtInt(Number(meta.chunkCount ?? '0'))}</td>
           <td>${fmtInt(Number(meta.totalMatroids ?? '0'))}</td>
           <td>${fmtBytes(Number(meta.totalBytes ?? '0'))}</td>
           <td>${meta.generatedAt ? fmtTimestamp(meta.generatedAt) : '?'}</td>`
        : `<td colspan="4" class="missing">no manifest</td>`
      return `<tr>
        <td><a href="/enumeration/${slug}">${slug}</a></td>
        ${status}
        <td><form method="post" action="/admin/enumeration/${slug}/regenerate-manifest"><button>${meta ? 'regenerate' : 'generate'}</button></form></td>
      </tr>`
    })
    .join('')

  const regenerated = c.req.query('regenerated')
  const chunks = c.req.query('chunks')
  const flash =
    regenerated && SLUG_RE.test(regenerated) && /^\d+$/.test(chunks ?? '')
      ? `<p class="notice">Regenerated manifest for <strong>${regenerated}</strong>: ${fmtInt(Number(chunks!))} chunks.</p>`
      : ''

  const who = c.get('accessPayload')?.email

  return c.html(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>admin — matroid database</title>
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <h1>admin</h1>
  <p class="subtitle">${who ? `Signed in as ${who}.` : 'Access bypassed (dev mode).'}</p>
  ${flash}
  <table>
    <thead>
      <tr>
        <th>enumeration</th>
        <th>chunks</th>
        <th>matroids</th>
        <th>size</th>
        <th>manifest generated (UTC)</th>
        <th></th>
      </tr>
    </thead>
    <tbody>${rows || '<tr><td colspan="6">no enumerations found</td></tr>'}</tbody>
  </table>
  ${footer}
</body>
</html>`)
})

app.post('/admin/enumeration/:slug/regenerate-manifest', async (c) => {
  const slug = c.req.param('slug')
  const manifest = await regenerateManifest(c.env.BUCKET, slug)
  if (!manifest) {
    return c.text(`Invalid slug: ${slug}`, 400)
  }
  return c.redirect(`/admin?regenerated=${slug}&chunks=${manifest.chunkCount}`, 303)
})

// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) =>
    ch === '&' ? '&amp;'
    : ch === '<' ? '&lt;'
    : ch === '>' ? '&gt;'
    : ch === '"' ? '&quot;'
    : '&#39;',
  )
}

function renderError(slug: string, msg: string): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>error</title><link rel="stylesheet" href="/style.css"></head>
<body>
  <p class="breadcrumb"><a href="/">← all enumerations</a></p>
  <h1>Invalid enumeration</h1>
  <p class="error">${escapeHtml(msg)}</p>
  <p>Got: <code>${escapeHtml(slug)}</code></p>
  ${footer}
</body>
</html>`
}

export default app
