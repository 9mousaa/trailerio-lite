// Trailerio Lite - Cloudflare Workers Edition
// Zero storage, edge-deployed trailer resolver

const MANIFEST = {
  id: 'io.trailerio.lite',
  version: '1.0.0',
  name: 'Trailerio Lite',
  description: 'Minimal trailer resolver - Apple TV, Plex, RT, Digital Digest, IMDb',
  resources: ['stream'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: []
};

const CACHE_TTL = 86400; // 24 hours

// ============== UTILITIES ==============

async function fetchWithTimeout(url, options = {}, timeout = 8000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(id);
    return res;
  } catch (e) {
    clearTimeout(id);
    throw e;
  }
}

// ============== SOURCE RESOLVERS ==============

// 1. Apple TV - 4K HLS trailers
async function resolveAppleTV(imdbId) {
  try {
    const sparql = `SELECT ?id WHERE { ?item wdt:P345 "${imdbId}" . ?item wdt:P9586 ?id . }`;
    const wdRes = await fetchWithTimeout(
      `https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(sparql)}`,
      { headers: { 'User-Agent': 'TrailerioLite/1.0' } }
    );
    const wdData = await wdRes.json();
    const appleId = wdData.results?.bindings?.[0]?.id?.value;
    if (!appleId) return null;

    const pageRes = await fetchWithTimeout(
      `https://tv.apple.com/us/movie/${appleId}`,
      { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' } }
    );
    const html = await pageRes.text();

    const hlsMatch = html.match(/https:\/\/[^"]*\.m3u8[^"]*/);
    if (hlsMatch) {
      return { url: hlsMatch[0], source: 'Apple TV', quality: '4K' };
    }
  } catch (e) { /* silent fail */ }
  return null;
}

// 2. Plex - IVA CDN 1080p
async function resolvePlex(imdbId) {
  try {
    const tokenRes = await fetchWithTimeout('https://plex.tv/api/v2/users/anonymous', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'X-Plex-Client-Identifier': 'trailerio-lite',
        'X-Plex-Product': 'Plex Web',
        'X-Plex-Version': '4.141.1'
      }
    });
    const { authToken } = await tokenRes.json();
    if (!authToken) return null;

    const matchRes = await fetchWithTimeout(
      `https://metadata.provider.plex.tv/library/metadata/matches?type=1&guid=imdb://${imdbId}`,
      { headers: { 'Accept': 'application/json', 'X-Plex-Token': authToken } }
    );
    const matchData = await matchRes.json();
    const plexId = matchData.MediaContainer?.Metadata?.[0]?.ratingKey;
    if (!plexId) return null;

    const extrasRes = await fetchWithTimeout(
      `https://metadata.provider.plex.tv/library/metadata/${plexId}/extras`,
      { headers: { 'Accept': 'application/json', 'X-Plex-Token': authToken } }
    );
    const extrasData = await extrasRes.json();
    const trailer = extrasData.MediaContainer?.Metadata?.find(m => m.subtype === 'trailer');
    const url = trailer?.Media?.[0]?.url;

    if (url) {
      return { url, source: 'Plex', quality: '1080p' };
    }
  } catch (e) { /* silent fail */ }
  return null;
}

// 3. Rotten Tomatoes - Fandango CDN
async function resolveRottenTomatoes(imdbId) {
  try {
    const sparql = `SELECT ?id WHERE { ?item wdt:P345 "${imdbId}" . ?item wdt:P1258 ?id . }`;
    const wdRes = await fetchWithTimeout(
      `https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(sparql)}`,
      { headers: { 'User-Agent': 'TrailerioLite/1.0' } }
    );
    const wdData = await wdRes.json();
    let rtSlug = wdData.results?.bindings?.[0]?.id?.value;
    if (!rtSlug) return null;

    const pathMatch = rtSlug.match(/((?:m|tv)\/.+)/);
    if (pathMatch) rtSlug = pathMatch[1];

    const pageRes = await fetchWithTimeout(
      `https://www.rottentomatoes.com/${rtSlug}/`,
      { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } }
    );
    const html = await pageRes.text();

    const urlMatch = html.match(/https:\/\/link\.theplatform\.com\/s\/[^"]+/);
    if (urlMatch) {
      const url = urlMatch[0].replace(/formats=[^&]+/, 'formats=MPEG4') + '&format=redirect';
      return { url, source: 'Rotten Tomatoes', quality: '1080p' };
    }
  } catch (e) { /* silent fail */ }
  return null;
}

// 4. Digital Digest - PeerTube 4K
async function resolveDigitalDigest(imdbId) {
  try {
    const searchRes = await fetchWithTimeout(
      `https://trailers.digitaldigest.com/api/v1/search/videos?search=${imdbId}&count=5`,
      { headers: { 'Accept': 'application/json' } }
    );
    const searchData = await searchRes.json();
    const video = searchData.data?.[0];
    if (!video) return null;

    const videoRes = await fetchWithTimeout(
      `https://trailers.digitaldigest.com/api/v1/videos/${video.uuid}`,
      { headers: { 'Accept': 'application/json' } }
    );
    const videoData = await videoRes.json();

    const files = videoData.files || videoData.streamingPlaylists?.[0]?.files || [];
    const best = files.sort((a, b) => (b.resolution?.id || 0) - (a.resolution?.id || 0))[0];

    if (best?.fileUrl || best?.fileDownloadUrl) {
      return {
        url: best.fileUrl || best.fileDownloadUrl,
        source: 'Digital Digest',
        quality: best.resolution?.label || '1080p'
      };
    }
  } catch (e) { /* silent fail */ }
  return null;
}

// 5. IMDb - Fallback
async function resolveIMDb(imdbId) {
  try {
    const pageRes = await fetchWithTimeout(
      `https://www.imdb.com/title/${imdbId}/`,
      { headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept-Language': 'en-US,en'
      }}
    );
    const html = await pageRes.text();

    const videoMatch = html.match(/\/video\/(vi\d+)/);
    if (!videoMatch) return null;

    const videoRes = await fetchWithTimeout(
      `https://www.imdb.com/video/${videoMatch[1]}/`,
      { headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept-Language': 'en-US,en'
      }}
    );
    const videoHtml = await videoRes.text();

    const urlMatch = videoHtml.match(/"url":"(https:\/\/imdb-video\.media-imdb\.com[^"]+\.mp4[^"]*)"/);
    if (urlMatch) {
      return { url: urlMatch[1].replace(/\\u0026/g, '&'), source: 'IMDb', quality: '1080p' };
    }
  } catch (e) { /* silent fail */ }
  return null;
}

// ============== MAIN RESOLVER ==============

async function resolveTrailer(imdbId, cache) {
  // Check cache first
  const cacheKey = `trailer:${imdbId}`;
  const cached = await cache.match(new Request(`https://cache/${cacheKey}`));
  if (cached) {
    return await cached.json();
  }

  // Try sources in priority order
  const sources = [
    resolveAppleTV,
    resolvePlex,
    resolveRottenTomatoes,
    resolveDigitalDigest,
    resolveIMDb
  ];

  for (const resolver of sources) {
    const result = await resolver(imdbId);
    if (result) {
      // Cache result
      const response = new Response(JSON.stringify(result), {
        headers: { 'Cache-Control': `max-age=${CACHE_TTL}` }
      });
      await cache.put(new Request(`https://cache/${cacheKey}`), response.clone());
      return result;
    }
  }

  return null;
}

// ============== REQUEST HANDLER ==============

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cache = caches.default;

    // CORS headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Content-Type': 'application/json'
    };

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // Routes
    if (url.pathname === '/manifest.json') {
      return new Response(JSON.stringify(MANIFEST), { headers: corsHeaders });
    }

    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok', edge: request.cf?.colo }), { headers: corsHeaders });
    }

    // Stream endpoint: /stream/{type}/{id}.json
    const streamMatch = url.pathname.match(/^\/stream\/(movie|series)\/(.+)\.json$/);
    if (streamMatch) {
      const [, type, id] = streamMatch;
      const imdbId = id.split(':')[0];

      const trailer = await resolveTrailer(imdbId, cache);

      if (trailer) {
        return new Response(JSON.stringify({
          streams: [{
            url: trailer.url,
            title: `Trailer (${trailer.source})`,
            name: `${trailer.quality} ${trailer.source}`
          }]
        }), { headers: corsHeaders });
      }

      return new Response(JSON.stringify({ streams: [] }), { headers: corsHeaders });
    }

    // 404
    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: corsHeaders
    });
  }
};
