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
`enumeration-manifest/<slug>.json` in the bucket, so public pages read one
object instead of paging through tens of thousands of chunk keys. Index-like
fields in the manifest (`firstIdx`, `lastIdx`, `count`, `totalMatroids`,
`lineLen`) are native JSON integers; counts top out in the tens of trillions,
well below `Number.MAX_SAFE_INTEGER`, and manifest generation fails loudly if
a value ever leaves the safe-integer range.

Manifests are regenerated from the admin page at `/admin` (click the button
after uploading a batch of chunks). An enumeration is published once its
manifest exists: the home page links to it and its pages render; without a
manifest, its pages 404.

## Admin auth (Cloudflare Access)

`/admin/*` is protected by the Cloudflare Access application configured via
the `ACCESS_TEAM` / `ACCESS_AUD` vars in `wrangler.jsonc`; the Worker verifies
the `Cf-Access-Jwt-Assertion` JWT on every request. For local dev, where no
Access edge exists, put `ACCESS_DEV_BYPASS=1` in `.dev.vars`.

## Layout

- `src/index.ts` — Hono app entrypoint
- `wrangler.jsonc` — Worker / routing config
- `tsconfig.json` — TypeScript config (Hono JSX preconfigured)
