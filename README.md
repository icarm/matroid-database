# matroid-database

Hello-world Cloudflare Worker (Hono + TypeScript) served from
[`matroids.icarm.cloud`](https://matroids.icarm.cloud).

## Setup

```sh
npm install
npx wrangler login            # one-time, opens browser
npm run cf-typegen            # generates worker-configuration.d.ts
```

## Develop

```sh
npm run dev                   # http://localhost:8787
```

## Deploy

```sh
npm run deploy
```

The custom domain in `wrangler.jsonc` (`matroids.icarm.cloud`) requires the
`icarm.cloud` zone to be active on the deploying Cloudflare account; Wrangler
will create the DNS record and attach the route on first deploy.

## Manifests

Each enumeration's chunk listing is precomputed into a manifest stored at
`enumeration/<slug>:manifest.json` in the bucket, so public pages read one
object instead of paging through tens of thousands of chunk keys. Index-like
fields in the manifest (`firstIdx`, `lastIdx`, `count`, `totalMatroids`,
`lineLen`) are decimal **strings**, since counts can exceed
`Number.MAX_SAFE_INTEGER`.

Manifests are regenerated from the admin page at `/admin` (click the button
after uploading a batch of chunks), and nightly by a cron trigger as a safety
net. If a manifest is missing, pages fall back to listing the bucket live.

## Admin auth (Cloudflare Access)

`/admin/*` is protected by Cloudflare Access. One-time setup:

1. In the Zero Trust dashboard, create a self-hosted Access application for
   `matroids.icarm.cloud/admin` (path `admin`), with an Allow policy for your
   email.
2. Set `ACCESS_TEAM` (the `<team>` in `<team>.cloudflareaccess.com`) and
   `ACCESS_AUD` (the application's Audience tag) in `wrangler.jsonc` vars.

The Worker verifies the `Cf-Access-Jwt-Assertion` JWT on every `/admin/*`
request (defense in depth; `workers_dev` is disabled so the Access-fronted
custom domain is the only way in). While `ACCESS_TEAM` is unset, `/admin/*`
returns 503. For local dev, where no Access edge exists, put
`ACCESS_DEV_BYPASS=1` in `.dev.vars`.

## Layout

- `src/index.ts` — Hono app entrypoint
- `wrangler.jsonc` — Worker / routing config
- `tsconfig.json` — TypeScript config (Hono JSX preconfigured)
