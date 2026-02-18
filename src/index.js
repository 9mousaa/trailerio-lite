// Trailerio Lite - Cloudflare Workers Edition
// Zero storage, edge-deployed trailer resolver for Fusion

const MANIFEST = {
  id: 'io.trailerio.lite',
  version: '1.0.0',
  name: 'Trailerio',
  description: 'Trailer addon - Apple TV, Plex, RT, Digital Digest, IMDb',
  logo: 'https://raw.githubusercontent.com/9mousaa/trailerio-lite/main/icon.png',
  resources: [
    {
      name: 'meta',
      types: ['movie', 'series'],
      idPrefixes: ['tt']
    }
  ],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: []
};

const CACHE_TTL = 86400; // 24 hours
const TMDB_API_KEY = 'bfe73358661a995b992ae9a812aa0d2f';

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

// ============== TMDB METADATA ==============

async function getTMDBMetadata(imdbId, type = 'movie') {
  try {
    const findRes = await fetchWithTimeout(
      `https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id`
    );
    const findData = await findRes.json();

    const results = type === 'series'
      ? findData.tv_results
      : findData.movie_results;

    if (!results || results.length === 0) return null;

    const tmdbId = results[0].id;
    const title = results[0].title || results[0].name;

    // Get external IDs including Wikidata
    const extRes = await fetchWithTimeout(
      `https://api.themoviedb.org/3/${type === 'series' ? 'tv' : 'movie'}/${tmdbId}/external_ids?api_key=${TMDB_API_KEY}`
    );
    const extData = await extRes.json();

    return {
      tmdbId,
      title,
      wikidataId: extData.wikidata_id,
      imdbId
    };
  } catch (e) {
    return null;
  }
}

// Get Apple TV / RT IDs from Wikidata entity
async function getWikidataIds(wikidataId) {
  if (!wikidataId) return {};

  try {
    const res = await fetchWithTimeout(
      `https://www.wikidata.org/wiki/Special:EntityData/${wikidataId}.json`,
      { headers: { 'Accept': 'application/json' } },
      5000
    );
    const data = await res.json();
    const entity = data.entities?.[wikidataId];
    if (!entity) return {};

    return {
      appleTvId: entity.claims?.P9586?.[0]?.mainsnak?.datavalue?.value,
      rtSlug: entity.claims?.P1258?.[0]?.mainsnak?.datavalue?.value
    };
  } catch (e) {
    return {};
  }
}

// ============== SOURCE RESOLVERS ==============

// 1. Apple TV - 4K HLS trailers
async function resolveAppleTV(imdbId, meta) {
  try {
    let appleId = meta?.wikidataIds?.appleTvId;
    if (!appleId) return null;

    const pageRes = await fetchWithTimeout(
      `https://tv.apple.com/us/movie/${appleId}`,
      { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' } }
    );
    const html = await pageRes.text();

    const hlsMatch = html.match(/https:\/\/[^"]*\.m3u8[^"]*/);
    if (hlsMatch) {
      return { url: hlsMatch[0].replace(/&amp;/g, '&'), provider: 'Apple TV 1080p' };
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
      return { url, provider: 'Plex 1080p' };
    }
  } catch (e) { /* silent fail */ }
  return null;
}

// 3. Rotten Tomatoes - Fandango CDN (via SMIL resolution)
async function resolveRottenTomatoes(imdbId, meta) {
  try {
    let rtSlug = meta?.wikidataIds?.rtSlug;
    if (!rtSlug) return null;

    // Handle both "m/slug" and "slug" formats
    const isTV = rtSlug.startsWith('tv/');
    rtSlug = rtSlug.replace(/^(m|tv)\//, '');

    // Go directly to videos page (handle TV vs movie)
    const videosUrl = isTV
      ? `https://www.rottentomatoes.com/tv/${rtSlug}/videos`
      : `https://www.rottentomatoes.com/m/${rtSlug}/videos`;
    const pageRes = await fetchWithTimeout(videosUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    if (!pageRes.ok) return null;

    const html = await pageRes.text();

    // Extract JSON from <script id="videos"> tag
    const scriptMatch = html.match(/<script\s+id="videos"[^>]*>([\s\S]*?)<\/script>/i);
    if (!scriptMatch) return null;

    let videos;
    try {
      videos = JSON.parse(scriptMatch[1]);
    } catch (e) {
      return null;
    }

    if (!Array.isArray(videos) || videos.length === 0) return null;

    // Find trailers
    const trailers = videos.filter(v => v.videoType === 'TRAILER');
    if (trailers.length === 0) return null;

    // Try to resolve via SMIL to get direct fandango.com URL
    for (const trailer of trailers) {
      if (!trailer.file) continue;

      let videoUrl = trailer.file;

      // Resolve theplatform URLs via SMIL
      if (videoUrl.includes('theplatform.com') || videoUrl.includes('link.theplatform')) {
        try {
          const smilUrl = videoUrl.split('?')[0] + '?format=SMIL';
          const smilRes = await fetchWithTimeout(smilUrl, {
            headers: { 'Accept': 'application/smil+xml' }
          }, 5000);

          if (smilRes.ok) {
            const smilXml = await smilRes.text();

            // Extract video URLs with height from SMIL, pick highest quality
            const matches = [...smilXml.matchAll(/src="(https:\/\/video\.fandango\.com[^"]+\.mp4)"[^>]*height="(\d+)"/g)];
            if (matches.length > 0) {
              matches.sort((a, b) => parseInt(b[2]) - parseInt(a[2]));
              const bestUrl = matches[0][1];
              const height = parseInt(matches[0][2]);
              const quality = height >= 1080 ? '1080p' : `${height}p`;
              return { url: bestUrl, provider: `Rotten Tomatoes ${quality}` };
            }
          }
        } catch (e) { /* try next trailer */ }
      }
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
      const quality = best.resolution?.label || '1080p';
      return {
        url: best.fileUrl || best.fileDownloadUrl,
        provider: `Digital Digest ${quality}`
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
      return { url: urlMatch[1].replace(/\\u0026/g, '&'), provider: 'IMDb 1080p' };
    }
  } catch (e) { /* silent fail */ }
  return null;
}

// ============== MAIN RESOLVER ==============

async function resolveTrailers(imdbId, type, cache) {
  const cacheKey = `trailer:v8:${imdbId}`;
  const cached = await cache.match(new Request(`https://cache/${cacheKey}`));
  if (cached) {
    return await cached.json();
  }

  // Step 1: Get TMDB metadata (includes Wikidata ID)
  const tmdbMeta = await getTMDBMetadata(imdbId, type);

  // Step 2: Get Wikidata IDs (Apple TV, RT) if we have a Wikidata ID
  const wikidataIds = tmdbMeta?.wikidataId
    ? await getWikidataIds(tmdbMeta.wikidataId)
    : {};

  const meta = {
    ...tmdbMeta,
    wikidataIds
  };

  // Step 3: Run all resolvers in parallel
  const resolvers = [
    { fn: (id) => resolveAppleTV(id, meta), priority: 0 },
    { fn: (id) => resolvePlex(id), priority: 1 },
    { fn: (id) => resolveRottenTomatoes(id, meta), priority: 2 },
    { fn: (id) => resolveDigitalDigest(id), priority: 3 },
    { fn: (id) => resolveIMDb(id), priority: 4 }
  ];

  const trailerResults = await Promise.all(
    resolvers.map(async ({ fn, priority }) => {
      const result = await fn(imdbId);
      return result ? { ...result, priority } : null;
    })
  );

  // Filter successful results and sort by priority (first = preferred)
  const links = trailerResults
    .filter(r => r !== null)
    .sort((a, b) => a.priority - b.priority)
    .map((r, index) => ({
      trailers: r.url,
      provider: index === 0 ? `⭐ ${r.provider}` : r.provider
    }));

  const result = {
    title: meta?.title || imdbId,
    links: links
  };

  if (links.length > 0) {
    const response = new Response(JSON.stringify(result), {
      headers: { 'Cache-Control': `max-age=${CACHE_TTL}` }
    });
    await cache.put(new Request(`https://cache/${cacheKey}`), response.clone());
  }

  return result;
}

// ============== REQUEST HANDLER ==============

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cache = caches.default;

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Content-Type': 'application/json'
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // Manifest
    if (url.pathname === '/manifest.json') {
      return new Response(JSON.stringify(MANIFEST), { headers: corsHeaders });
    }

    // Health check
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok', edge: request.cf?.colo }), { headers: corsHeaders });
    }

    // Meta endpoint: /meta/{type}/{id}.json
    const metaMatch = url.pathname.match(/^\/meta\/(movie|series)\/(.+)\.json$/);
    if (metaMatch) {
      const [, type, id] = metaMatch;
      const imdbId = id.split(':')[0];

      const result = await resolveTrailers(imdbId, type, cache);

      return new Response(JSON.stringify({
        meta: {
          id: imdbId,
          type: type,
          name: result.title,
          links: result.links
        }
      }), { headers: corsHeaders });
    }

    // 404
    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: corsHeaders
    });
  }
};
