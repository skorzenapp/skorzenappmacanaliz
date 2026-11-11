'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const ROOT = __dirname;
// Load a local .env file without adding a runtime dependency. Existing process env wins.
try {
  const envText = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
  for (const line of envText.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} catch {}
const PORT = Number(process.env.PORT || 3000);
const SPORTMONKS_TOKEN = process.env.SPORTMONKS_API_TOKEN || '';
const CACHE = new Map();
const CACHE_TTL = 60_000;
const UPSTREAM_TIMEOUT_MS = 12_000;
const SPORTScore = 'https://sportscore.com';
const APP_VERSION = '1.2.0';

function json(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(JSON.stringify(data));
}
function fail(res, status, code, message, extra = {}) {
  return json(res, status, { error: code, message, ...extra });
}
function cacheRead(key) {
  const item = CACHE.get(key);
  if (!item) return null;
  if (Date.now() - item.at > CACHE_TTL) { CACHE.delete(key); return null; }
  return item.value;
}
function cacheWrite(key, value) {
  if (CACHE.size > 500) CACHE.delete(CACHE.keys().next().value);
  CACHE.set(key, { at: Date.now(), value });
}

async function getJson(url, cacheKey = url.toString()) {
  const cached = cacheRead(cacheKey);
  if (cached) return cached;
  const response = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'SKORZEN-Football-App/0.9' },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
  });
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : {}; }
  catch { throw Object.assign(new Error('Veri sağlayıcısı geçerli JSON döndürmedi.'), { status: 502, code: 'INVALID_UPSTREAM_JSON' }); }
  if (!response.ok) {
    throw Object.assign(new Error(data?.message || `Veri sağlayıcısı HTTP ${response.status} yanıtı verdi.`), {
      status: response.status === 429 ? 429 : 502,
      code: response.status === 429 ? 'UPSTREAM_RATE_LIMIT' : 'UPSTREAM_ERROR'
    });
  }
  cacheWrite(cacheKey, data);
  return data;
}

function sportScoreUrl(endpoint, params = {}) {
  const url = new URL(`${SPORTScore}${endpoint}`);
  url.searchParams.set('src', 'skorzen');
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && String(value).trim() !== '') url.searchParams.set(key, String(value));
  }
  return url;
}



// Compatibility adapter: the original Maç Analiz UI expects ESPN-shaped routes.
// SportScore is the licensed/attribution-based provider used by this package.
const LEAGUE_MAP = {
  'tur.1':'super-lig', 'eng.1':'premier-league', 'eng.2':'championship',
  'esp.1':'la-liga', 'esp.2':'segunda-division', 'ita.1':'serie-a',
  'ita.2':'serie-b', 'ger.1':'bundesliga', 'ger.2':'2-bundesliga',
  'fra.1':'ligue-1', 'fra.2':'ligue-2', 'ned.1':'eredivisie',
  'ned.2':'eerste-divisie', 'por.1':'primeira-liga', 'bel.1':'pro-league',
  'aut.1':'austrian-bundesliga', 'sui.1':'swiss-super-league',
  'swe.1':'allsvenskan', 'ksa.1':'saudi-pro-league', 'bra.1':'serie-a-brazil',
  'arg.1':'liga-profesional-argentina', 'col.1':'primera-a-colombia',
  'mex.1':'liga-mx', 'usa.1':'mls', 'aus.1':'a-league'
};
const slugify = s => String(s || '').normalize('NFKD').replace(/[\u0300-\u036f]/g,'')
  .toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
function unwrapArray(payload) {
  if (Array.isArray(payload)) return payload;
  for (const k of ['fixtures','matches','events','data','results']) {
    if (Array.isArray(payload?.[k])) return payload[k];
    if (Array.isArray(payload?.data?.[k])) return payload.data[k];
  }
  return [];
}
function scoreNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v); return Number.isFinite(n) ? n : null;
}
function normalizeFixture(x, leagueSlug) {
  const homeName = x.home || x.home_team || x.home_name || x.homeTeam?.name || 'Ev sahibi';
  const awayName = x.away || x.away_team || x.away_name || x.awayTeam?.name || 'Deplasman';
  const slug = x.slug || x.match_slug || x.url_slug || `${slugify(homeName)}-vs-${slugify(awayName)}`;
  const statusRaw = String(x.status || x.state || '').toLowerCase();
  const state = /live|in.?play|1h|2h|half|ht|extra|pen/.test(statusRaw) ? 'in' :
    /finished|complete|full.?time|ft|ended|post/.test(statusRaw) ? 'post' : 'pre';
  const homeScore = scoreNum(x.home_score ?? x.homeScore);
  const awayScore = scoreNum(x.away_score ?? x.awayScore);
  const time = x.time || x.kickoff || x.datetime || x.date || null;
  return {
    id: slug, slug, league: leagueSlug || slugify(x.competition || x.league || 'football'),
    name: x.status_text || x.statusText || x.status || '',
    date: time, dateUtc: time, generatedAt: new Date().toISOString(),
    home: { id: slugify(x.home_slug || homeName), name: homeName, short: homeName, logo: x.home_logo || x.homeLogo || null, score: homeScore },
    away: { id: slugify(x.away_slug || awayName), name: awayName, short: awayName, logo: x.away_logo || x.awayLogo || null, score: awayScore },
    status: { state, completed: state === 'post', clock: x.minute || x.clock || x.status_text || null },
    competition: x.competition || x.league || null,
    source: 'SportScore'
  };
}
async function sportScoreFixtures(date, league) {
  const params = { sport:'football', date, limit:200 };
  if (league && league !== 'all' && LEAGUE_MAP[league]) params.competition = LEAGUE_MAP[league];
  const data = await getJson(sportScoreUrl('/api/v1/fixtures/', params), `sportscore:fixtures:${date}:${params.competition || 'all'}`);
  return unwrapArray(data).map(x => normalizeFixture(x, league === 'all' ? null : league));
}

function normName(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

async function getSportmonksFallback(playerName, teamName) {
  if (!SPORTMONKS_TOKEN || !playerName) return null;
  const searchUrl = new URL(`https://api.sportmonks.com/v3/football/players/search/${encodeURIComponent(playerName)}`);
  searchUrl.searchParams.set('api_token', SPORTMONKS_TOKEN);
  const search = await getJson(searchUrl, `sportmonks:player-search:${normName(playerName)}`);
  const candidates = Array.isArray(search.data) ? search.data : [];
  const exact = candidates.filter(x => normName(x.display_name || x.name || `${x.firstname || ''} ${x.lastname || ''}`) === normName(playerName));
  if (exact.length !== 1 || !exact[0].id) return null;

  const playerUrl = new URL(`https://api.sportmonks.com/v3/football/players/${exact[0].id}`);
  playerUrl.searchParams.set('api_token', SPORTMONKS_TOKEN);
  playerUrl.searchParams.set('include', 'statistics.details.type;statistics.team');
  playerUrl.searchParams.set('filters', 'currentSeasons:playerStatistic');
  const profile = await getJson(playerUrl, `sportmonks:player:${exact[0].id}`);
  const smPlayer = profile.data || {};
  const seasons = Array.isArray(smPlayer.statistics) ? smPlayer.statistics : [];
  if (!seasons.length) return null;
  const season = seasons.find(x => x.team?.name && teamName && normName(x.team.name) === normName(teamName)) || seasons[0];
  if (teamName && season.team?.name && normName(season.team.name) !== normName(teamName)) return null;

  const aliases = {
    appearances: ['appearances', 'matches', 'matches-played'], minutes: ['minutes-played', 'minutes'],
    goals: ['goals'], assists: ['assists'], shots: ['shots', 'shots-total', 'total-shots'],
    shots_on_target: ['shots-on-target'], passes: ['passes', 'passes-total'],
    passes_accuracy: ['passes-accurate', 'accurate-passes'], key_passes: ['key-passes'],
    dribbles: ['dribbles', 'successful-dribbles'], tackles: ['tackles'],
    interceptions: ['interceptions'], clearances: ['clearances'],
    yellow_cards: ['yellowcards', 'yellow-cards'], red_cards: ['redcards', 'red-cards']
  };
  const found = {};
  for (const detail of (season.details || [])) {
    const code = String(detail.type?.code || detail.type?.name || '').toLowerCase().replace(/_/g, '-');
    const value = detail.value && typeof detail.value === 'object' ? (detail.value.total ?? detail.value.count ?? detail.value.value) : detail.value;
    if (value === null || value === undefined || !Number.isFinite(Number(value))) continue;
    for (const [key, names] of Object.entries(aliases)) if (names.includes(code)) found[key] = Number(value);
  }
  return Object.keys(found).length ? { stats: found, player: smPlayer, source: 'Sportmonks' } : null;
}

function sendStatic(req, res, pathname) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); }
  catch { return fail(res, 400, 'BAD_PATH', 'Geçersiz adres.'); }
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const file = path.resolve(ROOT, relative);
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) return fail(res, 403, 'FORBIDDEN', 'Erişim reddedildi.');
  fs.readFile(file, (err, bytes) => {
    if (err) return fail(res, 404, 'NOT_FOUND', 'Dosya bulunamadı.');
    const ext = path.extname(file).toLowerCase();
    const types = {
      '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon', '.webp': 'image/webp', '.woff': 'font/woff', '.woff2': 'font/woff2'
    };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' });
    res.end(bytes);
  });
}

async function handleApi(req, res, url) {
  const p = url.pathname;
  if (p === '/api/health') {
    return json(res, 200, {
      app: 'Maç Analiz', version: APP_VERSION, status: 'online',
      providers: {
        sportscore: { enabled: true, apiKeyRequired: false, freeTier: true, attributionRequired: true, dailyApproximateLimit: 10000, commercialEarlyStageWithBadge: true },
        espn: { enabled: false, reason: 'This build uses SportScore instead of ESPN.' },
        sportmonks: { enabled: Boolean(SPORTMONKS_TOKEN), apiKeyRequired: true, role: 'optional-fallback' },
        compatibility: { fixtures: true, search: true, matchDetails: false, predictions: false, note: 'Detailed match statistics and Poisson prediction routes require a field-mapping pass against provider payloads.' }
      },
      timestamp: new Date().toISOString()
    });
  }

  try {
    if (p === '/api/providers') {
      return json(res, 200, {
        primary: 'sportscore', fallback: SPORTMONKS_TOKEN ? ['sportmonks'] : [],
        disabled: ['espn-unlicensed'],
        notes: ['SportScore free API requires a visible dofollow attribution link on every data-bearing screen.', 'Early-stage commercial use is allowed with attribution under the API-specific terms.', 'Bulk raw-data redistribution and competing-feed mirroring are prohibited.', 'Player detail availability and stat coverage are provider-dependent.']
      });
    }

    const fixtureMatch = p.match(/^\/api\/matches\/(\d{8})\/([^/]+)$/);
    if (fixtureMatch) {
      const [, compactDate, league] = fixtureMatch;
      const date = `${compactDate.slice(0,4)}-${compactDate.slice(4,6)}-${compactDate.slice(6,8)}`;
      const events = await sportScoreFixtures(date, league);
      return json(res, 200, { events, errors:[], source:'SportScore', generatedAt:new Date().toISOString(), attribution:'https://sportscore.com/' });
    }
    if (p === '/api/search') {
      const q = (url.searchParams.get('q') || '').trim();
      if (q.length < 2) return json(res, 200, []);
      const data = await getJson(sportScoreUrl('/api/v1/search/', { q, sport:'football', limit:20 }), `sportscore:search:${q.toLowerCase()}`);
      const rows = unwrapArray(data);
      return json(res, 200, rows.map(x => ({
        id:x.id || x.slug, name:x.name || x.title || x.display_name,
        league:x.competition_slug || x.league_slug || 'eng.1',
        teamId:x.team_slug || x.team?.slug || slugify(x.team || ''),
        slug:x.slug, type:x.type || 'player'
      })));
    }

    if (p === '/api/sportscore/search') {
      const q = (url.searchParams.get('q') || '').trim();
      if (q.length < 2) return fail(res, 400, 'QUERY_TOO_SHORT', 'Arama için en az iki karakter gir.');
      const upstream = sportScoreUrl('/api/v1/search/', { q, sport: 'football', limit: 20 });
      const data = await getJson(upstream, `sportscore:search:${q.toLowerCase()}`);
      return json(res, 200, data);
    }
    if (p === '/api/sportscore/matches') {
      const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit') || 20)));
      const data = await getJson(sportScoreUrl('/api/widget/matches/', { sport: 'football', limit }));
      return json(res, 200, data);
    }
    if (p === '/api/sportscore/fixtures') {
      const date = url.searchParams.get('date') || new Date().toISOString().slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) return fail(res, 400, 'INVALID_DATE', 'Tarih YYYY-AA-GG biçiminde olmalı.');
      const status = url.searchParams.get('status') || '';
      if (status && !['live', 'finished', 'upcoming'].includes(status)) return fail(res, 400, 'INVALID_STATUS', 'Durum live, finished veya upcoming olmalı.');
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') || 100)));
      const data = await getJson(sportScoreUrl('/api/v1/fixtures/', { sport: 'football', date, status, competition: url.searchParams.get('competition'), team: url.searchParams.get('team'), limit }));
      return json(res, 200, data);
    }
    if (p === '/api/sportscore/team') {
      const slug = (url.searchParams.get('slug') || '').trim();
      if (!slug || !/^[a-zA-Z0-9-]+$/.test(slug)) return fail(res, 400, 'INVALID_TEAM_SLUG', 'Takım adresi geçersiz.');
      const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit') || 20)));
      const data = await getJson(sportScoreUrl('/api/widget/team/', { sport: 'football', slug, limit }));
      return json(res, 200, data);
    }
    if (p === '/api/sportscore/h2h') {
      const team1 = (url.searchParams.get('team1') || '').trim();
      const team2 = (url.searchParams.get('team2') || '').trim();
      if (![team1, team2].every(x => /^[a-zA-Z0-9-]+$/.test(x)) || team1 === team2) return fail(res, 400, 'INVALID_TEAMS', 'İki farklı ve geçerli takım adresi gerekli.');
      const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit') || 20)));
      const data = await getJson(sportScoreUrl('/api/v1/h2h/', { sport: 'football', team1, team2, limit }));
      return json(res, 200, data);
    }
    if (p === '/api/sportscore/match') {
      const slug = (url.searchParams.get('slug') || '').trim();
      if (!slug) return fail(res, 400, 'SLUG_REQUIRED', 'Maç adresi bulunamadı.');
      const data = await getJson(sportScoreUrl('/api/widget/match/', { sport: 'football', slug }));
      return json(res, 200, data);
    }
    if (p === '/api/sportscore/player') {
      const slug = (url.searchParams.get('slug') || '').trim();
      if (!slug || slug.length > 180 || !/^[a-zA-Z0-9-]+$/.test(slug)) return fail(res, 400, 'INVALID_PLAYER_SLUG', 'Oyuncu adresi geçersiz.');
      const data = JSON.parse(JSON.stringify(await getJson(sportScoreUrl('/api/widget/player/', { sport: 'football', slug }))));
      const player = data.player || data.data?.player || {};
      const stats = data.stats || data.data?.stats || {};
      const playerName = player.name || player.display_name || '';
      const teamName = stats.team || player.team?.name || '';
      let fallback = null;
      const wanted = ['shots', 'shots_on_target', 'passes', 'passes_accuracy', 'key_passes', 'dribbles', 'tackles', 'interceptions', 'clearances'];
      const missing = wanted.some(key => stats[key] === undefined || stats[key] === null);
      if (missing && SPORTMONKS_TOKEN && playerName) {
        try { fallback = await getSportmonksFallback(playerName, teamName); } catch (e) { console.warn('Sportmonks fallback unavailable:', e.message); }
        if (fallback) {
          const addedFields = [];
          for (const [key, value] of Object.entries(fallback.stats)) {
            if (stats[key] === undefined || stats[key] === null) { stats[key] = value; addedFields.push(key); }
          }
          data.stats = stats;
          data._skorzen = { primary: 'SportScore', fallback: addedFields.length ? 'Sportmonks' : null, fallbackFields: addedFields };
        }
      }
      data._skorzen = data._skorzen || { primary: 'SportScore', fallback: null, note: 'Only missing fields are eligible for fallback; player-name and team checks are applied.' };
      return json(res, 200, data);
    }
    if (p === '/api/sportscore/standings' || p === '/api/sportscore/topscorers' || p === '/api/sportscore/bracket') {
      const slug = (url.searchParams.get('slug') || '').trim();
      if (!slug) return fail(res, 400, 'SLUG_REQUIRED', 'Organizasyon adresi bulunamadı.');
      const endpoint = p.endsWith('/standings') ? '/api/widget/standings/' : p.endsWith('/topscorers') ? '/api/widget/topscorers/' : '/api/widget/bracket/';
      const params = { sport: 'football', slug };
      if (endpoint.includes('topscorers')) {
        params.limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit') || 20)));
        params.stat = url.searchParams.get('stat') === 'assists' ? 'assists' : 'goals';
      }
      const data = await getJson(sportScoreUrl(endpoint, params));
      return json(res, 200, data);
    }

    // Compatibility routes consumed by the original Maç Analiz React bundle.
    const standingsMatch = p.match(/^\/api\/standings\/([^/]+)$/);
    if (standingsMatch) {
      const league = standingsMatch[1];
      const slug = LEAGUE_MAP[league] || league;
      const raw = await getJson(sportScoreUrl('/api/widget/standings/', { sport:'football', slug }), `sportscore:standings:${slug}`);
      const body = raw.data || raw;
      const rows = body.standings || body.table || body.rows || body.groups || [];
      const groups = Array.isArray(rows) && rows.length && Array.isArray(rows[0]?.rows) ? rows :
        [{ name: body.name || body.competition || slug, rows: Array.isArray(rows) ? rows : [] }];
      return json(res, 200, { ...body, groups, season: body.season || body.season_name || null, source:'SportScore' });
    }

    const matchCompat = p.match(/^\/api\/match\/([^/]+)\/([^/]+)$/);
    if (matchCompat) {
      const [, league, id] = matchCompat;
      const raw = await getJson(sportScoreUrl('/api/widget/match/', { sport:'football', slug:id }), `sportscore:match:${id}`);
      const body = raw.match || raw.data?.match || raw.data || raw;
      const homeRaw = body.home || body.home_team || body.homeTeam || {};
      const awayRaw = body.away || body.away_team || body.awayTeam || {};
      const homeName = typeof homeRaw === 'string' ? homeRaw : homeRaw.name || body.home_name || 'Ev sahibi';
      const awayName = typeof awayRaw === 'string' ? awayRaw : awayRaw.name || body.away_name || 'Deplasman';
      const homeId = slugify(homeRaw.slug || homeRaw.name || homeName);
      const awayId = slugify(awayRaw.slug || awayRaw.name || awayName);
      const detail = {
        ...body, id, league,
        home: { id:homeId, name:homeName, abbr:homeRaw.short_name || homeName.slice(0,3).toUpperCase(), logo:homeRaw.logo || body.home_logo || null, score:scoreNum(body.home_score ?? body.score?.home) },
        away: { id:awayId, name:awayName, abbr:awayRaw.short_name || awayName.slice(0,3).toUpperCase(), logo:awayRaw.logo || body.away_logo || null, score:scoreNum(body.away_score ?? body.score?.away) },
        status: body.status && typeof body.status === 'object' ? body.status : { state:/live|in.?play|1h|2h|half|ht/i.test(String(body.status||''))?'in':/finished|complete|ft|ended/i.test(String(body.status||''))?'post':'pre', completed:/finished|complete|ft|ended/i.test(String(body.status||'')) },
        keyEvents: body.keyEvents || body.events || body.timeline || [],
        rosters: body.rosters || body.lineups || [],
        source:'SportScore'
      };
      return json(res, 200, detail);
    }

    const teamCompat = p.match(/^\/api\/team\/([^/]+)\/([^/]+)$/);
    if (teamCompat) {
      const [, league, teamSlug] = teamCompat;
      const raw = await getJson(sportScoreUrl('/api/widget/team/', { sport:'football', slug:teamSlug, limit:30 }), `sportscore:team:${teamSlug}`);
      return json(res, 200, raw.data || raw);
    }

    const matchPlayersCompat = p.match(/^\/api\/match-players\/([^/]+)\/([^/]+)$/);
    if (matchPlayersCompat) {
      const [, league, matchSlug] = matchPlayersCompat;
      const raw = await getJson(sportScoreUrl('/api/widget/match/', { sport:'football', slug:matchSlug }), `sportscore:match:${matchSlug}`);
      const body = raw.match || raw.data?.match || raw.data || raw;
      return json(res, 200, body.rosters || body.lineups || body.players || { rosters:[] });
    }

    const playerCompat = p.match(/^\/api\/player\/([^/]+)\/([^/]+)$/);
    if (playerCompat) {
      const [, league, playerSlug] = playerCompat;
      const raw = await getJson(sportScoreUrl('/api/widget/player/', { sport:'football', slug:playerSlug }), `sportscore:player:${playerSlug}`);
      return json(res, 200, raw.data || raw);
    }

    const predictCompat = p.match(/^\/api\/predict\/([^/]+)\/([^/]+)$/);
    if (predictCompat) {
      return fail(res, 501, 'PREDICTION_MODEL_NOT_READY',
        'Bu maç için doğrulanmış geçmiş maç verisi henüz eşleştirilmedi. Gerçek veri olmadan tahmin üretilmedi.');
    }

    if (p.startsWith('/api/')) return fail(res, 404, 'API_NOT_FOUND', 'Bu API adresi henüz tanımlı değil.');
  } catch (error) {
    const status = error.status || (error.name === 'TimeoutError' ? 504 : 502);
    return fail(res, status, error.code || 'PROVIDER_UNAVAILABLE', error.name === 'TimeoutError' ? 'Veri sağlayıcısı zamanında yanıt vermedi. Biraz sonra tekrar dene.' : error.message || 'Veri sağlayıcısına ulaşılamadı.');
  }
  return false;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method !== 'GET') return fail(res, 405, 'METHOD_NOT_ALLOWED', 'Yalnızca GET destekleniyor.');
  if (url.pathname.startsWith('/api/')) {
    const handled = await handleApi(req, res, url);
    if (handled !== false) return;
  }
  sendStatic(req, res, url.pathname);
});

server.listen(PORT, () => console.log(`SKORZEN server listening on http://localhost:${PORT}`));
