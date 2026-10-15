// Crawlable content pages. The game itself is a JS-only SPA, so search engines
// (and the social/AI scrapers that don't run JS) only ever saw the landing
// shell. These are small server-rendered HTML pages — no scripts, inline CSS,
// self-hosted fonts — that answer what people actually search for: what
// instagib is, how to play, the maps, and the live leaderboard. Each links to
// /play. Listed in public/sitemap.xml.

import type { Express, Response } from 'express';
import { getLeaderboard, type LeaderboardEntry } from './db';
import {
  DUEL_FRAG_LIMIT,
  MATCH_FRAG_LIMIT,
  MAX_PLAYERS,
  RANKED_DUEL_FRAG_LIMIT,
  TDM_FRAG_LIMIT,
} from '../src/game/constants';

const ORIGIN = 'https://instagib.win';

// Default binds, as in src/controls.ts. Restated here because the runtime image
// ships only src/game alongside server/ (see Dockerfile).
const CONTROLS: ReadonlyArray<readonly [string, string]> = [
  ['WASD', 'Move'],
  ['Mouse', 'Aim'],
  ['Left click', 'Fire railgun — recharges after each shot'],
  ['Space', 'Jump (double-jump in the air)'],
  ['Shift', 'Dash (directional, short cooldown)'],
  ['Right click', 'Boost-jump off a nearby surface'],
  ['Wall + Space', 'Wall-jump for height + speed'],
  ['Tab', 'Scoreboard'],
  ['Esc', 'Release mouse / menu'],
];

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

type Page = {
  path: string;
  title: string; // <title> (≤ 60 chars reads best in results)
  description: string; // meta description (≤ 160 chars)
  heading: string;
  body: string; // trusted HTML (built here, user data escaped)
};

const NAV: ReadonlyArray<readonly [string, string]> = [
  ['/what-is-instagib', 'What is instagib?'],
  ['/how-to-play', 'How to play'],
  ['/maps', 'Maps'],
  ['/leaderboard', 'Leaderboard'],
];

const STYLE = `
@font-face{font-family:Geist;src:url(/fonts/Geist-var-latin.woff2) format('woff2');font-weight:100 900;font-display:swap}
@font-face{font-family:'Chakra Petch';src:url(/fonts/ChakraPetch-700-latin.woff2) format('woff2');font-weight:700;font-display:swap}
*{box-sizing:border-box}
body{margin:0;background:#0a0d13;color:#d9e2ec;font:16px/1.65 Geist,system-ui,sans-serif}
a{color:#5ce1ff}
header,main,footer{max-width:760px;margin:0 auto;padding:0 20px}
header{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;padding-top:22px;padding-bottom:22px}
.brand{font:700 20px 'Chakra Petch',sans-serif;letter-spacing:.08em;color:#fff;text-decoration:none}
.brand span{color:#5ce1ff}
nav{display:flex;flex-wrap:wrap;gap:4px 16px;font-size:14px}
nav a{color:rgba(255,255,255,.6);text-decoration:none}
nav a:hover,nav a[aria-current]{color:#fff}
h1,h2{font-family:'Chakra Petch',sans-serif;color:#fff;line-height:1.2}
h1{font-size:34px;margin:18px 0 8px}
h2{font-size:21px;margin:34px 0 8px}
.lede{font-size:18px;color:rgba(255,255,255,.75)}
.play{display:inline-block;margin:20px 0 8px;padding:12px 26px;background:#00d595;color:#04110c;font:700 16px 'Chakra Petch',sans-serif;letter-spacing:.08em;text-transform:uppercase;text-decoration:none;clip-path:polygon(10px 0,100% 0,100% calc(100% - 10px),calc(100% - 10px) 100%,0 100%,0 10px)}
table{width:100%;border-collapse:collapse;font-size:15px;margin:10px 0}
th,td{padding:7px 10px;text-align:left;border-bottom:1px solid rgba(255,255,255,.08)}
th{color:rgba(255,255,255,.5);font-weight:500;font-size:12px;text-transform:uppercase;letter-spacing:.08em}
td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}
kbd{display:inline-block;min-width:2em;padding:1px 7px;border:1px solid rgba(92,225,255,.35);color:#5ce1ff;font:600 13px ui-monospace,monospace;text-align:center}
.map{margin:22px 0;padding:16px 18px;border:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.02)}
.map h2{margin-top:0}
.meta{font-size:13px;color:rgba(255,255,255,.5);text-transform:uppercase;letter-spacing:.08em}
footer{padding-top:40px;padding-bottom:40px;font-size:13px;color:rgba(255,255,255,.4)}
`;

function render(p: Page): string {
  const nav = NAV.map(
    ([href, label]) => `<a href="${href}"${href === p.path ? ' aria-current="page"' : ''}>${label}</a>`,
  ).join('');
  const url = `${ORIGIN}${p.path}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>${esc(p.title)}</title>
<meta name="description" content="${esc(p.description)}">
<link rel="canonical" href="${url}">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Instagib Arena">
<meta property="og:url" content="${url}">
<meta property="og:title" content="${esc(p.title)}">
<meta property="og:description" content="${esc(p.description)}">
<meta property="og:image" content="${ORIGIN}/wavedash-cover.webp">
<meta name="twitter:card" content="summary_large_image">
<style>${STYLE}</style>
</head>
<body>
<header><a class="brand" href="/">INSTAGIB <span>ARENA</span></a><nav>${nav}</nav></header>
<main>
<h1>${esc(p.heading)}</h1>
${p.body}
<a class="play" href="/play">Play free in your browser</a>
</main>
<footer>Instagib Arena — a free, open-source browser FPS. No download, no install. <a href="/">Home</a> · <a href="/play">Play</a></footer>
</body>
</html>`;
}

const controlsTable = `<table><tbody>${CONTROLS.map(
  ([key, action]) => `<tr><td><kbd>${esc(key)}</kbd></td><td>${esc(action)}</td></tr>`,
).join('')}</tbody></table>`;

const STATIC_PAGES: Page[] = [
  {
    path: '/what-is-instagib',
    title: 'What Is Instagib? One Shot, One Kill — Instagib Arena',
    description:
      'Instagib is the arena-shooter mode where every weapon kills in one hit. Learn where it comes from, why it is pure skill, and play it free in your browser.',
    heading: 'What is instagib?',
    body: `
<p class="lede">Instagib — short for “instant gib” — is the arena-shooter format where every hit kills. No health, no armor, no pickups: one weapon, one shot, one frag.</p>
<h2>Where it comes from</h2>
<p>Instagib started as a mutator in the classic arena shooters of the late 1990s and early 2000s, most famously as Unreal Tournament's InstaGib mode and Quake III Arena's railgun-only instagib servers. Strip out every weapon but a one-hit rifle and the game becomes a pure test of aim and movement. It has been a fixture of competitive and casual arena play ever since.</p>
<h2>Why it's pure skill</h2>
<p>With no damage to trade and no items to control, there is nothing to hide behind. Whoever lands the shot first wins the exchange. That makes instagib fast to learn and endless to master: the gap between players is all crosshair placement, timing, and how well they move.</p>
<ul>
<li><strong>Aim</strong> — a hit is a kill, so a miss is everything. The railgun recharges after each shot, so every shot counts.</li>
<li><strong>Movement</strong> — staying hard to hit matters as much as hitting. Strafing, dashing, double-jumps and wall-jumps keep you alive.</li>
<li><strong>Positioning</strong> — high ground, sight lines and spawn awareness decide who sees whom first.</li>
</ul>
<h2>Instagib in your browser</h2>
<p>Instagib Arena is a free, server-authoritative instagib FPS that runs in any modern desktop browser. Play free-for-all, team deathmatch, casual and ranked 1v1 duels, or practice against bots — no download, no install. Cosmetics never affect combat: the only advantage is skill.</p>
<p>New to the format? Start with <a href="/how-to-play">how to play</a>, then pick a <a href="/maps">map</a>.</p>`,
  },
  {
    path: '/how-to-play',
    title: 'How to Play Instagib Arena — Controls, Movement & Modes',
    description:
      'Controls, movement tech (dash, double-jump, wall-jump, boost-jump) and game modes for Instagib Arena, the free one-shot-one-kill browser FPS.',
    heading: 'How to play Instagib Arena',
    body: `
<p class="lede">One railgun. Every hit is a kill. The railgun recharges after each shot, so the game is about landing your shot first — and not being where the other player's shot lands.</p>
<h2>Controls</h2>
${controlsTable}
<p>Every key can be rebound in Settings, along with mouse sensitivity, field of view and your crosshair.</p>
<h2>Movement</h2>
<ul>
<li><strong>Double-jump</strong> — jump again in mid-air to change direction or reach a ledge.</li>
<li><strong>Dash</strong> — a quick directional burst on a short cooldown. Use it to break line of sight or close a gap.</li>
<li><strong>Wall-jump</strong> — jump into a wall in mid-air for extra height and speed.</li>
<li><strong>Boost-jump</strong> — right-click near a wall or floor to launch off it. It's how you reach the highest platforms.</li>
</ul>
<p>Moving targets are hard targets. Keep moving, change direction often, and use height — a player above you has to aim down at a moving target, while you get a clear silhouette against the sky.</p>
<h2>Game modes</h2>
<table><thead><tr><th>Mode</th><th>Goal</th></tr></thead><tbody>
<tr><td>Free-for-all</td><td>Everyone for themselves — first to ${MATCH_FRAG_LIMIT} frags, up to ${MAX_PLAYERS} players.</td></tr>
<tr><td>Team deathmatch</td><td>Red vs Blue — first team to ${TDM_FRAG_LIMIT} frags.</td></tr>
<tr><td>Duel</td><td>One on one — first to ${DUEL_FRAG_LIMIT} frags.</td></tr>
<tr><td>Ranked duel</td><td>A 1v1 race to ${RANKED_DUEL_FRAG_LIMIT} on an Elo ladder (free account required).</td></tr>
<tr><td>Solo vs bots</td><td>Offline matches against bots at the difficulty you choose.</td></tr>
<tr><td>Training range</td><td>Aim drills and a movement course to warm up.</td></tr>
</tbody></table>
<p>If nobody else is online when you queue, you can practice against bots in the same arena — they leave the moment a real player joins.</p>
<h2>Tips for new players</h2>
<ul>
<li>Lead moving targets slightly and fire when your crosshair crosses them — don't chase.</li>
<li>After you fire, move: the railgun is recharging, so your next job is not getting hit.</li>
<li>Spawn protection ends when you fire or move, so pick your moment.</li>
<li>Play a few rounds in the training range to find a sensitivity you can flick with.</li>
</ul>
<p>A free account saves your XP, levels and cosmetics and puts you on the <a href="/leaderboard">leaderboard</a>.</p>`,
  },
  {
    path: '/maps',
    title: 'Maps — Instagib Arena',
    description:
      'Every arena in Instagib Arena: four large free-for-all and team maps and two symmetric 1v1 duel maps, built for vertical one-shot-one-kill fights.',
    heading: 'Maps',
    body: `
<p class="lede">Every arena is built for vertical instagib: multiple height tiers, long sight lines, and routes you can only reach with a wall-jump or boost-jump.</p>
<div class="map"><h2>Causeway</h2><p class="meta">FFA · TDM · 96 × 72 m</p>
<p>A symmetric complex floating in deep space. A raised ring of islands and keeps loops around a central spire, with a real floor underneath for players who drop into the pit. The Crown, high over the spire, is the map's most contested perch.</p></div>
<div class="map"><h2>Reactor</h2><p class="meta">FFA · TDM · 96 × 72 m</p>
<p>A power-plant interior: a turbine hall and a pump room flank the central reactor core, with balconies, catwalks and gantries stacked up the walls. Close-quarters fights below, long rails across the hall above.</p></div>
<div class="map"><h2>Lounge</h2><p class="meta">FFA · TDM · 96 × 72 m</p>
<p>You're rat-sized in a giant open-plan living room and kitchen. Sofas, tables, bookcases and the fridge are the terrain — every piece of furniture is a step up to the next.</p></div>
<div class="map"><h2>Nuketown</h2><p class="meta">FFA · TDM · 96 × 72 m</p>
<p>A suburban cul-de-sac at golden hour: two mirrored houses, a street of parked cars, backyards and a water tower whose catwalk overlooks the whole block.</p></div>
<div class="map"><h2>Container Yard</h2><p class="meta">Duel · 68 × 58 m</p>
<p>A floodlit night terminal for 1v1. Each player owns a warehouse; between them, container stacks form lanes and decks under a gantry crane whose girder is the contested high ground.</p></div>
<div class="map"><h2>Derrick</h2><p class="meta">Duel · 68 × 58 m</p>
<p>An oil-refinery yard at dusk, symmetric around a lattice drilling tower. Pipe racks cross the yard, and gantries spiral up the tower to a crown you can only reach with a boost.</p></div>
<p>Public matches rotate maps by vote at the end of every match. Learn the movement on <a href="/how-to-play">how to play</a>.</p>`,
  },
];

// The live board: re-rendered at most once a minute (it's a full-table sort).
const BOARD_TTL_MS = 60_000;
let boardCache: { at: number; html: string } | null = null;

function leaderboardPage(): string {
  const now = Date.now();
  if (boardCache && now - boardCache.at < BOARD_TTL_MS) return boardCache.html;
  let rows: LeaderboardEntry[] = [];
  try {
    rows = getLeaderboard({ sort: 'kills', limit: 50 });
  } catch {
    rows = [];
  }
  const table = rows.length
    ? `<table><thead><tr><th class="n">#</th><th>Player</th><th class="n">Frags</th><th class="n">Wins</th><th class="n">K/D</th><th class="n">Best streak</th></tr></thead><tbody>${rows
        .map(
          (r, i) =>
            `<tr><td class="n">${i + 1}</td><td>${esc(r.userName)}</td><td class="n">${r.totalKills}</td><td class="n">${r.totalWins}</td><td class="n">${r.kd.toFixed(2)}</td><td class="n">${r.bestKillStreak}</td></tr>`,
        )
        .join('')}</tbody></table>`
    : '<p>No ranked players yet — be the first.</p>';
  const html = render({
    path: '/leaderboard',
    title: 'Leaderboard — Top Instagib Arena Players',
    description:
      'The top 50 Instagib Arena players by career frags, with wins, K/D and best kill streak. Updated live from the game server.',
    heading: 'Leaderboard',
    body: `<p class="lede">The top 50 players by career frags, straight from the game server. Daily, weekly and accuracy boards are in the game.</p>${table}<p>Only online matches count — practice and bot matches never touch the board. <a href="/how-to-play">Learn the basics</a> and get on it.</p>`,
  });
  boardCache = { at: now, html };
  return html;
}

export const SEO_PAGE_PATHS = [...STATIC_PAGES.map((p) => p.path), '/leaderboard'];

function send(res: Response, html: string, maxAge: number) {
  res.setHeader('Cache-Control', `public, max-age=${maxAge}`);
  res.type('html').send(html);
}

// Unknown URLs get a real 404 (not the app shell with a 200, which search
// engines index as duplicate "soft 404" pages).
export const NOT_FOUND_HTML = render({
  path: '/404',
  title: 'Page not found — Instagib Arena',
  description: 'This page does not exist.',
  heading: 'Page not found',
  body: '<p class="lede">That page doesn\'t exist. The arena does.</p>',
}).replace('<meta name="color-scheme" content="dark">', '<meta name="color-scheme" content="dark">\n<meta name="robots" content="noindex">');

export function mountSeoPages(app: Express): void {
  for (const page of STATIC_PAGES) {
    const html = render(page);
    app.get(page.path, (_req, res) => send(res, html, 3600));
  }
  app.get('/leaderboard', (_req, res) => send(res, leaderboardPage(), 60));
}
