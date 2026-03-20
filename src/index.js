// Trailerio Lite - Cloudflare Workers Edition
// Zero storage, edge-deployed trailer resolver for Fusion

const MANIFEST = {
  id: 'io.trailerio.lite',
  version: '1.2.0',
  name: 'Trailerio',
  description: 'Trailer addon - Fandango, Apple TV, Rotten Tomatoes, Plex, MUBI',
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

// ============== SMIL PARSER ==============

// Parse SMIL XML and return best quality video (highest bitrate)
function parseSMIL(smilXml) {
  const videoTags = [...smilXml.matchAll(/<video[^>]+src="(https:\/\/video\.fandango\.com[^"]+\.mp4)"[^>]*/g)];
  const videos = videoTags.map(m => {
    const tag = m[0];
    const widthMatch = tag.match(/width="(\d+)"/);
    const heightMatch = tag.match(/height="(\d+)"/);
    const bitrateMatch = tag.match(/system-bitrate="(\d+)"/);
    const height = heightMatch ? parseInt(heightMatch[1]) : 0;
    const width = widthMatch ? parseInt(widthMatch[1]) : Math.round(height * 16 / 9);
    return { url: m[1], width, height, bitrate: bitrateMatch ? Math.round(parseInt(bitrateMatch[1]) / 1000) : 0 };
  });
  if (videos.length === 0) return null;
  videos.sort((a, b) => b.bitrate - a.bitrate || b.width - a.width);
  return videos[0];
}

// ============== TMDB METADATA ==============

async function getTMDBMetadata(imdbId, type = 'movie') {
  try {
    const findRes = await fetchWithTimeout(
      `https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id`
    );
    const findData = await findRes.json();

    // Check requested type first, then fallback to other type
    let results = type === 'series'
      ? findData.tv_results
      : findData.movie_results;
    let actualType = type;

    // Fallback: if not found in requested type, check the other
    if (!results || results.length === 0) {
      results = type === 'series'
        ? findData.movie_results
        : findData.tv_results;
      actualType = type === 'series' ? 'movie' : 'series';
    }

    if (!results || results.length === 0) return null;

    const tmdbId = results[0].id;
    const title = results[0].title || results[0].name;

    // Get external IDs including Wikidata
    const extRes = await fetchWithTimeout(
      `https://api.themoviedb.org/3/${actualType === 'series' ? 'tv' : 'movie'}/${tmdbId}/external_ids?api_key=${TMDB_API_KEY}`
    );
    const extData = await extRes.json();

    return {
      tmdbId,
      title,
      wikidataId: extData.wikidata_id,
      imdbId,
      actualType
    };
  } catch (e) {
    return null;
  }
}

// Get Apple TV / RT / Fandango / MUBI IDs from Wikidata entity
async function getWikidataIds(wikidataId) {
  if (!wikidataId) return {};

  try {
    const res = await fetchWithTimeout(
      `https://www.wikidata.org/wiki/Special:EntityData/${wikidataId}.json`,
      { headers: { 'Accept': 'application/json', 'User-Agent': 'TrailerioLite/1.0' } },
      10000
    );
    const data = await res.json();
    const entity = data.entities?.[wikidataId];
    if (!entity) return {};

    // P9586 = Apple TV movie ID, P9751 = Apple TV show ID
    const appleTvMovieId = entity.claims?.P9586?.[0]?.mainsnak?.datavalue?.value;
    const appleTvShowId = entity.claims?.P9751?.[0]?.mainsnak?.datavalue?.value;

    return {
      appleTvId: appleTvMovieId || appleTvShowId,
      isAppleTvShow: !!appleTvShowId && !appleTvMovieId,
      rtSlug: entity.claims?.P1258?.[0]?.mainsnak?.datavalue?.value,
      fandangoId: entity.claims?.P5693?.[0]?.mainsnak?.datavalue?.value,
      mubiId: entity.claims?.P7299?.[0]?.mainsnak?.datavalue?.value
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

    // TV shows use /show/ path, movies use /movie/ path
    const isShow = meta?.wikidataIds?.isAppleTvShow;
    const pageUrl = isShow
      ? `https://tv.apple.com/us/show/${appleId}`
      : `https://tv.apple.com/us/movie/${appleId}`;

    const pageRes = await fetchWithTimeout(
      pageUrl,
      {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
        redirect: 'follow'
      }
    );
    const html = await pageRes.text();

    // Extract all m3u8 URLs, sorted by context preference
    const hlsRaw = [...html.matchAll(/https:\/\/play[^"]*\.m3u8[^"]*/g)];
    const junk = /teaser|clip|behind|featurette|sneak|opening/i;
    const candidates = hlsRaw.map(m => ({
      url: m[0].replace(/&amp;/g, '&'),
      ctx: html.substring(Math.max(0, m.index - 500), m.index).toLowerCase()
    }));
    // Sort: full trailer context first, then any trailer context, then rest
    candidates.sort((a, b) => {
      const score = v => {
        if (v.ctx.includes('trailer') && !junk.test(v.ctx)) return 0;
        if (v.ctx.includes('trailer')) return 1;
        return 2;
      };
      return score(a) - score(b);
    });

    // Try each candidate, use feature.duration from master m3u8 to filter
    // Skip teasers (<60s) and full episodes (>300s)
    for (const candidate of candidates) {
      try {
        const m3u8Res = await fetchWithTimeout(candidate.url, {}, 5000);
        const m3u8Text = await m3u8Res.text();

        // Check duration from master playlist metadata (no extra fetch needed)
        if (candidates.length > 1) {
          const durMatch = m3u8Text.match(/com\.apple\.hls\.feature\.duration.*?VALUE="([\d.]+)"/);
          if (durMatch) {
            const dur = parseFloat(durMatch[1]);
            if (dur < 60 || dur > 300) continue; // Skip teasers and full episodes
          }
        }

        const streamMatches = [...m3u8Text.matchAll(/#EXT-X-STREAM-INF:.*?BANDWIDTH=(\d+)(?:.*?RESOLUTION=(\d+)x(\d+))?/g)];
        if (streamMatches.length === 0) continue;

        streamMatches.sort((a, b) => parseInt(b[1]) - parseInt(a[1]));
        const maxBandwidth = parseInt(streamMatches[0][1]);
        const width = streamMatches[0][2] ? parseInt(streamMatches[0][2]) : 0;
        const height = streamMatches[0][3] ? parseInt(streamMatches[0][3]) : 0;
        const bitrate = Math.round(maxBandwidth / 1000);
        const quality = width >= 3840 ? '4K' : width >= 1900 ? '1080p' : width >= 1200 ? '720p' : '1080p';
        return { url: candidate.url, provider: `Apple TV ${quality}`, bitrate, width, height };
      } catch (e) { continue; }
    }
    // Last resort: return first URL without quality info
    if (candidates.length > 0) {
      return { url: candidates[0].url, provider: 'Apple TV', bitrate: 0, width: 0, height: 0 };
    }
  } catch (e) { /* silent fail */ }
  return null;
}

// 2. Plex - IVA CDN 1080p
async function resolvePlex(imdbId, meta) {
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

    // type=1 for movies, type=2 for TV shows
    const plexType = meta?.actualType === 'series' ? 2 : 1;

    const matchRes = await fetchWithTimeout(
      `https://metadata.provider.plex.tv/library/metadata/matches?type=${plexType}&guid=imdb://${imdbId}`,
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
    const extras = extrasData.MediaContainer?.Metadata || [];
    // Prefer full trailers, fall back to teasers/clips/BTS if no trailer exists
    const trailer = extras.find(m => m.subtype === 'trailer' && !/teaser|clip|behind|featurette/i.test(m.title))
      || extras.find(m => m.subtype === 'trailer')
      || extras[0];
    const url = trailer?.Media?.[0]?.url;

    if (url) {
      const kbrateMatch = url.match(/videokbrate=(\d+)/);
      const bitrate = kbrateMatch ? parseInt(kbrateMatch[1]) : 5000;
      return { url, provider: 'Plex 1080p', bitrate, width: 1920, height: 1080 };
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

    // Sort: full trailers first, then teasers, then clips/BTS as fallback
    const junk = /teaser|clip|behind|featurette|sneak peek|opening|sequence/i;
    const priority = v => {
      const t = (v.title || '').toLowerCase();
      if (v.videoType === 'TRAILER' && t.includes('trailer') && !junk.test(t)) return 0;
      if (v.videoType === 'TRAILER' && !junk.test(t)) return 1;
      if (v.videoType === 'TRAILER') return 2;
      return 3;
    };
    videos.sort((a, b) => priority(a) - priority(b));

    // Try to resolve via SMIL to get direct fandango.com URL
    for (const trailer of videos) {
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
            const best = parseSMIL(smilXml);
            if (best) {
              const quality = best.width >= 1900 ? '1080p' : `${best.height}p`;
              return { url: best.url, provider: `Rotten Tomatoes ${quality}`, bitrate: best.bitrate || 5000, width: best.width, height: best.height };
            }
          }
        } catch (e) { /* try next trailer */ }
      }
    }
  } catch (e) { /* silent fail */ }
  return null;
}

// 4. Fandango - Direct theplatform.com (up to 1080p @ 8Mbps)
async function resolveFandango(imdbId, meta) {
  try {
    const fandangoId = meta?.wikidataIds?.fandangoId;
    if (!fandangoId) return null;

    // Fetch movie overview page (shorthand URL redirects to canonical)
    const pageRes = await fetchWithTimeout(
      `https://www.fandango.com/x-${fandangoId}/movie-overview`,
      {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        redirect: 'follow'
      }
    );
    if (!pageRes.ok) return null;

    const html = await pageRes.text();

    // Extract jwPlayerData JSON from page
    const jwMatch = html.match(/jwPlayerData\s*=\s*(\{[\s\S]*?\});/);
    if (!jwMatch) return null;

    let jwData;
    try {
      jwData = JSON.parse(jwMatch[1]);
    } catch (e) {
      return null;
    }

    const contentURL = jwData.contentURL;
    if (!contentURL || !contentURL.includes('theplatform.com')) return null;

    // Resolve via SMIL for best quality MP4
    const smilUrl = contentURL.split('?')[0] + '?format=SMIL&formats=mpeg4';
    const smilRes = await fetchWithTimeout(smilUrl, {
      headers: { 'Accept': 'application/smil+xml' }
    }, 5000);

    if (!smilRes.ok) return null;

    const smilXml = await smilRes.text();
    const best = parseSMIL(smilXml);
    if (best) {
      const quality = best.width >= 1900 ? '1080p' : `${best.height}p`;
      return { url: best.url, provider: `Fandango ${quality}`, bitrate: best.bitrate || 8000, width: best.width, height: best.height };
    }
  } catch (e) { /* silent fail */ }
  return null;
}

// 5. MUBI - Direct API with MP4 trailers
async function resolveMUBI(imdbId, meta) {
  try {
    const mubiId = meta?.wikidataIds?.mubiId;
    if (!mubiId) return null;

    const res = await fetchWithTimeout(
      `https://api.mubi.com/v3/films/${mubiId}`,
      { headers: { 'CLIENT': 'web', 'CLIENT_COUNTRY': 'US' } }
    );
    if (!res.ok) return null;

    const data = await res.json();

    // Pick highest quality from optimised_trailers
    const trailers = data.optimised_trailers;
    if (!trailers || trailers.length === 0) return null;

    // Sort by profile (1080p > 720p > 240p)
    const profileOrder = { '1080p': 1080, '720p': 720, '480p': 480, '360p': 360, '240p': 240 };
    trailers.sort((a, b) => (profileOrder[b.profile] || 0) - (profileOrder[a.profile] || 0));

    const best = trailers[0];
    const height = profileOrder[best.profile] || 0;
    const width = Math.round(height * 16 / 9);

    return { url: best.url, provider: `MUBI ${best.profile}`, bitrate: 0, width, height };
  } catch (e) { /* silent fail */ }
  return null;
}

// ============== MAIN RESOLVER ==============

async function resolveTrailers(imdbId, type, cache) {
  const cacheKey = `trailer:v28:${imdbId}`;
  const cached = await cache.match(new Request(`https://cache/${cacheKey}`));
  if (cached) {
    return await cached.json();
  }

  // PHASE 1: TMDB metadata lookup
  const tmdbMeta = await getTMDBMetadata(imdbId, type);

  // PHASE 2: Start Plex (needs actualType) + Wikidata lookup in parallel
  const [plexResult, wikidataIds] = await Promise.all([
    resolvePlex(imdbId, tmdbMeta),
    tmdbMeta?.wikidataId ? getWikidataIds(tmdbMeta.wikidataId) : Promise.resolve({})
  ]);

  const meta = { ...tmdbMeta, wikidataIds };

  // PHASE 3: Start Apple TV + RT + Fandango + MUBI in parallel (need Wikidata IDs)
  const [appleTvResult, rtResult, fandangoResult, mubiResult] = await Promise.all([
    resolveAppleTV(imdbId, meta),
    resolveRottenTomatoes(imdbId, meta),
    resolveFandango(imdbId, meta),
    resolveMUBI(imdbId, meta)
  ]);

  // Quality tier from largest dimension (aspect-ratio agnostic)
  const tier = (w, h) => { const m = Math.max(w, h); return m >= 3840 ? 3 : m >= 1900 ? 2 : m >= 1200 ? 1 : 0; };

  // Sort by quality tier first, then bitrate decides within same tier
  const seen = new Set();
  const links = [fandangoResult, appleTvResult, rtResult, plexResult, mubiResult]
    .filter(r => r !== null)
    .sort((a, b) => tier(b.width, b.height) - tier(a.width, a.height) || b.bitrate - a.bitrate)
    .filter(r => {
      if (seen.has(r.url)) return false;
      seen.add(r.url);
      return true;
    })
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
