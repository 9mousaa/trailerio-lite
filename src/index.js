// Trailerio Lite - Cloudflare Workers Edition
// Zero storage, edge-deployed trailer resolver for Fusion

// ============== CONFIG ==============

const DEFAULT_CONFIG = {
  src:  ['fandango', 'appletv', 'rt', 'plex', 'mubi'],
  ct:   'trailer',   // 'trailer' | 'teaser' | 'all'
  max:  5,           // 1 | 3 | 5 | 0=unlimited
  rgn:  'US',        // ISO 3166-1 alpha-2
  sort: 'quality',   // 'quality' | 'source'
};

function parseConfig(segment) {
  if (!segment) return { ...DEFAULT_CONFIG, src: [...DEFAULT_CONFIG.src] };
  try {
    const json = atob(segment.replace(/-/g, '+').replace(/_/g, '/'));
    const partial = JSON.parse(json);
    return { ...DEFAULT_CONFIG, ...partial, src: partial.src || [...DEFAULT_CONFIG.src] };
  } catch {
    return { ...DEFAULT_CONFIG, src: [...DEFAULT_CONFIG.src] };
  }
}

function configCacheKey(cfg) {
  const sparse = {};
  for (const k of Object.keys(DEFAULT_CONFIG).sort()) {
    if (JSON.stringify(cfg[k]) !== JSON.stringify(DEFAULT_CONFIG[k])) sparse[k] = cfg[k];
  }
  return Object.keys(sparse).length ? ':' + JSON.stringify(sparse) : '';
}

function parseRequest(pathname) {
  const m = pathname.match(/^\/([A-Za-z0-9_-]{10,})(\/.*)/);
  if (m) return { segment: m[1], path: m[2] };
  return { segment: null, path: pathname };
}

// ============== MANIFEST ==============

const MANIFEST_BASE = {
  id: 'io.trailerio.lite',
  version: '1.3.0',
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
  catalogs: [],
  behaviorHints: {
    configurable: true,
    configurationRequired: false
  }
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

    let results = type === 'series'
      ? findData.tv_results
      : findData.movie_results;
    let actualType = type;

    if (!results || results.length === 0) {
      results = type === 'series'
        ? findData.movie_results
        : findData.tv_results;
      actualType = type === 'series' ? 'movie' : 'series';
    }

    if (!results || results.length === 0) return null;

    const tmdbId = results[0].id;
    const title = results[0].title || results[0].name;

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
async function resolveAppleTV(imdbId, meta, cfg) {
  try {
    let appleId = meta?.wikidataIds?.appleTvId;
    if (!appleId) return null;

    const rgn = cfg.rgn.toLowerCase();
    const isShow = meta?.wikidataIds?.isAppleTvShow;
    const pageUrl = isShow
      ? `https://tv.apple.com/${rgn}/show/${appleId}`
      : `https://tv.apple.com/${rgn}/movie/${appleId}`;

    const pageRes = await fetchWithTimeout(
      pageUrl,
      {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
        redirect: 'follow'
      }
    );
    const html = await pageRes.text();

    const hlsRaw = [...html.matchAll(/https:\/\/play[^"]*\.m3u8[^"]*/g)];

    // Content-type aware junk filter
    const junkAll    = /teaser|clip|behind|featurette|sneak|opening/i;
    const junkNoTsr  = /clip|behind|featurette|sneak|opening/i;   // allows teasers

    const candidates = hlsRaw.map(m => ({
      url: m[0].replace(/&amp;/g, '&'),
      ctx: html.substring(Math.max(0, m.index - 500), m.index).toLowerCase()
    }));

    candidates.sort((a, b) => {
      const score = v => {
        if (cfg.ct === 'all') return v.ctx.includes('trailer') ? 0 : 1;
        const junk = cfg.ct === 'teaser' ? junkNoTsr : junkAll;
        if (v.ctx.includes('trailer') && !junk.test(v.ctx)) return 0;
        if (v.ctx.includes('trailer')) return 1;
        return 2;
      };
      return score(a) - score(b);
    });

    for (const candidate of candidates) {
      try {
        const m3u8Res = await fetchWithTimeout(candidate.url, {}, 5000);
        const m3u8Text = await m3u8Res.text();

        if (candidates.length > 1) {
          const durMatch = m3u8Text.match(/com\.apple\.hls\.feature\.duration.*?VALUE="([\d.]+)"/);
          if (durMatch) {
            const dur = parseFloat(durMatch[1]);
            if (dur < 60 || dur > 300) continue;
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

    if (candidates.length > 0) {
      return { url: candidates[0].url, provider: 'Apple TV', bitrate: 0, width: 0, height: 0 };
    }
  } catch (e) { /* silent fail */ }
  return null;
}

// 2. Plex - IVA CDN 1080p
async function resolvePlex(imdbId, meta, cfg) {
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

    let trailer;
    if (cfg.ct === 'all') {
      trailer = extras[0];
    } else if (cfg.ct === 'teaser') {
      trailer = extras.find(m => m.subtype === 'trailer' || /teaser/i.test(m.title))
        || extras[0];
    } else {
      // 'trailer' (default)
      trailer = extras.find(m => m.subtype === 'trailer' && !/teaser|clip|behind|featurette/i.test(m.title))
        || extras.find(m => m.subtype === 'trailer')
        || extras[0];
    }

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
async function resolveRottenTomatoes(imdbId, meta, cfg) {
  try {
    let rtSlug = meta?.wikidataIds?.rtSlug;
    if (!rtSlug) return null;

    const isTV = rtSlug.startsWith('tv/');
    rtSlug = rtSlug.replace(/^(m|tv)\//, '');

    const videosUrl = isTV
      ? `https://www.rottentomatoes.com/tv/${rtSlug}/videos`
      : `https://www.rottentomatoes.com/m/${rtSlug}/videos`;
    const pageRes = await fetchWithTimeout(videosUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    if (!pageRes.ok) return null;

    const html = await pageRes.text();
    const scriptMatch = html.match(/<script\s+id="videos"[^>]*>([\s\S]*?)<\/script>/i);
    if (!scriptMatch) return null;

    let videos;
    try {
      videos = JSON.parse(scriptMatch[1]);
    } catch (e) {
      return null;
    }

    if (!Array.isArray(videos) || videos.length === 0) return null;

    const junk = /teaser|clip|behind|featurette|sneak peek|opening|sequence/i;

    const priority = v => {
      const t = (v.title || '').toLowerCase();
      if (cfg.ct === 'all') return 0;
      if (cfg.ct === 'teaser') {
        if (v.videoType === 'TRAILER' && !/clip|behind|featurette|sneak peek|opening|sequence/i.test(t)) return 0;
        if (v.videoType === 'TRAILER') return 1;
        return 2;
      }
      // 'trailer' (default)
      if (v.videoType === 'TRAILER' && t.includes('trailer') && !junk.test(t)) return 0;
      if (v.videoType === 'TRAILER' && !junk.test(t)) return 1;
      if (v.videoType === 'TRAILER') return 2;
      return 3;
    };
    videos.sort((a, b) => priority(a) - priority(b));

    for (const trailer of videos) {
      if (!trailer.file) continue;

      let videoUrl = trailer.file;

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
async function resolveFandango(imdbId, meta, cfg) {
  try {
    const fandangoId = meta?.wikidataIds?.fandangoId;
    if (!fandangoId) return null;

    const pageRes = await fetchWithTimeout(
      `https://www.fandango.com/x-${fandangoId}/movie-overview`,
      {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        redirect: 'follow'
      }
    );
    if (!pageRes.ok) return null;

    const html = await pageRes.text();
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
async function resolveMUBI(imdbId, meta, cfg) {
  try {
    const mubiId = meta?.wikidataIds?.mubiId;
    if (!mubiId) return null;

    const res = await fetchWithTimeout(
      `https://api.mubi.com/v3/films/${mubiId}`,
      { headers: { 'CLIENT': 'web', 'CLIENT_COUNTRY': cfg.rgn } }
    );
    if (!res.ok) return null;

    const data = await res.json();
    const trailers = data.optimised_trailers;
    if (!trailers || trailers.length === 0) return null;

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

async function resolveTrailers(imdbId, type, cfg, cache) {
  const cacheKey = `trailer:v29:${imdbId}${configCacheKey(cfg)}`;
  const cached = await cache.match(new Request(`https://cache/${cacheKey}`));
  if (cached) {
    return await cached.json();
  }

  // PHASE 1: TMDB metadata lookup
  const tmdbMeta = await getTMDBMetadata(imdbId, type);

  const srcSet = new Set(cfg.src);

  // PHASE 2: Plex + Wikidata in parallel
  const [plexResult, wikidataIds] = await Promise.all([
    srcSet.has('plex') ? resolvePlex(imdbId, tmdbMeta, cfg) : Promise.resolve(null),
    tmdbMeta?.wikidataId ? getWikidataIds(tmdbMeta.wikidataId) : Promise.resolve({})
  ]);

  const meta = { ...tmdbMeta, wikidataIds };

  // PHASE 3: Apple TV + RT + Fandango + MUBI in parallel
  const [appleTvResult, rtResult, fandangoResult, mubiResult] = await Promise.all([
    srcSet.has('appletv')  ? resolveAppleTV(imdbId, meta, cfg)         : Promise.resolve(null),
    srcSet.has('rt')       ? resolveRottenTomatoes(imdbId, meta, cfg)  : Promise.resolve(null),
    srcSet.has('fandango') ? resolveFandango(imdbId, meta, cfg)        : Promise.resolve(null),
    srcSet.has('mubi')     ? resolveMUBI(imdbId, meta, cfg)            : Promise.resolve(null)
  ]);

  const tier = (w, h) => { const m = Math.max(w, h); return m >= 3840 ? 3 : m >= 1900 ? 2 : m >= 1200 ? 1 : 0; };

  const providerToSrc = {
    'Fandango': 'fandango',
    'Apple TV': 'appletv',
    'Rotten Tomatoes': 'rt',
    'Plex': 'plex',
    'MUBI': 'mubi'
  };

  const srcRank = (r) => {
    for (const [name, key] of Object.entries(providerToSrc)) {
      if (r.provider.includes(name)) return cfg.src.indexOf(key);
    }
    return 999;
  };

  let results = [fandangoResult, appleTvResult, rtResult, plexResult, mubiResult]
    .filter(r => r !== null);

  if (cfg.sort === 'quality') {
    results.sort((a, b) => tier(b.width, b.height) - tier(a.width, a.height) || b.bitrate - a.bitrate);
  } else {
    results.sort((a, b) => srcRank(a) - srcRank(b));
  }

  const seen = new Set();
  const links = results
    .filter(r => {
      if (seen.has(r.url)) return false;
      seen.add(r.url);
      return true;
    })
    .slice(0, cfg.max === 0 ? Infinity : cfg.max)
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

// ============== CONFIGURE PAGE ==============

function serveConfigurePage(segment) {
  const existingCfg = segment ? (() => {
    try { return JSON.parse(atob(segment.replace(/-/g, '+').replace(/_/g, '/'))); } catch { return {}; }
  })() : {};

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Trailerio — Configure</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0f0f17;color:#e0e0e0;font-family:system-ui,-apple-system,sans-serif;min-height:100vh;padding:2rem 1rem}
.wrap{max-width:560px;margin:0 auto}
h1{font-size:1.6rem;font-weight:700;color:#fff;margin-bottom:.25rem}
.sub{color:#888;font-size:.9rem;margin-bottom:2rem}
.card{background:#1a1a2e;border-radius:12px;padding:1.25rem 1.5rem;margin-bottom:1.25rem}
.card h2{font-size:.8rem;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:#8a5cf7;margin-bottom:1rem}
.sources{display:grid;grid-template-columns:1fr 1fr;gap:.5rem}
label.check,label.radio{display:flex;align-items:center;gap:.5rem;cursor:pointer;padding:.4rem .5rem;border-radius:6px;transition:background .15s}
label.check:hover,label.radio:hover{background:#ffffff0f}
input[type=checkbox],input[type=radio]{accent-color:#8a5cf7;width:16px;height:16px;cursor:pointer}
.row{display:flex;flex-wrap:wrap;gap:.5rem}
select{background:#0f0f17;color:#e0e0e0;border:1px solid #333;border-radius:6px;padding:.45rem .75rem;font-size:.9rem;cursor:pointer;width:100%}
select:focus{outline:none;border-color:#8a5cf7}
.note{font-size:.78rem;color:#666;margin-top:.5rem}
.btn{width:100%;padding:.75rem;border:none;border-radius:8px;font-size:1rem;font-weight:600;cursor:pointer;margin-top:.5rem;transition:opacity .15s}
.btn-primary{background:#8a5cf7;color:#fff}
.btn-primary:hover{opacity:.85}
.btn-secondary{background:#1a1a2e;color:#8a5cf7;border:1px solid #8a5cf7}
.btn-secondary:hover{opacity:.75}
.result{display:none;margin-top:1.5rem}
.result.show{display:block}
.url-box{background:#0f0f17;border:1px solid #333;border-radius:8px;padding:1rem;font-size:.8rem;word-break:break-all;color:#aaa;margin-bottom:.75rem}
</style>
</head>
<body>
<div class="wrap">
  <h1>Trailerio</h1>
  <p class="sub">Customize your trailer sources and preferences</p>

  <div class="card">
    <h2>Sources</h2>
    <div class="sources" id="sources">
      <label class="check"><input type="checkbox" value="fandango"> Fandango</label>
      <label class="check"><input type="checkbox" value="appletv"> Apple TV</label>
      <label class="check"><input type="checkbox" value="rt"> Rotten Tomatoes</label>
      <label class="check"><input type="checkbox" value="plex"> Plex</label>
      <label class="check"><input type="checkbox" value="mubi"> MUBI</label>
    </div>
  </div>

  <div class="card">
    <h2>Content Type</h2>
    <div class="row">
      <label class="radio"><input type="radio" name="ct" value="trailer"> Trailers only</label>
      <label class="radio"><input type="radio" name="ct" value="teaser"> Include teasers</label>
      <label class="radio"><input type="radio" name="ct" value="all"> Include all</label>
    </div>
  </div>

  <div class="card">
    <h2>Max Results</h2>
    <div class="row">
      <label class="radio"><input type="radio" name="max" value="1"> 1 — Best only</label>
      <label class="radio"><input type="radio" name="max" value="3"> 3</label>
      <label class="radio"><input type="radio" name="max" value="5"> 5</label>
      <label class="radio"><input type="radio" name="max" value="0"> All</label>
    </div>
  </div>

  <div class="card">
    <h2>Language / Region</h2>
    <select id="rgn">
      <option value="US">English (US)</option>
      <option value="GB">English (UK)</option>
      <option value="DE">German</option>
      <option value="FR">French</option>
      <option value="ES">Spanish</option>
      <option value="IT">Italian</option>
      <option value="BR">Portuguese (Brazil)</option>
      <option value="JP">Japanese</option>
      <option value="KR">Korean</option>
      <option value="SA">Arabic</option>
    </select>
    <p class="note">Affects Apple TV (dubbed trailers) and MUBI library. Fandango, RT, and Plex always serve English.</p>
  </div>

  <div class="card">
    <h2>Sort Priority</h2>
    <div class="row">
      <label class="radio"><input type="radio" name="sort" value="quality"> Quality first</label>
      <label class="radio"><input type="radio" name="sort" value="source"> Source order</label>
    </div>
  </div>

  <button class="btn btn-primary" onclick="generate()">Generate Install URL</button>

  <div class="result" id="result">
    <div class="url-box" id="urlBox"></div>
    <button class="btn btn-secondary" onclick="copyUrl()">Copy URL</button>
    <button class="btn btn-primary" style="margin-top:.5rem" onclick="installStremio()">Install in Stremio</button>
  </div>
</div>

<script>
const DEFAULTS = {src:['fandango','appletv','rt','plex','mubi'],ct:'trailer',max:5,rgn:'US',sort:'quality'};
const existing = ${JSON.stringify(existingCfg)};

// Pre-populate from existing config
window.addEventListener('DOMContentLoaded', () => {
  const src = existing.src || DEFAULTS.src;
  document.querySelectorAll('#sources input').forEach(cb => {
    cb.checked = src.includes(cb.value);
  });
  const ct = existing.ct || DEFAULTS.ct;
  document.querySelector('input[name=ct][value="'+ct+'"]').checked = true;
  const max = existing.max !== undefined ? existing.max : DEFAULTS.max;
  document.querySelector('input[name=max][value="'+max+'"]').checked = true;
  document.getElementById('rgn').value = existing.rgn || DEFAULTS.rgn;
  const sort = existing.sort || DEFAULTS.sort;
  document.querySelector('input[name=sort][value="'+sort+'"]').checked = true;
});

function generate() {
  const src = [...document.querySelectorAll('#sources input:checked')].map(c => c.value);
  if (src.length === 0) { alert('Select at least one source.'); return; }
  const ct   = document.querySelector('input[name=ct]:checked').value;
  const max  = parseInt(document.querySelector('input[name=max]:checked').value);
  const rgn  = document.getElementById('rgn').value;
  const sort = document.querySelector('input[name=sort]:checked').value;

  const sparse = {};
  if (JSON.stringify(src) !== JSON.stringify(DEFAULTS.src)) sparse.src = src;
  if (ct   !== DEFAULTS.ct)   sparse.ct   = ct;
  if (max  !== DEFAULTS.max)  sparse.max  = max;
  if (rgn  !== DEFAULTS.rgn)  sparse.rgn  = rgn;
  if (sort !== DEFAULTS.sort) sparse.sort = sort;

  const origin = window.location.origin;
  let installUrl;
  if (Object.keys(sparse).length === 0) {
    installUrl = origin + '/manifest.json';
  } else {
    const segment = btoa(JSON.stringify(sparse)).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');
    installUrl = origin + '/' + segment + '/manifest.json';
  }

  document.getElementById('urlBox').textContent = installUrl;
  document.getElementById('result').classList.add('show');
  window._installUrl = installUrl;
}

function copyUrl() {
  navigator.clipboard.writeText(window._installUrl).then(() => {
    const btn = event.target;
    btn.textContent = 'Copied!';
    setTimeout(() => btn.textContent = 'Copy URL', 2000);
  });
}

function installStremio() {
  window.location.href = window._installUrl.replace(/^https?:/, 'stremio:');
}
</script>
</body>
</html>`;

  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
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

    const { segment, path } = parseRequest(url.pathname);
    const cfg = parseConfig(segment);
    const origin = url.origin;
    const prefix = segment ? `/${segment}` : '';

    // Configure page
    if (path === '/configure' || path === '/configure/') {
      return serveConfigurePage(segment);
    }

    // Manifest
    if (path === '/manifest.json') {
      const manifest = {
        ...MANIFEST_BASE,
        configure: `${origin}${prefix}/configure`
      };
      return new Response(JSON.stringify(manifest), { headers: corsHeaders });
    }

    // Health check
    if (path === '/health') {
      return new Response(JSON.stringify({ status: 'ok', edge: request.cf?.colo }), { headers: corsHeaders });
    }

    // Meta endpoint: /meta/{type}/{id}.json
    const metaMatch = path.match(/^\/meta\/(movie|series)\/(.+)\.json$/);
    if (metaMatch) {
      const [, type, id] = metaMatch;
      const imdbId = id.split(':')[0];

      const result = await resolveTrailers(imdbId, type, cfg, cache);

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
