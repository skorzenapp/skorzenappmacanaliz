// Maç Analiz — sunucu. Bağımlılık yok, Node 18+ yeterli.
// Arayüzü (public/) sunar, /api/* isteklerini ESPN açık futbol verisinden üretir.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const PORT = process.env.PORT || 5000;
const PUBLIC = path.join(__dirname, 'public');
const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/soccer';
const ESPN_V2 = 'https://site.api.espn.com/apis/v2/sports/soccer';
const ESPN_SEARCH = 'https://site.web.api.espn.com/apis/common/v3/search';

const LEAGUES = ['tur.1','tur.2','eng.1','eng.2','esp.1','esp.2','ita.1','ita.2','ger.1','ger.2','fra.1','fra.2',
  'ned.1','ned.2','por.1','bel.1','aut.1','sui.1','swe.1','ksa.1','bra.1','arg.1','col.1','mex.1','usa.1','aus.1',
  'kor.1','jpn.1','den.1','nor.1','chn.1','sco.1','chi.1'];
const LEAGUE_OK = new Set(LEAGUES);
const UI_LEAGUES = LEAGUES.slice(0, 27); // arayüzün tanıdığı ligler; 'Tüm ligler'de sadece bunlar

/* ---------- ağ + önbellek ---------- */
const cache = new Map();            // url -> {t, ttl, p}
let active = 0; const queue = [];
const MAX_PAR = 8;
function slot() { return new Promise(res => { if (active < MAX_PAR) { active++; res(); } else queue.push(res); }); }
function release() { const n = queue.shift(); if (n) n(); else active--; }

async function rawFetch(url) {
  if (process.env.ESPN_MOCK) url = url.replace(/^https:\/\/[^/]+/, process.env.ESPN_MOCK);
  for (let attempt = 0; attempt < 2; attempt++) {
    await slot();
    try {
      const ctl = new AbortController();
      const to = setTimeout(() => ctl.abort(), 20000);
      const r = await fetch(url, { signal: ctl.signal, headers: { 'user-agent': 'Mozilla/5.0 mac-analiz', accept: 'application/json' } });
      clearTimeout(to);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) {
      if (attempt === 1) throw e;
    } finally { release(); }
  }
}
function getJSON(url, ttlMs = 5 * 60 * 1000) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.t < hit.ttl) return hit.p;
  const p = rawFetch(url);
  cache.set(url, { t: Date.now(), ttl: ttlMs, p });
  p.catch(() => cache.delete(url));
  return p;
}
const memo = new Map();
function memoAsync(key, ttlMs, fn) {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.t < ttlMs) return hit.p;
  const p = fn(); memo.set(key, { t: Date.now(), p });
  p.catch(() => memo.delete(key));
  return p;
}
setInterval(() => { // önbellek temizliği
  const now = Date.now();
  for (const [k, v] of cache) if (now - v.t > Math.max(v.ttl, 3600e3) * 2) cache.delete(k);
  for (const [k, v] of memo) if (now - v.t > 24 * 3600e3) memo.delete(k);
}, 30 * 60 * 1000).unref();

/* ---------- yardımcılar ---------- */
const num = v => { if (v == null || v === '') return null; const n = Number(String(v).replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) ? n : null; };
const ymd = d => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
const logoOf = t => t?.logo || t?.logos?.[0]?.href || null;

function statusOf(st) {
  const t = st?.type || {};
  return { state: t.state || 'pre', name: t.name || '', clock: st?.displayClock || '', completed: !!t.completed };
}
function teamOf(c) {
  const t = c.team || {};
  const rec = c.records?.[0]?.summary || c.record?.[0]?.displayValue || c.record?.[0]?.summary || null;
  return {
    id: String(t.id), name: t.displayName || t.name || '?', short: t.shortDisplayName || t.displayName || t.name || '?',
    abbr: t.abbreviation || (t.shortDisplayName || '').slice(0, 3).toUpperCase(), logo: logoOf(t),
    score: c.score == null ? null : (typeof c.score === 'object' ? num(c.score.value ?? c.score.displayValue) : num(c.score)),
    winner: !!c.winner, record: typeof rec === 'string' && /^\d+-\d+-\d+$/.test(rec) ? rec : null,
  };
}
function eventOf(ev, league) {
  const comp = ev.competitions?.[0]; if (!comp) return null;
  const h = comp.competitors?.find(c => c.homeAway === 'home'), a = comp.competitors?.find(c => c.homeAway === 'away');
  if (!h || !a) return null;
  return { id: String(ev.id), league, date: ev.date || comp.date, status: statusOf(ev.status || comp.status), home: teamOf(h), away: teamOf(a) };
}

/* ---------- ligdeki maç geçmişi (model + form + H2H için) ---------- */
function scoreboard(slug, a, b) {
  const dates = a === b ? a : `${a}-${b}`;
  return getJSON(`${ESPN}/${slug}/scoreboard?dates=${dates}&limit=500`, 3 * 60 * 1000);
}
function getHistory(slug) {
  return memoAsync('hist:' + slug, 3 * 3600e3, async () => {
    const end = Date.now() + 2 * 86400e3, start = end - 440 * 86400e3, step = 55 * 86400e3, jobs = [];
    for (let t = start; t < end; t += step) jobs.push(scoreboard(slug, ymd(new Date(t)), ymd(new Date(Math.min(t + step - 86400e3, end)))).catch(() => null));
    const parts = await Promise.all(jobs), seen = new Map();
    for (const p of parts) for (const ev of p?.events || []) {
      const e = eventOf(ev, slug); if (e && !seen.has(e.id)) seen.set(e.id, e);
    }
    const all = [...seen.values()].map(e => ({ ...e, t: Date.parse(e.date) })).sort((x, y) => x.t - y.t);
    const done = all.filter(e => e.status.completed && e.home.score != null && e.away.score != null && !/postpon|cancel|aband/i.test(e.status.name));
    return { all, done };
  });
}

/* ---------- Poisson / Dixon-Coles benzeri model ---------- */
function fitModel(done, refT) {
  const HL = 150 * 86400e3, ms = done.filter(m => m.t < refT && m.t > refT - 430 * 86400e3);
  const teams = new Map(); const idx = id => { if (!teams.has(id)) teams.set(id, teams.size); return teams.get(id); };
  const rows = ms.map(m => ({ h: idx(m.home.id), a: idx(m.away.id), hg: m.home.score, ag: m.away.score, w: Math.pow(0.5, (refT - m.t) / HL) }));
  const n = teams.size; if (rows.length < 20 || n < 4) return null;
  const att = new Array(n).fill(1), def = new Array(n).fill(1), games = new Array(n).fill(0);
  let mu = 1.2, H = 1.25;
  const sw = rows.reduce((s, r) => s + r.w, 0);
  mu = rows.reduce((s, r) => s + r.w * r.ag, 0) / sw || 1.2;
  H = (rows.reduce((s, r) => s + r.w * r.hg, 0) / sw) / mu || 1.25;
  for (const r of rows) { games[r.h]++; games[r.a]++; }
  for (let it = 0; it < 40; it++) {
    const num1 = new Array(n).fill(0), den1 = new Array(n).fill(0);
    for (const r of rows) {
      num1[r.h] += r.w * r.hg; den1[r.h] += r.w * mu * H * def[r.a];
      num1[r.a] += r.w * r.ag; den1[r.a] += r.w * mu * def[r.h];
    }
    const k = 0.12 * (den1.reduce((s, v) => s + v, 0) / n);
    for (let i = 0; i < n; i++) att[i] = (num1[i] + k) / (den1[i] + k);
    let m = att.reduce((s, v) => s + v, 0) / n; for (let i = 0; i < n; i++) att[i] /= m;
    const num2 = new Array(n).fill(0), den2 = new Array(n).fill(0);
    for (const r of rows) {
      num2[r.a] += r.w * r.hg; den2[r.a] += r.w * mu * H * att[r.h];
      num2[r.h] += r.w * r.ag; den2[r.h] += r.w * mu * att[r.a];
    }
    const k2 = 0.12 * (den2.reduce((s, v) => s + v, 0) / n);
    for (let i = 0; i < n; i++) def[i] = (num2[i] + k2) / (den2[i] + k2);
    m = def.reduce((s, v) => s + v, 0) / n; for (let i = 0; i < n; i++) def[i] /= m;
    let eH = 0, eA = 0, oH = 0, oA = 0;
    for (const r of rows) { eH += r.w * mu * H * att[r.h] * def[r.a]; eA += r.w * mu * att[r.a] * def[r.h]; oH += r.w * r.hg; oA += r.w * r.ag; }
    mu *= (oH + oA) / (eH + eA); H *= (oH / eH) / (oA / eA);
  }
  const rawAvg = ms.reduce((s, m) => s + m.home.score + m.away.score, 0) / ms.length;
  return { teams, att, def, mu, H, games, matches: ms.length, avgGoals: rawAvg };
}
const pois = (l, k) => { let p = Math.exp(-l); for (let i = 1; i <= k; i++) p *= l / i; return p; };
function scoreMatrix(lh, la, N = 12) {
  const rho = -0.05, m = [];
  let tot = 0;
  for (let i = 0; i < N; i++) { m.push([]); for (let j = 0; j < N; j++) {
    let p = pois(lh, i) * pois(la, j), tau = 1;
    if (i === 0 && j === 0) tau = 1 - lh * la * rho; else if (i === 0 && j === 1) tau = 1 + lh * rho;
    else if (i === 1 && j === 0) tau = 1 + la * rho; else if (i === 1 && j === 1) tau = 1 - rho;
    p *= Math.max(tau, 0); m[i].push(p); tot += p; } }
  return m.map(r => r.map(v => v / tot));
}
function markets(m) {
  const N = m.length, o = { home: 0, draw: 0, away: 0, btts: 0, over: {}, homeOver: {}, awayOver: {}, goalDist: new Array(7).fill(0), topScores: [] };
  const sc = [];
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    const p = m[i][j];
    if (i > j) o.home += p; else if (i === j) o.draw += p; else o.away += p;
    if (i > 0 && j > 0) o.btts += p;
    o.goalDist[Math.min(6, i + j)] += p;
    if (i < 7 && j < 7) sc.push({ s: `${i}-${j}`, p });
  }
  for (const l of ['0.5', '1.5', '2.5', '3.5', '4.5']) { let s = 0; for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) if (i + j > +l) s += m[i][j]; o.over[l] = s; }
  for (const l of ['0.5', '1.5', '2.5']) { let a = 0, b = 0; for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) { if (i > +l) a += m[i][j]; if (j > +l) b += m[i][j]; } o.homeOver[l] = a; o.awayOver[l] = b; }
  o.bttsNo = 1 - o.btts; o.dc1X = o.home + o.draw; o.dcX2 = o.draw + o.away; o.dc12 = o.home + o.away;
  o.homeCleanSheet = m.reduce((s, r) => s + r[0], 0); o.awayCleanSheet = m[0].reduce((s, v) => s + v, 0);
  o.topScores = sc.sort((a, b) => b.p - a.p).slice(0, 10);
  return o;
}
function formOf(done, teamId, beforeT, n = 6) {
  return done.filter(m => m.t < beforeT && (m.home.id === teamId || m.away.id === teamId)).slice(-n).map(m => {
    const own = m.home.id === teamId ? m.home.score : m.away.score, opp = m.home.id === teamId ? m.away.score : m.home.score;
    return own > opp ? 'W' : own < opp ? 'L' : 'D';
  });
}
function marketFromSummary(s) {
  const pc = (s.pickcenter || s.odds || [])[0]; if (!pc) return null;
  const ml = x => { const v = num(x?.moneyLine ?? x?.current?.moneyLine?.american ?? x?.odds?.moneyLine); return v; };
  const mh = ml(pc.homeTeamOdds), ma = ml(pc.awayTeamOdds), md = ml(pc.drawOdds);
  if (mh == null || ma == null || md == null) return null;
  const dec = v => v > 0 ? 1 + v / 100 : 1 + 100 / -v;
  const dh = dec(mh), dd = dec(md), da = dec(ma), ih = 1 / dh, id = 1 / dd, ia = 1 / da, t = ih + id + ia;
  return { provider: pc.provider?.name || 'Piyasa', home: ih / t, draw: id / t, away: ia / t, decHome: dh, decDraw: dd, decAway: da, total: num(pc.overUnder), overProb: null };
}

/* ---------- maç özeti (summary) ayrıştırma ---------- */
const summaryUrl = (slug, id) => `${ESPN}/${slug}/summary?event=${id}`;
function getSummary(slug, id, done) { return getJSON(summaryUrl(slug, id), done ? 12 * 3600e3 : 60 * 1000); }

const STAT_MAP = { // ESPN oyuncu istatistik adı -> arayüz anahtarı
  totalGoals: 'goals', goalAssists: 'assists', totalShots: 'shots', shotsOnTarget: 'sot', foulsCommitted: 'fouls', foulsSuffered: 'fouled',
  offsides: 'offsides', yellowCards: 'yc', redCards: 'rc', saves: 'saves', goalsConceded: 'conceded', totalPasses: 'passes', accuratePasses: 'accPasses',
  keyPasses: 'keyPasses', totalCrosses: 'crosses', accurateCrosses: 'accCrosses', totalLongBalls: 'longBalls', accurateLongBalls: 'accLongBalls',
  totalTackles: 'tackles', effectiveTackles: 'tacklesWon', wonTackles: 'tacklesWon', interceptions: 'interceptions', totalClearance: 'clearances',
  effectiveClearance: 'clearances', blockedShots: 'blocks', totalDribbles: 'dribbles', successfulDribbles: 'dribblesWon', wonDribbles: 'dribblesWon',
  touches: 'touches', possessionLost: 'lostBall', ballRecovery: 'recoveries', totalDuels: 'duels', duelsWon: 'duelsWon', aerialsWon: 'aerialsWon', wonAerials: 'aerialsWon',
  expectedGoals: 'xg', expectedAssists: 'xa', bigChanceCreated: 'bigChances',
};
const subMinute = e => { const m = String(e?.clock?.displayValue ?? e?.clock ?? '').match(/(\d+)(?:'\+(\d+))?/); return m ? Math.min(+m[1] + (m[2] ? +m[2] : 0), 120) : null; };

function parseSummary(s) {
  const comp = s.header?.competitions?.[0];
  const home = comp?.competitors?.find(c => c.homeAway === 'home'), away = comp?.competitors?.find(c => c.homeAway === 'away');
  const teamStats = {};
  for (const t of s.boxscore?.teams || []) {
    const o = {}; for (const st of t.statistics || []) if (st.name) o[st.name] = st.displayValue ?? st.value;
    teamStats[String(t.team?.id)] = o;
  }
  const keyEvents = (s.keyEvents || []).map((e, i) => ({
    id: String(e.id ?? i), type: e.type?.type || '', typeText: e.type?.text || '', clock: e.clock?.displayValue || '',
    teamId: e.team?.id != null ? String(e.team.id) : null, scoring: !!e.scoringPlay,
    players: (e.participants || []).map(p => p.athlete?.displayName).filter(Boolean), _min: subMinute(e),
  })).filter(e => e.type);
  const subs = keyEvents.filter(e => /substitution/i.test(e.type));
  const rosters = (s.rosters || []).map(r => ({
    teamId: String(r.team?.id), formation: r.formation || null,
    players: (r.roster || []).map(p => {
      const stats = {}, raw = {};
      for (const st of p.stats || []) if (st.name) { raw[st.name] = num(st.value ?? st.displayValue); }
      for (const [k, v] of Object.entries(raw)) if (v != null) { stats[k] = v; }
      const mapped = {}; for (const [k, v] of Object.entries(raw)) if (v != null && STAT_MAP[k]) mapped[STAT_MAP[k]] = v;
      const starter = !!p.starter, subbedIn = !!p.subbedIn, subbedOut = !!p.subbedOut;
      let min = null;
      if (starter || subbedIn) {
        const sub = subs.find(e => e.teamId === String(r.team?.id) && e.players.some(n => n === p.athlete?.displayName));
        const end = 90;
        if (starter) min = subbedOut && sub?._min ? sub._min : end;
        else min = sub?._min ? Math.max(end - sub._min, 1) : 20;
        mapped.min = min;
      }
      return { id: String(p.athlete?.id), name: p.athlete?.displayName || p.athlete?.fullName || '?', jersey: p.jersey || '', pos: p.position?.abbreviation || '',
        starter, subbedIn, subbedOut, stats, mapped, played: starter || subbedIn };
    }),
  }));
  return { comp, home, away, teamStats, keyEvents, rosters };
}

/* ---------- takım verisi: son N maçın özetlerinden ---------- */
async function teamMatches(slug, teamId, n = 12) {
  const { done } = await getHistory(slug);
  const mine = done.filter(m => m.home.id === teamId || m.away.id === teamId).slice(-n);
  const out = await Promise.all(mine.map(async m => {
    try { const s = parseSummary(await getSummary(slug, m.id, true)); return { m, s }; } catch { return { m, s: null }; }
  }));
  return out;
}
function teamPayload(slug, teamId) {
  return memoAsync(`team:${slug}:${teamId}`, 90 * 60e3, async () => {
    const { done } = await getHistory(slug);
    const rows = await teamMatches(slug, teamId, 12);
    const avgFor = {}, avgAgainst = {}, cntF = {}, cntA = {};
    const KEYS = ['possessionPct','totalShots','shotsOnTarget','blockedShots','wonCorners','offsides','foulsCommitted','yellowCards','redCards','saves','totalPasses','accuratePasses','totalCrosses','totalLongBalls','totalTackles','interceptions','totalClearance'];
    let statMatches = 0; const players = new Map();
    for (const { m, s } of rows) {
      if (!s) continue;
      const own = s.teamStats[teamId], opp = s.teamStats[m.home.id === teamId ? m.away.id : m.home.id];
      if (own && Object.keys(own).length) {
        statMatches++;
        for (const k of KEYS) {
          const a = num(own[k]), b = num(opp?.[k]);
          if (a != null) { avgFor[k] = (avgFor[k] || 0) + a; cntF[k] = (cntF[k] || 0) + 1; }
          if (b != null) { avgAgainst[k] = (avgAgainst[k] || 0) + b; cntA[k] = (cntA[k] || 0) + 1; }
        }
      }
      const r = s.rosters.find(x => x.teamId === teamId);
      for (const p of r?.players || []) {
        if (!p.played && !Object.keys(p.mapped).length) { if (!players.has(p.id)) players.set(p.id, blankPlayer(p)); continue; }
        const o = players.get(p.id) || blankPlayer(p);
        if (p.played) { o.apps++; if (p.starter) o.starts++; }
        for (const k of ['goals','assists','shots','sot','fouls','fouled','yc','rc','saves']) o[k] += p.mapped[k] || 0;
        o.jersey = p.jersey || o.jersey; o.pos = p.pos || o.pos; players.set(p.id, o);
      }
    }
    for (const k of KEYS) { if (cntF[k]) avgFor[k] /= cntF[k]; else delete avgFor[k]; if (cntA[k]) avgAgainst[k] /= cntA[k]; else delete avgAgainst[k]; }
    const roster = await rosterOf(slug, teamId).catch(() => []);
    for (const a of roster) if (!players.has(a.id)) players.set(a.id, { id: a.id, name: a.name, jersey: a.jersey, pos: a.pos, apps: 0, starts: 0, goals: 0, assists: 0, shots: 0, sot: 0, fouls: 0, fouled: 0, yc: 0, rc: 0, saves: 0 });
    const games = done.filter(m => m.home.id === teamId || m.away.id === teamId).slice(-20)
      .map(m => ({ gf: m.home.id === teamId ? m.home.score : m.away.score, ga: m.home.id === teamId ? m.away.score : m.home.score }));
    return { teamId, statMatches, matchCount: rows.filter(r => r.s).length, avgFor, avgAgainst, matches: games, players: [...players.values()].filter(p => p.name !== '?'), injuries: [] };
  });
}
function blankPlayer(p) { return { id: p.id, name: p.name, jersey: p.jersey, pos: p.pos, apps: 0, starts: 0, goals: 0, assists: 0, shots: 0, sot: 0, fouls: 0, fouled: 0, yc: 0, rc: 0, saves: 0 }; }
function rosterOf(slug, teamId) {
  return memoAsync(`roster:${slug}:${teamId}`, 12 * 3600e3, async () => {
    const d = await getJSON(`${ESPN}/${slug}/teams/${teamId}/roster`, 12 * 3600e3);
    let list = d.athletes || []; if (list.length && list[0].items) list = list.flatMap(g => g.items);
    return list.map(a => ({ id: String(a.id), name: a.displayName || a.fullName, jersey: a.jersey || '', pos: a.position?.abbreviation || '', age: a.age ?? null, nation: a.citizenship || a.birthPlace?.country || null, team: d.team }));
  });
}

/* ---------- API uçları ---------- */
async function apiMatches(date, league, tz) {
  const y = +date.slice(0, 4), mo = +date.slice(4, 6) - 1, d = +date.slice(6, 8);
  const start = Date.UTC(y, mo, d) - tz * 60000, end = start + 86400e3;
  const a = ymd(new Date(start)), b = ymd(new Date(end - 1));
  const slugs = league === 'all' ? UI_LEAGUES : [league];
  const errors = [], events = [];
  await Promise.all(slugs.map(async slug => {
    try {
      const j = await scoreboard(slug, a, b);
      for (const ev of j.events || []) { const e = eventOf(ev, slug); if (!e) continue; const t = Date.parse(e.date); if (t >= start && t < end) events.push(e); }
    } catch { errors.push(slug); }
  }));
  events.sort((p, q) => Date.parse(p.date) - Date.parse(q.date));
  return { events, errors: league === 'all' && errors.length > slugs.length - 1 ? errors : errors };
}

async function apiMatch(slug, id) {
  const raw = await getJSON(summaryUrl(slug, id), 45 * 1000);
  const s = parseSummary(raw), comp = s.comp; if (!comp || !s.home || !s.away) throw new Error('maç bulunamadı');
  const hist = await getHistory(slug).catch(() => ({ done: [], all: [] }));
  const home = teamOf(s.home), away = teamOf(s.away), t = Date.parse(comp.date);
  const st = statusOf(comp.status);
  const hf = formOf(hist.done, home.id, t), af = formOf(hist.done, away.id, t);
  home.form = hf.join(''); away.form = af.join('');
  const venue = raw.gameInfo?.venue;
  const lastFive = (raw.boxscore?.form || []).map(f => ({
    teamId: String(f.team?.id), events: (f.events || []).slice(0, 5).map(e => ({
      id: String(e.id), result: e.gameResult || '?', atVs: e.atVs || 'vs', opponent: e.opponent?.displayName || '?', opponentLogo: logoOf(e.opponent), score: e.score || '' })) }));
  for (const tm of [home, away]) if (!lastFive.find(l => l.teamId === tm.id)) {
    const evs = hist.done.filter(m => m.t < t && (m.home.id === tm.id || m.away.id === tm.id)).slice(-5).reverse().map(m => {
      const h = m.home.id === tm.id, own = h ? m.home.score : m.away.score, opp = h ? m.away.score : m.home.score, o = h ? m.away : m.home;
      return { id: m.id, result: own > opp ? 'W' : own < opp ? 'L' : 'D', atVs: h ? 'vs' : '@', opponent: o.name, opponentLogo: o.logo, score: `${m.home.score}-${m.away.score}` };
    });
    lastFive.push({ teamId: tm.id, events: evs });
  }
  const h2h = hist.done.filter(m => m.t < t && ((m.home.id === home.id && m.away.id === away.id) || (m.home.id === away.id && m.away.id === home.id)))
    .slice(-5).reverse().map(m => ({ id: m.id, date: m.date, home: m.home.name, away: m.away.name, homeScore: m.home.score, awayScore: m.away.score }));
  return {
    id: String(id), league: slug, leagueName: raw.header?.league?.name || slug, date: comp.date, status: st,
    venue: venue?.fullName || null, city: venue?.address?.city || null, home, away,
    keyEvents: s.keyEvents.map(({ _min, ...e }) => e), teamStats: s.teamStats,
    rosters: s.rosters.map(r => ({ teamId: r.teamId, formation: r.formation, players: r.players.map(p => ({ id: p.id, name: p.name, jersey: p.jersey, pos: p.pos, starter: p.starter, subbedIn: p.subbedIn, subbedOut: p.subbedOut, stats: {
      totalGoals: p.stats.totalGoals ?? 0, goalAssists: p.stats.goalAssists ?? 0, totalShots: p.stats.totalShots ?? 0, shotsOnTarget: p.stats.shotsOnTarget ?? 0,
      foulsCommitted: p.stats.foulsCommitted ?? 0, foulsSuffered: p.stats.foulsSuffered ?? 0, offsides: p.stats.offsides ?? 0, yellowCards: p.stats.yellowCards ?? 0, redCards: p.stats.redCards ?? 0, saves: p.stats.saves ?? 0 } })) })),
    lastFive, h2h, generatedAt: new Date().toISOString(),
  };
}

async function apiMatchPlayers(slug, id) {
  const s = parseSummary(await getJSON(summaryUrl(slug, id), 90 * 1000));
  const teams = {};
  for (const r of s.rosters) { teams[r.teamId] = {}; for (const p of r.players) if (p.played) teams[r.teamId][p.id] = p.mapped; }
  return { teams };
}

async function apiPredict(slug, id) {
  const raw = await getJSON(summaryUrl(slug, id), 60 * 1000);
  const s = parseSummary(raw), comp = s.comp; if (!comp || !s.home || !s.away) throw new Error('maç bulunamadı');
  const hid = String(s.home.team.id), aid = String(s.away.team.id), t = Date.parse(comp.date);
  const { done } = await getHistory(slug);
  const fit = fitModel(done, t);
  if (!fit) throw new Error('Bu lig için model kuracak kadar maç verisi yok');
  const hi = fit.teams.get(hid), ai = fit.teams.get(aid);
  if (hi == null || ai == null) throw new Error('Takımlardan biri için yeterli geçmiş maç yok');
  const lh = fit.mu * fit.H * fit.att[hi] * fit.def[ai], la = fit.mu * fit.att[ai] * fit.def[hi];
  const m = scoreMatrix(lh, la), mk = markets(m);
  const strength = i => fit.att[i] / fit.def[i];
  const order = [...fit.teams.values()].sort((x, y) => strength(y) - strength(x));
  const st = statusOf(comp.status), hs = num(s.home.score), as = num(s.away.score);
  return {
    lambdaHome: lh, lambdaAway: la, markets: mk, matrix: m.slice(0, 7).map(r => r.slice(0, 7)),
    teams: { home: { att: fit.att[hi], def: fit.def[hi], rank: order.indexOf(hi) + 1, form: formOf(done, hid, t), games: fit.games[hi] },
             away: { att: fit.att[ai], def: fit.def[ai], rank: order.indexOf(ai) + 1, form: formOf(done, aid, t), games: fit.games[ai] } },
    league_: { teams: fit.teams.size, matches: fit.matches, avgGoals: fit.avgGoals, homeAdv: fit.H },
    market: marketFromSummary(raw), actual: st.completed && hs != null && as != null ? { home: hs, away: as } : null,
  };
}

async function apiStandings(slug) {
  const d = await getJSON(`${ESPN_V2}/${slug}/standings`, 30 * 60e3);
  const kids = d.children?.length ? d.children : [{ name: 'Puan durumu', standings: d.standings }];
  const groups = kids.map(c => ({
    name: c.name || 'Puan durumu',
    rows: (c.standings?.entries || []).map((e, i) => {
      const st = {}; for (const x of e.stats || []) st[x.name] = x.value;
      return { teamId: String(e.team.id), name: e.team.displayName, logo: logoOf(e.team), rank: st.rank ?? i + 1, gp: st.gamesPlayed ?? 0, w: st.wins ?? 0, d: st.ties ?? 0, l: st.losses ?? 0,
        gf: st.pointsFor ?? 0, ga: st.pointsAgainst ?? 0, gd: st.pointDifferential ?? ((st.pointsFor ?? 0) - (st.pointsAgainst ?? 0)), pts: st.points ?? 0,
        note: e.note?.description || null, noteColor: e.note?.color || null };
    }).sort((a, b) => a.rank - b.rank),
  })).filter(g => g.rows.length);
  return { season: d.season?.displayName || d.seasons?.[0]?.displayName || d.children?.[0]?.standings?.seasonDisplayName || '', groups };
}

const POS_TR = { G: 'Kaleci', GK: 'Kaleci', D: 'Defans', DF: 'Defans', M: 'Orta saha', MF: 'Orta saha', F: 'Forvet', FW: 'Forvet', CB: 'Defans', LB: 'Defans', RB: 'Defans', CM: 'Orta saha', AM: 'Orta saha', DM: 'Orta saha', LW: 'Forvet', RW: 'Forvet', ST: 'Forvet', CF: 'Forvet' };
async function apiPlayer(slug, playerId, teamId) {
  const rows = await teamMatches(slug, teamId, 12);
  const roster = await rosterOf(slug, teamId).catch(() => []);
  const info = roster.find(a => a.id === playerId);
  const tm = rows.find(r => r.s)?.s;
  const tt = tm ? (tm.home.team.id == teamId ? tm.home.team : tm.away.team) : roster[0]?.team || {};
  const totals = {}, tracked = {}, matches = []; let apps = 0, minutes = 0, starts = 0, posAbbr = info?.pos || '', name = info?.name, jersey = info?.jersey || '';
  for (const { m, s } of rows.slice().reverse()) {
    const isHome = m.home.id === teamId, opp = isHome ? m.away : m.home;
    const p = s?.rosters.find(r => r.teamId === teamId)?.players.find(x => x.id === playerId);
    const row = { id: m.id, date: m.date, opponent: opp.name, opponentShort: opp.short, opponentLogo: opp.logo, homeAway: isHome ? 'home' : 'away',
      gf: isHome ? m.home.score : m.away.score, ga: isHome ? m.away.score : m.home.score, played: !!p?.played, stats: null };
    if (p) { name = name || p.name; posAbbr = p.pos || posAbbr; jersey = p.jersey || jersey; }
    if (p?.played) {
      apps++; if (p.starter) starts++;
      const st = { ...p.mapped }; minutes += st.min || 0;
      for (const k of ['goals', 'assists', 'shots', 'sot', 'fouls', 'fouled', 'yc', 'rc', 'saves']) if (st[k] == null) st[k] = 0;
      for (const [k, v] of Object.entries(st)) { totals[k] = (totals[k] || 0) + v; tracked[k] = (tracked[k] || 0) + 1; }
      row.stats = st;
    }
    matches.push(row);
  }
  if (!name) throw new Error('oyuncu bulunamadı');
  totals.starts = starts;
  const pa = String(posAbbr || '').toUpperCase();
  return {
    player: { id: playerId, name, posAbbr: pa, posTr: POS_TR[pa] || posAbbr || null, jersey, age: info?.age ?? null, nation: info?.nation ?? null, nationFlag: null },
    team: { id: teamId, name: tt.displayName || '', logo: logoOf(tt) }, apps, minutes, totals, tracked, matches: matches.reverse(),
    matchesChecked: rows.length, season: new Date().getFullYear().toString(),
  };
}

const rosterIndexLeagues = new Set();
async function apiSearch(q) {
  const out = []; const ql = q.toLowerCase();
  try {
    const d = await getJSON(`${ESPN_SEARCH}?query=${encodeURIComponent(q)}&limit=25&type=player&sport=soccer&lang=en&region=us`, 10 * 60e3);
    for (const it of d.items || d.results?.[0]?.contents || []) {
      const lg = it.defaultLeagueSlug || it.league; const rel = it.teamRelationships?.[0]?.core || it.teams?.[0];
      if (!LEAGUE_OK.has(lg) || !rel?.id) continue;
      out.push({ id: String(it.id), name: it.displayName || it.name, league: lg, teamId: String(rel.id), team: rel.displayName || '', teamLogo: logoOf(rel) || rel.logos?.[0]?.href || null, pos: it.position || '' });
    }
  } catch {}
  if (!out.length) { // yedek: önbellekteki kadrolarda ara
    for (const [k, v] of memo) {
      if (!k.startsWith('roster:')) continue;
      const [, slug, teamId] = k.split(':');
      try { for (const a of await v.p) if (a.name?.toLowerCase().includes(ql)) out.push({ id: a.id, name: a.name, league: slug, teamId, team: a.team?.displayName || '', teamLogo: logoOf(a.team), pos: a.pos }); } catch {}
      if (out.length >= 15) break;
    }
  }
  return out.slice(0, 15);
}

/* ---------- HTTP ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon' };
function send(req, res, code, body, type, extra = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const h = { 'content-type': type, ...extra };
  if (buf.length > 1024 && /gzip/.test(req.headers['accept-encoding'] || '') && /text|json|javascript|svg|manifest/.test(type)) {
    res.writeHead(code, { ...h, 'content-encoding': 'gzip', vary: 'accept-encoding' }); return res.end(zlib.gzipSync(buf));
  }
  res.writeHead(code, h); res.end(buf);
}
const json = (req, res, code, obj, cc = 'no-store') => send(req, res, code, JSON.stringify(obj), 'application/json', { 'cache-control': cc });

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x'), p = u.pathname;
    if (p === '/healthz') return json(req, res, 200, { ok: true });
    if (p.startsWith('/api/')) {
      const seg = p.split('/').slice(2).map(decodeURIComponent);
      const okLeague = l => LEAGUE_OK.has(l), okId = i => /^\d{1,12}$/.test(i || '');
      try {
        if (seg[0] === 'matches' && /^\d{8}$/.test(seg[1]) && (seg[2] === 'all' || okLeague(seg[2])))
          return json(req, res, 200, await apiMatches(seg[1], seg[2], Math.max(-840, Math.min(840, +u.searchParams.get('tz') || 0))));
        if (seg[0] === 'match' && okLeague(seg[1]) && okId(seg[2])) return json(req, res, 200, await apiMatch(seg[1], seg[2]));
        if (seg[0] === 'match-players' && okLeague(seg[1]) && okId(seg[2])) return json(req, res, 200, await apiMatchPlayers(seg[1], seg[2]));
        if (seg[0] === 'predict' && okLeague(seg[1]) && okId(seg[2])) return json(req, res, 200, await apiPredict(seg[1], seg[2]));
        if (seg[0] === 'team' && okLeague(seg[1]) && okId(seg[2])) return json(req, res, 200, await teamPayload(seg[1], seg[2]));
        if (seg[0] === 'standings' && okLeague(seg[1])) return json(req, res, 200, await apiStandings(seg[1]));
        if (seg[0] === 'player' && okLeague(seg[1]) && okId(seg[2]) && okId(u.searchParams.get('team'))) return json(req, res, 200, await apiPlayer(seg[1], seg[2], u.searchParams.get('team')));
        if (seg[0] === 'search') { const q = (u.searchParams.get('q') || '').trim().slice(0, 60); return json(req, res, 200, q.length >= 2 ? await apiSearch(q) : []); }
        return json(req, res, 404, { message: 'bulunamadı' });
      } catch (e) {
        console.error(p, e.message);
        return json(req, res, 502, { message: e.message || 'Veri kaynağına ulaşılamadı' });
      }
    }
    let f = path.normalize(path.join(PUBLIC, p === '/' ? 'index.html' : p));
    if (!f.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
    if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(PUBLIC, 'index.html');
    const ext = path.extname(f);
    const cc = f.includes(path.sep + 'assets' + path.sep) ? 'public, max-age=31536000, immutable' : 'no-cache';
    send(req, res, 200, fs.readFileSync(f), MIME[ext] || 'application/octet-stream', { 'cache-control': cc });
  } catch (e) { console.error(e); res.writeHead(500); res.end('hata'); }
});
server.listen(PORT, () => console.log('Maç Analiz http://localhost:' + PORT));
