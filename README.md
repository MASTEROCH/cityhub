# CityHUB

City concierge as a Telegram Mini App. Open and you instantly know **where to go and what to do**.

Live: [https://YOUR-DOMAIN](https://YOUR-DOMAIN) (set after deploy)

## Stack

- **Frontend** — single-file `index.html` (vanilla JS + Leaflet). Static, deployed on Cloudflare Pages.
- **Backend** — `worker/index.js` (Cloudflare Worker). Proxies Claude API + holds the secret + rate-limits per Telegram user.
- **AI** — Claude Haiku 4.5 (cheap, fast). Used by the chat mascot + AI concierge tab.
- **Maps** — Leaflet + CartoDB Dark Matter tiles.
- **TMA** — Telegram WebApp SDK auto-init in `<head>`.

## Architecture

```
Telegram WebApp ──► Cloudflare Pages (static index.html)
                            │
                            ▼ fetch('/api/chat')
                    Cloudflare Worker (cityhub-api)
                            │
                            ▼  uses ANTHROPIC_API_KEY (secret)
                       Anthropic Claude API
```

The API key **never** reaches the browser. Rate-limits live in Workers KV.

## Local dev

```bash
# 1. Frontend — any static server works
python3 -m http.server 8765
# open http://localhost:8765/

# 2. Worker (optional, for testing AI locally)
npx wrangler dev worker/index.js --port 8787
```

The frontend autodetects `localhost` and points to `http://localhost:8787` for the Worker.

## Deploy — first time

### 1. Worker (Cloudflare)

```bash
# Auth (browser opens)
npx wrangler login

# Create the KV namespace for rate-limit counters
npx wrangler kv namespace create RATE_LIMIT
# → copy the returned id into wrangler.toml [[kv_namespaces]] id="..."

# Set the Anthropic key as a secret (paste when prompted, never committed)
npx wrangler secret put ANTHROPIC_API_KEY

# Deploy
npx wrangler deploy
# → returns https://cityhub-api.YOUR-SUBDOMAIN.workers.dev
```

### 2. Frontend (Cloudflare Pages)

```bash
# After git push to GitHub:
# Dashboard → Workers & Pages → Create → Pages → Connect to Git → select cityhub repo
# Build command: (leave empty)
# Output directory: /
# Branch: main
```

Or via CLI:
```bash
npx wrangler pages deploy . --project-name cityhub
```

### 3. Wire frontend to Worker

In `index.html`, search for `YOUR-SUBDOMAIN` and replace with your actual `*.workers.dev` subdomain (or your custom Worker domain).

### 4. Tighten CORS

In `wrangler.toml`, change `ALLOWED_ORIGIN` from `*` to your real frontend domain (e.g. `https://cityhub.app`), then redeploy:
```bash
npx wrangler deploy
```

### 5. Telegram Mini App registration

1. Open BotFather → `/newapp` → pick your bot
2. Title: `CityHUB`
3. Description: `City concierge — где сходить и чем заняться рядом`
4. Photo: a 640×360 cover (use the `app-icon.png` once added)
5. Web App URL: `https://YOUR-DOMAIN`
6. Done.

## Repo layout

```
cityhub/
├── index.html              # main app (single-file)
├── mascot/                 # PNG frames for the AI mascot animation
├── worker/
│   └── index.js            # Cloudflare Worker (API proxy)
├── wrangler.toml           # Worker config
├── README.md
└── .gitignore
```

## Cost expectations

- **Cloudflare Pages + Workers**: $0 up to 100K req/day.
- **Anthropic (Haiku 4.5)**: ~$0.0015 per chat reply.
  - 1000 users × 5 replies/day = $7.50/day = **~$225/month** at scale.
- **Domain**: ~$10/year.

Worker enforces:
- 80 replies/day **per Telegram user** (safety against abuse)
- 8000 replies/day **global cap** (~$12/day max ceiling)

## License

Private project. © 2026 Roman Chernyavsky.
