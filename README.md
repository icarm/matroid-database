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

## Layout

- `src/index.ts` — Hono app entrypoint
- `wrangler.jsonc` — Worker / routing config
- `tsconfig.json` — TypeScript config (Hono JSX preconfigured)
