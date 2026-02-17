# Trailerio Lite

Minimal trailer resolver on Cloudflare Workers. Zero storage, globally distributed.

## Features

- **Edge deployed** - Runs on 300+ Cloudflare locations
- **Zero storage** - Uses Workers Cache API
- **Instant scaling** - Handles millions of requests
- **Free tier** - 100k requests/day free

## Source Priority

1. **Apple TV** - 4K HDR/HLS
2. **Plex** - 1080p IVA CDN
3. **Rotten Tomatoes** - 1080p Fandango CDN
4. **Digital Digest** - 4K PeerTube
5. **IMDb** - 1080p fallback

## Quick Start

```bash
# Install dependencies
npm install

# Local development
npm run dev

# Deploy to Cloudflare
npm run deploy
```

## API

| Endpoint | Description |
|----------|-------------|
| `GET /manifest.json` | Stremio manifest |
| `GET /stream/movie/{imdbId}.json` | Get trailer stream |
| `GET /stream/series/{imdbId}.json` | Get trailer stream |
| `GET /health` | Health check |

## Stremio Installation

Add this URL to Stremio:
```
https://your-worker.workers.dev/manifest.json
```

## Cost

Cloudflare Workers Free Tier:
- 100,000 requests/day
- 10ms CPU time per request

For 30k+ users, upgrade to Workers Paid ($5/mo):
- 10 million requests/month included
- Unlimited thereafter at $0.50/million

## Architecture

```
User Request
     ↓
Cloudflare Edge (nearest POP)
     ↓
Check Cache → Hit? → Return cached
     ↓ Miss
Resolve (Apple TV → Plex → RT → DD → IMDb)
     ↓
Cache result (24h TTL)
     ↓
Return stream
```

## License

MIT
