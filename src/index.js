// Trailerio Lite - Cloudflare Workers Edition
// Zero storage, edge-deployed trailer resolver for Fusion

const MANIFEST = {
  id: 'io.trailerio.lite',
  version: '1.2.0',
  name: 'Trailerio',
  description: 'Trailer addon - Fandango, Apple TV, Rotten Tomatoes, Plex, MUBI, AlloCiné, IMDb',
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

const CACHE_TTL = 604800;          // 7 days (final result + Plex movie ID)
const CACHE_TTL_STABLE = 31536000; // 1 year (TMDB + Wikidata — almost never change)
const CACHE_TTL_HOUR = 3600;       // 1 hour (Plex anon token)
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

async function cacheGet(cache, key) {
  const res = await cache.match(new Request(`https://cache/${key}`));
  if (!res) return null;
  try { return await res.json(); } catch { return null; }
}

async function cachePut(cache, key, data, ttl) {
  await cache.put(
    new Request(`https://cache/${key}`),
    new Response(JSON.stringify(data), {
      headers: { 'Cache-Control': `max-age=${ttl}` }
    })
  );
}

// ============== SMIL PARSER ==============

// Parse SMIL XML and return best quality video (highest bitrate, Akamai CDN preferred over origin)
function parseSMIL(smilXml) {
  const videoTags = [...smilXml.matchAll(/<video[^>]+src="(https:\/\/(?:video\.fandango\.com|vs-prodamdfandango\.akamaized\.net)[^"]+\.mp4)"[^>]*/g)];
  const videos = videoTags.map(m => {
    const tag = m[0];
    const widthMatch = tag.match(/width="(\d+)"/);
    const heightMatch = tag.match(/height="(\d+)"/);
    const bitrateMatch = tag.match(/system-bitrate="(\d+)"/);
    const height = heightMatch ? parseInt(heightMatch[1]) : 0;
    const width = widthMatch ? parseInt(widthMatch[1]) : Math.round(height * 16 / 9);
    const isAkamai = m[1].includes('akamaized.net') ? 1 : 0;
    return { url: m[1], width, height, bitrate: bitrateMatch ? Math.round(parseInt(bitrateMatch[1]) / 1000) : 0, isAkamai };
  });
  if (videos.length === 0) return null;
  // Highest bitrate first; for same bitrate, prefer Akamai CDN over fandango.com origin
  videos.sort((a, b) => b.bitrate - a.bitrate || b.isAkamai - a.isAkamai || b.width - a.width);
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
      mubiId: entity.claims?.P7299?.[0]?.mainsnak?.datavalue?.value,
      allocineId: entity.claims?.P1253?.[0]?.mainsnak?.datavalue?.value
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
async function resolvePlex(imdbId, meta, cache) {
  try {
    let authToken;
    const cachedToken = cache ? await cacheGet(cache, 'plex:token:v1') : null;
    if (cachedToken?.authToken) {
      authToken = cachedToken.authToken;
    } else {
      const tokenRes = await fetchWithTimeout('https://plex.tv/api/v2/users/anonymous', {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'X-Plex-Client-Identifier': 'trailerio-lite',
          'X-Plex-Product': 'Plex Web',
          'X-Plex-Version': '4.141.1'
        }
      });
      ({ authToken } = await tokenRes.json());
      if (authToken && cache) await cachePut(cache, 'plex:token:v1', { authToken }, CACHE_TTL_HOUR);
    }
    if (!authToken) return null;

    // type=1 for movies, type=2 for TV shows
    const plexType = meta?.actualType === 'series' ? 2 : 1;

    let plexId;
    const cachedPlexId = cache ? await cacheGet(cache, `plex:id:v1:${imdbId}`) : null;
    if (cachedPlexId?.plexId) {
      plexId = cachedPlexId.plexId;
    } else {
      const matchRes = await fetchWithTimeout(
        `https://metadata.provider.plex.tv/library/metadata/matches?type=${plexType}&guid=imdb://${imdbId}`,
        { headers: { 'Accept': 'application/json', 'X-Plex-Token': authToken } }
      );
      const matchData = await matchRes.json();
      plexId = matchData.MediaContainer?.Metadata?.[0]?.ratingKey;
      if (plexId && cache) await cachePut(cache, `plex:id:v1:${imdbId}`, { plexId }, CACHE_TTL);
    }
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

    // Sort: full trailers first, then teasers — skip non-TRAILER clips entirely
    const junk = /teaser|clip|behind|featurette|sneak peek|opening|sequence/i;
    const priority = v => {
      const t = (v.title || '').toLowerCase();
      if (v.videoType === 'TRAILER' && t.includes('trailer') && !junk.test(t)) return 0;
      if (v.videoType === 'TRAILER' && !junk.test(t)) return 1;
      if (v.videoType === 'TRAILER') return 2;
      return 3;
    };
    videos.sort((a, b) => priority(a) - priority(b));

    // Only attempt SMIL resolution on actual trailers (not clips/BTS)
    const trailerOnly = videos.filter(v => priority(v) < 3);
    if (trailerOnly.length === 0) return null;

    // Try to resolve via SMIL to get direct fandango.com URL
    for (const trailer of trailerOnly) {
      if (!trailer.file) continue;

      // Resolve theplatform URLs via SMIL
      if (trailer.file.includes('theplatform.com') || trailer.file.includes('link.theplatform')) {
        try {
          const smilUrl = trailer.file.split('?')[0] + '?format=SMIL';
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

    // Fallback: return first direct MP4 if SMIL resolution failed
    for (const trailer of trailerOnly) {
      if (trailer.file && !trailer.file.includes('theplatform') && trailer.file.endsWith('.mp4')) {
        return { url: trailer.file, provider: 'Rotten Tomatoes 1080p', bitrate: 5000, width: 1920, height: 1080 };
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

    // Old alphanumeric IDs (e.g. "aa18701") are stale and 404 — skip fast
    if (/[a-zA-Z]/.test(fandangoId)) return null;

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

// 5. MUBI - Film page scrape with MP4 trailers (API consistently returns 422)
async function resolveMUBI(imdbId, meta) {
  try {
    const mubiId = meta?.wikidataIds?.mubiId;
    if (!mubiId) return null;

    // Scrape the film page — it embeds "optimised_trailers":[{url,profile},...] in a <script> tag
    const pageRes = await fetchWithTimeout(
      `https://mubi.com/en/films/${mubiId}`,
      { headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' } }
    );
    if (!pageRes.ok) return null;

    const html = await pageRes.text();
    const match = html.match(/"optimised_trailers":(\[[\s\S]*?\])/);
    if (!match) return null;

    let trailers;
    try { trailers = JSON.parse(match[1]); } catch { return null; }
    if (!Array.isArray(trailers) || trailers.length === 0) return null;

    // Sort by profile (1080p > 720p > 480p > 360p > 240p)
    const profileOrder = { '1080p': 1080, '720p': 720, '480p': 480, '360p': 360, '240p': 240 };
    trailers.sort((a, b) => (profileOrder[b.profile] || 0) - (profileOrder[a.profile] || 0));

    const best = trailers[0];
    const height = profileOrder[best.profile] || 0;
    const width = Math.round(height * 16 / 9);

    return { url: best.url, provider: `MUBI ${best.profile}`, bitrate: 0, width, height };
  } catch (e) { /* silent fail */ }
  return null;
}

// 6. AlloCiné - Direct MP4 via unofficial REST API v3 (~45k Wikidata entries via P1253)
async function resolveAllocine(imdbId, meta) {
  try {
    const allocineId = meta?.wikidataIds?.allocineId;
    if (!allocineId) return null;

    // Step 1: Get movie's trailer list
    const movieRes = await fetchWithTimeout(
      `https://api.allocine.fr/rest/v3/movie?partner=YW5kcm9pZC12Mg&code=${allocineId}&profile=large&filter=trailer&format=json`,
      { headers: { 'User-Agent': 'Dalvik/2.1.0 (Linux; U; Android 11; Build/RQ3A.211001.001)' } }
    );
    if (!movieRes.ok) return null;
    const movieData = await movieRes.json();

    // API returns trailers under feed.movie.trailerList.trailer (primary) or feed.media (fallback)
    const trailerList = movieData?.feed?.movie?.trailerList?.trailer
      || movieData?.feed?.media
      || [];
    if (!Array.isArray(trailerList) || trailerList.length === 0) return null;
    const cmediaId = trailerList[0]?.code ?? trailerList[0]?.['$']?.code;
    if (!cmediaId) return null;

    // Step 2: Get direct MP4 URL
    const mediaRes = await fetchWithTimeout(
      `https://api.allocine.fr/rest/v3/media?partner=YW5kcm9pZC12Mg&code=${cmediaId}&mediafmt=mp4-hip&profile=large&format=json`,
      { headers: { 'User-Agent': 'Dalvik/2.1.0 (Linux; U; Android 11; Build/RQ3A.211001.001)' } }
    );
    if (!mediaRes.ok) return null;
    const mediaData = await mediaRes.json();

    const renditions = mediaData?.feed?.media?.[0]?.rendition;
    if (!Array.isArray(renditions) || renditions.length === 0) return null;

    renditions.sort((a, b) => (b.bandwidth || b['$']?.bandwidth || 0) - (a.bandwidth || a['$']?.bandwidth || 0));
    const best = renditions[0];
    const href = best?.href ?? best?.['$']?.href;
    if (!href || !href.startsWith('http')) return null;

    return { url: href, provider: 'AlloCiné', bitrate: Math.round((best.bandwidth || best['$']?.bandwidth || 0) / 1000), width: 1920, height: 1080 };
  } catch (e) { /* silent fail */ }
  return null;
}

// 7. IMDb - Fallback
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

    // Try to extract quality-labelled variants first (e.g. "1080p", "720p")
    const qualityOrder = { '1080p': 1080, '720p': 720, '480p': 480, '360p': 360, '240p': 240 };
    const variants = [...videoHtml.matchAll(/"displayName":\{"value":"(\d+p)"[^}]*\}[^}]*"url":"(https:\/\/imdb-video\.media-imdb\.com[^"]+\.mp4[^"]*)"/g)];
    if (variants.length > 0) {
      variants.sort((a, b) => (qualityOrder[b[1]] || 0) - (qualityOrder[a[1]] || 0));
      const best = variants[0];
      const height = qualityOrder[best[1]] || 720;
      return { url: best[2].replace(/\\u0026/g, '&'), provider: 'IMDb', bitrate: 0, width: Math.round(height * 16 / 9), height };
    }
    // Fallback: grab first MP4 URL and assume 720p so it ranks above tier=0
    const urlMatch = videoHtml.match(/"url":"(https:\/\/imdb-video\.media-imdb\.com[^"]+\.mp4[^"]*)"/);
    if (urlMatch) {
      return { url: urlMatch[1].replace(/\\u0026/g, '&'), provider: 'IMDb', bitrate: 0, width: 1280, height: 720 };
    }
  } catch (e) { /* silent fail */ }
  return null;
}

// ============== MAIN RESOLVER ==============

async function resolveTrailers(imdbId, type, cache) {
  const cacheKey = `trailer:v30:${imdbId}`;
  const cached = await cache.match(new Request(`https://cache/${cacheKey}`));
  if (cached) {
    return await cached.json();
  }

  // PHASE 1: Start IMDb immediately (needs nothing) + TMDB find in parallel
  const [imdbResult, tmdbMeta] = await Promise.all([
    resolveIMDb(imdbId),
    (async () => {
      const cached = await cacheGet(cache, `tmdb:v1:${imdbId}`);
      if (cached) return cached;
      const fresh = await getTMDBMetadata(imdbId, type);
      if (fresh) await cachePut(cache, `tmdb:v1:${imdbId}`, fresh, CACHE_TTL_STABLE);
      return fresh;
    })()
  ]);

  // PHASE 2: Start Plex (needs actualType) + Wikidata lookup in parallel
  const [plexResult, wikidataIds] = await Promise.all([
    resolvePlex(imdbId, tmdbMeta, cache),
    (async () => {
      if (!tmdbMeta?.wikidataId) return {};
      const cached = await cacheGet(cache, `wikidata:v2:${tmdbMeta.wikidataId}`);
      if (cached) return cached;
      const fresh = await getWikidataIds(tmdbMeta.wikidataId);
      if (fresh) await cachePut(cache, `wikidata:v2:${tmdbMeta.wikidataId}`, fresh, CACHE_TTL_STABLE);
      return fresh || {};
    })()
  ]);

  const meta = { ...tmdbMeta, wikidataIds };

  // PHASE 3: Start Apple TV + RT + Fandango + MUBI + AlloCiné in parallel (need Wikidata IDs)
  const [appleTvResult, rtResult, fandangoResult, mubiResult, allocineResult] = await Promise.all([
    resolveAppleTV(imdbId, meta),
    resolveRottenTomatoes(imdbId, meta),
    resolveFandango(imdbId, meta),
    resolveMUBI(imdbId, meta),
    resolveAllocine(imdbId, meta)
  ]);

  // Quality tier from largest dimension (aspect-ratio agnostic)
  const tier = (w, h) => { const m = Math.max(w, h); return m >= 3840 ? 3 : m >= 1900 ? 2 : m >= 1200 ? 1 : 0; };

  // Sort by quality tier first, then bitrate decides within same tier
  const seen = new Set();
  const links = [fandangoResult, appleTvResult, rtResult, plexResult, mubiResult, allocineResult, imdbResult]
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
