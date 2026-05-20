import { Hono } from 'hono'

type Bindings = { BUCKET: R2Bucket }

const app = new Hono<{ Bindings: Bindings }>()

app.get('/', (c) =>
  c.html(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>matroids.icarm.cloud</title>
  <style>${styles}</style>
</head>
<body>
  <h1>matroid database</h1>
  <p>Enumerations of matroids by (n, r), where n is the number of elements and r is the rank.</p>
  <ul>
    <li><a href="/enumeration/n13r03">n13r03</a> — matroids on 13 elements of rank 3</li>
  </ul>
</body>
</html>`),
)

type Chunk = {
  key: string
  filename: string
  size: number
  uploaded: Date
  firstIdx: bigint
  lastIdx: bigint
}

function binomial(n: number, r: number): bigint {
  if (r < 0 || r > n) return 0n
  const k = Math.min(r, n - r)
  let num = 1n
  let den = 1n
  for (let i = 0; i < k; i++) {
    num *= BigInt(n - i)
    den *= BigInt(i + 1)
  }
  return num / den
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

function fmtBigInt(n: bigint): string {
  const s = n.toString()
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

async function listAllChunks(bucket: R2Bucket, prefix: string): Promise<Chunk[]> {
  const chunks: Chunk[] = []
  let cursor: string | undefined
  for (;;) {
    const page: R2Objects = await bucket.list({ prefix, cursor, limit: 1000 })
    for (const obj of page.objects) {
      const filename = obj.key.slice(prefix.length)
      const m = filename.match(/^(\d+)-(\d+)\.sz\.xz$/)
      if (!m) continue
      chunks.push({
        key: obj.key,
        filename,
        size: obj.size,
        uploaded: obj.uploaded,
        firstIdx: BigInt(m[1]),
        lastIdx: BigInt(m[2]),
      })
    }
    if (!page.truncated) break
    cursor = page.cursor
  }
  chunks.sort((a, b) => {
    if (a.firstIdx !== b.firstIdx) return a.firstIdx < b.firstIdx ? -1 : 1
    return a.lastIdx < b.lastIdx ? -1 : a.lastIdx > b.lastIdx ? 1 : 0
  })
  return chunks
}

const DOWNLOAD_BASE = 'https://matroids-download.icarm.cloud'

function chunkUrl(key: string): string {
  return `${DOWNLOAD_BASE}/${encodeURI(key)}`
}

type Summary = {
  slug: string
  n: number
  r: number
  lineLen: bigint
  chunks: Chunk[]
  totalBytes: number
  totalMatroids: bigint
}

async function loadSummary(
  bucket: R2Bucket,
  slug: string,
): Promise<Summary | null> {
  const m = slug.match(/^n(\d+)r(\d+)$/)
  if (!m) return null
  const n = Number(m[1])
  const r = Number(m[2])
  const lineLen = binomial(n, r)

  const prefix = `enumeration/${slug}:`
  const chunks = await listAllChunks(bucket, prefix)

  const totalBytes = chunks.reduce((s, c) => s + c.size, 0)
  const totalMatroids = chunks.reduce(
    (s, c) => s + (c.lastIdx - c.firstIdx + 1n),
    0n,
  )

  return { slug, n, r, lineLen, chunks, totalBytes, totalMatroids }
}

app.get('/enumeration/:slug', async (c) => {
  const slug = c.req.param('slug')
  const summary = await loadSummary(c.env.BUCKET, slug)
  if (!summary) {
    return c.html(renderError(slug, 'Slug must look like n<N>r<R>, e.g. n13r03.'), 400)
  }
  return c.html(renderPage(summary))
})

app.get('/enumeration/:slug/manifest.json', async (c) => {
  const slug = c.req.param('slug')
  const summary = await loadSummary(c.env.BUCKET, slug)
  if (!summary) {
    return c.json({ error: 'Slug must look like n<N>r<R>, e.g. n13r03.', slug }, 400)
  }
  return c.json({
    slug: summary.slug,
    n: summary.n,
    r: summary.r,
    lineLen: summary.lineLen.toString(),
    chunkCount: summary.chunks.length,
    totalMatroids: summary.totalMatroids.toString(),
    totalBytes: summary.totalBytes,
    chunks: summary.chunks.map((ch) => ({
      filename: ch.filename,
      key: ch.key,
      url: chunkUrl(ch.key),
      firstIdx: ch.firstIdx.toString(),
      lastIdx: ch.lastIdx.toString(),
      count: (ch.lastIdx - ch.firstIdx + 1n).toString(),
      size: ch.size,
      uploaded: ch.uploaded.toISOString(),
    })),
  })
})

const styles = `
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
         max-width: 60rem; margin: 2rem auto; padding: 0 1rem; color: #222; }
  h1 { margin-bottom: 0.25rem; }
  .subtitle { color: #666; margin-top: 0; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.25rem 1rem;
       margin: 1rem 0 2rem; }
  dt { color: #666; }
  dd { margin: 0; font-variant-numeric: tabular-nums; }
  table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
  th, td { padding: 0.3rem 0.6rem; text-align: right; border-bottom: 1px solid #eee; }
  th:first-child, td:first-child { text-align: left; }
  thead th { border-bottom: 2px solid #ccc; background: #fafafa; }
  tbody tr:hover { background: #f7f7f7; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .empty { color: #888; font-style: italic; margin-top: 2rem; }
  .error { color: #a00; }
`

function renderPage(s: Summary): string {
  const { slug, n, r, lineLen, chunks, totalBytes, totalMatroids } = s
  const rows = chunks
    .map((c) => {
      const count = c.lastIdx - c.firstIdx + 1n
      const href = chunkUrl(c.key)
      return `<tr>
        <td><a href="${href}"><code>${c.filename}</code></a></td>
        <td>${fmtBigInt(c.firstIdx)} – ${fmtBigInt(c.lastIdx)}</td>
        <td>${fmtBigInt(count)}</td>
        <td>${fmtBytes(c.size)}</td>
        <td>${c.uploaded.toISOString().slice(0, 19).replace('T', ' ')}</td>
      </tr>`
    })
    .join('')

  const body =
    chunks.length === 0
      ? `<p class="empty">No chunks uploaded for <code>${slug}</code> yet.</p>`
      : `<table>
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
        </table>`

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${slug} — matroid enumeration</title>
  <style>${styles}</style>
</head>
<body>
  <h1>${slug}</h1>
  <p class="subtitle">Matroids on ${n} elements of rank ${r}. <a href="/enumeration/${slug}/manifest.json">manifest.json</a></p>
  <dl>
    <dt>n</dt><dd>${n}</dd>
    <dt>r</dt><dd>${r}</dd>
    <dt>line length</dt><dd>C(${n},${r}) = ${fmtBigInt(lineLen)}</dd>
    <dt>chunks</dt><dd>${chunks.length}</dd>
    <dt>matroids stored</dt><dd>${fmtBigInt(totalMatroids)}</dd>
    <dt>total size</dt><dd>${fmtBytes(totalBytes)}</dd>
  </dl>
  ${body}
</body>
</html>`
}

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
<head><meta charset="utf-8"><title>error</title><style>${styles}</style></head>
<body>
  <h1>Invalid enumeration</h1>
  <p class="error">${escapeHtml(msg)}</p>
  <p>Got: <code>${escapeHtml(slug)}</code></p>
</body>
</html>`
}

export default app
