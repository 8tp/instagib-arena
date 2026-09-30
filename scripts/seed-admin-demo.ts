#!/usr/bin/env -S npx tsx
// Demo data for the admin dashboard (dev tooling — never point it at a real DB).
//
// Fills a THROWAWAY database with ~90 days of a plausible arena: signups that
// grow over time, players who churn, prime-time peaks, per-mode match lengths,
// credits in/out (matches, cases, market, trades, salvage, codes), minted items
// with slot-correct qualities, feedback, redeem codes, and a week of per-minute
// concurrency samples. Deterministic (fixed PRNG seed).
//
//   PORT=8795 DATA_DIR=/tmp/ig-demo ADMIN_USERNAMES=opsdeck npx tsx server/index.ts   # creates the schema
//   npx tsx scripts/seed-admin-demo.ts /tmp/ig-demo/instagib.sqlite
//
// Refuses any path under the repo's ./data directory.

import path from 'node:path';
import Database from 'better-sqlite3';
import { ITEM_DEFS, casePoolFor, vaultUnobtainables, type ItemDef } from '../src/game/items/catalog';
import { CASES, KS_EFFECTS, KS_SHEENS, QUALITY_ODDS, TIERS, UNUSUAL_EFFECTS, slotAllows, type Quality, type Tier } from '../src/game/items/types';
import { CREDITS_PER_XP, levelForXp } from '../src/game/progression';

const file = process.argv[2];
if (!file) {
  console.error('usage: npx tsx scripts/seed-admin-demo.ts <path/to/throwaway.sqlite>');
  process.exit(1);
}
const abs = path.resolve(file);
if (abs.startsWith(path.resolve('data') + path.sep)) {
  console.error('refusing to seed the repo data/ directory — use a throwaway DATA_DIR');
  process.exit(1);
}
const db = new Database(abs);
db.pragma('journal_mode = WAL');
if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'instagib_items'`).get()) {
  console.error('no schema yet — boot the server once with DATA_DIR pointing here first');
  process.exit(1);
}

const DAY = 86_400_000;
const MIN = 60_000;
const now = Date.now();
let seed = 20260930;
const r = (): number => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 0x1_0000_0000;
};
const pick = <T>(a: readonly T[]): T => a[Math.floor(r() * a.length)];
const weighted = <T>(pairs: readonly (readonly [T, number])[]): T => {
  let x = r() * pairs.reduce((s, [, w]) => s + w, 0);
  for (const [v, w] of pairs) if ((x -= w) <= 0) return v;
  return pairs[pairs.length - 1][0];
};
const gauss = (): number => (r() + r() + r() + r() - 2) / 0.577; // ~N(0,1)
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// Prime time: evening UTC (EU evening / US afternoon), trough early morning.
const HOUR_W = [3, 2, 1.5, 1, 0.8, 0.7, 0.8, 1.1, 1.5, 2, 2.4, 2.8, 3.2, 3.6, 4, 4.6, 5.4, 6.4, 7.4, 8, 8.2, 7.6, 6.2, 4.6];
const hourPairs = HOUR_W.map((w, h) => [h, w] as const);
const atHour = (dayStart: number) => dayStart + weighted(hourPairs) * 3_600_000 + Math.floor(r() * 3_600_000);
const dayStartOf = (ts: number) => Math.floor(ts / DAY) * DAY;
const weekend = (ts: number) => [0, 6].includes(new Date(ts).getUTCDay());

const MODES = [['ffa', 0.46], ['tdm', 0.2], ['duel', 0.14], ['ranked', 0.1], ['practice', 0.1]] as const;
const LEN_MIN: Record<string, [number, number]> = { ffa: [7.4, 1.7], tdm: [9.2, 2], duel: [5.6, 1.4], ranked: [8.1, 1.6] };

const HANDLES = [
  'Railtooth', 'Kestrel', 'vexa', 'Nightjar', 'Bolt_Sister', 'quietfrag', 'Mirelle', 'ZeroPing', 'hexadecimal', 'Tungsten', 'Arclight', 'sable',
  'Voltaic', 'Pixelwitch', 'Grimsby', 'orbital_ken', 'Lumen', 'Ferro', 'CinderAxe', 'Wisp', 'jolt', 'Paragon', 'Halcyon', 'Nox', 'Brisket', 'Tamsin',
  'Octave', 'Rook', 'spline', 'Quasar', 'Magpie', 'Deadeye_Dee', 'Frostbyte', 'murmur', 'Glint', 'Havoc', 'Ionic', 'Juniper', 'Kilowatt', 'Lark',
  'Mistral', 'Nimbus', 'Onyx', 'Pylon', 'Quill', 'Ravel', 'Strafe', 'Tallow', 'Umbra', 'Vesper', 'Warden', 'Xenon', 'Yarrow', 'Zephyr', 'Ash',
  'Bramble', 'Cobalt', 'Dusk', 'Ember', 'Flint',
];
const nameFor = (i: number) => (i < HANDLES.length ? HANDLES[i] : `${HANDLES[i % HANDLES.length]}${i}`);

const st = {
  user: db.prepare(`INSERT OR IGNORE INTO instagib_users (id, username, username_lower, pw_hash, pw_salt, created_at) VALUES (?,?,?,?,?,?)`),
  stats: db.prepare(`INSERT OR REPLACE INTO instagib_stats (player_id, user_name, total_kills, total_deaths, total_games, total_wins, headshots, shots_fired, shots_hit,
                     best_accuracy, best_kill_streak, created_at, updated_at, total_xp, level, credits, free_rolls, econ_v3)
                     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`),
  audit: db.prepare(`INSERT INTO instagib_audit (ts, event, actor_id, actor_name, target_id, detail, ip) VALUES (?,?,?,?,?,?, '')`),
  item: db.prepare(`INSERT INTO instagib_items (uid, owner_id, def, mint, quality, attrs, origin, tradable, state, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`),
  feedback: db.prepare(`INSERT INTO instagib_feedback (ts, player_id, player_name, type, title, body, status, updated_at) VALUES (?,?,?,?,?,?,?,?)`),
  code: db.prepare(`INSERT OR REPLACE INTO instagib_codes (code, reward, note, max_uses, uses, expires_at, min_level, active, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`),
  redeem: db.prepare(`INSERT OR IGNORE INTO instagib_code_redemptions (code, player_id, at) VALUES (?,?,?)`),
  conc: db.prepare(`INSERT OR REPLACE INTO instagib_concurrency (ts, online, in_match, rooms) VALUES (?,?,?,?)`),
};
db.exec(`CREATE TABLE IF NOT EXISTS instagib_concurrency (ts INTEGER PRIMARY KEY, online INTEGER NOT NULL, in_match INTEGER NOT NULL, rooms INTEGER NOT NULL)`);

// ── Items ────────────────────────────────────────────────────────────────────
const mintNo = new Map<string, number>();
let uidN = 0;
const uid = () => `demo${(uidN++).toString(36).padStart(8, '0')}`;
function qualities(def: ItemDef, tier: Tier): { quality: Quality[]; attrs: Record<string, unknown> } {
  const quality: Quality[] = [];
  const attrs: Record<string, unknown> = {};
  const s = def.slot;
  if (slotAllows(s, 'effect')) {
    const p = s === 'emote' ? QUALITY_ODDS.unusualEmote : TIERS.indexOf(tier) >= TIERS.indexOf('legendary') ? QUALITY_ODDS.unusualHatLegendaryPlus : QUALITY_ODDS.unusualHat;
    if (r() < p * 4) {
      quality.push('unusual');
      attrs.effect = pick(UNUSUAL_EFFECTS.filter((e) => s !== 'emote' || e.taunt)).id;
    }
  }
  if (slotAllows(s, 'kills') && r() < QUALITY_ODDS.strange * 1.5) {
    quality.push('strange');
    attrs.kills = Math.floor(Math.pow(r(), 2.2) * 2600);
  }
  if (slotAllows(s, 'sheen')) {
    const x = r();
    if (x < QUALITY_ODDS.professional * 2) {
      quality.push('killstreak', 'professional');
      attrs.sheen = pick(KS_SHEENS).id;
      attrs.ksEffect = pick(KS_EFFECTS).id;
    } else if (x < QUALITY_ODDS.killstreak * 2) {
      quality.push('killstreak');
      attrs.sheen = pick(KS_SHEENS).id;
    }
  }
  if (slotAllows(s, 'seed')) attrs.seed = Math.floor(r() * 1000);
  return { quality, attrs };
}
function mint(owner: string, def: ItemDef, tier: Tier, origin: string, ts: number, state = 'owned'): string {
  const n = (mintNo.get(def.id) ?? 0) + 1;
  mintNo.set(def.id, n);
  const { quality, attrs } = origin === 'road' ? { quality: [] as Quality[], attrs: {} } : qualities(def, tier);
  const u = uid();
  st.item.run(u, owner, def.id, n, JSON.stringify(quality), JSON.stringify(attrs), origin, def.tradable ? 1 : 0, state, ts, ts);
  return u;
}
function rollCase(caseId: string): { def: ItemDef; tier: Tier } | null {
  const c = CASES.find((x) => x.id === caseId)!;
  const pool = casePoolFor(c.slots);
  let tier = weighted(TIERS.map((t) => [t, c.odds[t]] as const));
  for (let guard = 0; guard < 7; guard++) {
    const defs = tier === 'unobtainable' ? vaultUnobtainables() : pool.filter((d) => d.tier === tier);
    if (defs.length) return { def: pick(defs), tier };
    tier = TIERS[Math.max(0, TIERS.indexOf(tier) - 1)];
  }
  return null;
}
const roadDefs = ITEM_DEFS.filter((d) => !d.default && d.tier === 'common' && ['hat', 'face', 'back', 'beam'].includes(d.slot));

// ── Players ──────────────────────────────────────────────────────────────────
type P = { id: string; name: string; created: number; until: number; p: number; k: number; d: number; g: number; w: number; hs: number; xp: number; credits: number; last: number; best: number };
const players: P[] = [];
const PLAYERS = 260;

const tx = db.transaction(() => {
  for (let i = 0; i < PLAYERS; i++) {
    // Signups skew recent (growth): 90 days × (1 − √u).
    const created = now - Math.floor(90 * DAY * (1 - Math.sqrt(r()))) - Math.floor(r() * DAY);
    const oneAndDone = r() < 0.28;
    const life = oneAndDone ? r() * 1.5 * DAY : -Math.log(1 - r()) * 28 * DAY;
    const name = nameFor(i);
    const id = `demo-${i.toString().padStart(4, '0')}`;
    st.user.run(id, name, name.toLowerCase(), 'x', 'y', created);
    players.push({ id, name, created, until: created + life, p: 0.25 + r() * 0.6, k: 0, d: 0, g: 0, w: 0, hs: 0, xp: 0, credits: 300, last: created, best: 0 });
    st.audit.run(created, 'register', id, name, '', '{}');
  }

  for (const u of players) {
    for (let day = dayStartOf(u.created); day < now; day += DAY) {
      if (day > u.until) break;
      if (r() > u.p * (weekend(day) ? 1.25 : 1)) continue;
      const login = Math.min(now - MIN, Math.max(u.created, atHour(day)));
      st.audit.run(login, 'login', u.id, u.name, '', '{}');
      const games = 1 + Math.floor(-Math.log(1 - r()) * 2.4);
      let ts = login;
      for (let j = 0; j < games && ts < now - 20 * MIN; j++) {
        const mode = weighted(MODES);
        const offline = mode === 'practice';
        const partial = !offline && r() < 0.07;
        const [mu, sd] = LEN_MIN[mode] ?? [6, 1.5];
        const lenMin = partial ? clamp(mu * (0.2 + r() * 0.6), 0.6, 12) : clamp(mu + gauss() * sd, 1.8, 16);
        ts += Math.floor(lenMin * MIN + r() * 4 * MIN);
        if (ts >= now) break;
        const kills = Math.max(0, Math.round((mode === 'duel' ? 9 : 13) * (lenMin / mu) * (0.4 + r() * 1.2)));
        const deaths = Math.max(0, Math.round(kills * (0.5 + r() * 1.1)));
        const won = !partial && r() < (mode === 'duel' ? 0.5 : mode === 'tdm' ? 0.5 : 0.18);
        const xp = Math.round((offline ? 40 : 90) + kills * 9 + (won ? 60 : 0) + r() * 40);
        const credits = offline ? Math.floor(xp * CREDITS_PER_XP * 0.5) : Math.floor(xp * CREDITS_PER_XP) + (r() < 0.12 ? 50 : 0);
        const hs = Math.floor(kills * (0.15 + r() * 0.2));
        const detail: Record<string, unknown> = {
          kills, deaths, won, headshots: hs, accuracy: Math.round(28 + r() * 38), offline, xp, credits,
          mode: offline ? undefined : mode, src: offline ? 'post' : 'ws',
        };
        if (!offline) {
          detail.durationMs = Math.round(lenMin * MIN);
          detail.partial = partial;
        }
        st.audit.run(ts, 'match', u.id, u.name, '', JSON.stringify(detail));
        u.g++; u.k += kills; u.d += deaths; u.hs += hs; u.xp += xp; u.credits += credits; u.last = ts; u.best = Math.max(u.best, Math.min(kills, 4 + Math.floor(r() * 12)));
        if (won) u.w++;

        // A guest in the same lobby now and then (no account).
        if (!offline && r() < 0.35) {
          st.audit.run(ts, 'match', '', 'Guest', '', JSON.stringify({ kills: Math.floor(r() * 10), deaths: Math.floor(r() * 14), won: false, headshots: 0, accuracy: Math.round(20 + r() * 30), offline: false, xp: 0, mode, src: 'ws', durationMs: Math.round(lenMin * MIN * (0.5 + r() * 0.5)), partial: r() < 0.3 }));
        }
        // Economy after the match.
        if (r() < 0.32) {
          const caseId = weighted([['hat', 3], ['weapon', 3.4], ['accessory', 2.2], ['taunt', 1.6], ['vault', 0.6]] as const);
          const pay = caseId === 'vault' ? 'credits' : weighted([['credits', 6], ['daily', 3], ['roll', 1.5]] as const);
          const cost = pay === 'credits' ? (caseId === 'vault' ? 600 : 150) : 0;
          if (u.credits >= cost) {
            const roll = rollCase(caseId);
            if (roll) {
              u.credits -= cost;
              const item = mint(u.id, roll.def, roll.tier, 'case', ts + 5000, r() < 0.05 ? 'listed' : 'owned');
              st.audit.run(ts + 5000, 'case.open', u.id, u.name, item, JSON.stringify({ case: caseId, def: roll.def.id, tier: roll.tier, free: cost === 0, pay, cost }));
            }
          }
        }
        if (r() < 0.05) {
          const price = Math.round(40 + Math.pow(r(), 2) * 2400);
          st.audit.run(ts + 9000, 'market.list', u.id, u.name, 'x', JSON.stringify({ price, fee: Math.max(1, Math.round(price * 0.02)) }));
          if (r() < 0.7) st.audit.run(ts + 9000 + Math.floor(r() * DAY), 'market.sale', pick(players).id, '', u.id, JSON.stringify({ price, tax: Math.max(1, Math.ceil(price * 0.1)) }));
        }
        if (r() < 0.025) st.audit.run(ts + 12_000, 'trade.accept', u.id, u.name, pick(players).id, '{}');
        if (r() < 0.035) {
          const gained = 8 + Math.floor(r() * 120);
          u.credits += gained;
          st.audit.run(ts + 15_000, 'item.salvage', u.id, u.name, u.id, JSON.stringify({ n: 1 + Math.floor(r() * 4), gained }));
        }
      }
    }
    // Career Road commons for the regulars.
    for (let n = Math.floor(u.g / 25); n > 0; n--) mint(u.id, pick(roadDefs), 'common', 'road', u.created + r() * (u.last - u.created));
    const level = levelForXp(u.xp);
    st.stats.run(u.id, u.name, u.k, u.d, u.g, u.w, u.hs, u.k * 3 + u.d, u.k, u.g ? 38 + r() * 34 : 0, u.best, u.created, u.last, u.xp, level, Math.max(0, u.credits), Math.floor(r() * 4));
  }

  // Staff one-offs + an admin credit grant or two.
  const whales = [...players].sort((a, b) => b.g - a.g).slice(0, 6);
  for (const w of whales.slice(0, 3)) {
    const def = pick(ITEM_DEFS.filter((d) => d.slot === 'hat' && d.tradable && !d.default));
    const t = now - Math.floor(r() * 20 * DAY);
    mint(w.id, def, 'legendary', 'admin', t);
    st.audit.run(t, 'admin.mint', 'opsdeck', 'opsdeck', w.id, JSON.stringify({ def: def.id, n: 1 }));
  }
  st.audit.run(now - 6 * DAY, 'admin.grant_econ', 'opsdeck', 'opsdeck', whales[0].id, JSON.stringify({ credits: 2500, rolls: 5 }));

  // Redeem codes.
  const codes = [
    { code: 'LAUNCH-WEEK', note: 'Season 0 launch thank-you', reward: { credits: 500, rolls: 3 }, max: 0, min: 0, at: now - 84 * DAY, exp: now - 70 * DAY, share: 0.4 },
    { code: 'RAILDAY-2026', note: 'Community tournament', reward: { credits: 250, items: [{ def: 'hat.tophat', quality: ['unusual'], attrs: { effect: 'fx.sunbeams' }, bound: true }] }, max: 150, min: 5, at: now - 30 * DAY, exp: 0, share: 0.18 },
    { code: 'TRACKED-TEST', note: 'Tracked finish playtest', reward: { items: [{ def: 'gun.toxic', quality: ['strange'], attrs: { kills: 0 } }] }, max: 40, min: 10, at: now - 9 * DAY, exp: now + 5 * DAY, share: 0.06 },
    { code: 'DISCORD-1K', note: 'Discord hit 1,000 members', reward: { credits: 1000 }, max: 1000, min: 0, at: now - 3 * DAY, exp: now + 11 * DAY, share: 0.22 },
  ];
  for (const c of codes) {
    let uses = 0;
    for (const u of players) {
      if (u.created > (c.exp || now) || u.until < c.at || r() > c.share) continue;
      if (c.max && uses >= c.max) break;
      const t = Math.max(c.at, u.created) + Math.floor(r() * Math.max(DAY, Math.min(c.exp || now, now) - Math.max(c.at, u.created)));
      if (t >= now) continue;
      uses++;
      st.redeem.run(c.code, u.id, t);
      st.audit.run(t, 'code.redeem', u.id, u.name, c.code, JSON.stringify({ credits: (c.reward as { credits?: number }).credits ?? 0, rolls: (c.reward as { rolls?: number }).rolls ?? 0 }));
    }
    st.code.run(c.code, JSON.stringify(c.reward), c.note, c.max, uses, c.exp, c.min, c.code === 'LAUNCH-WEEK' ? 0 : 1, 'opsdeck', c.at);
  }

  // Feedback.
  const FB: [string, string, string, string][] = [
    ['bug', 'Rail beam invisible on Causeway skybox', 'Beam colour Arc Blue disappears against the blue sky near the north tower.', 'open'],
    ['bug', 'Tracked counter shows 000000 after trade', 'Traded a Tracked finish and it reset to zero on my side until I relogged.', 'ack'],
    ['feature', 'Spectator mode for duels', 'Would love to watch ranked duels between friends.', 'open'],
    ['feature', 'Crosshair editor', 'Please let us pick a dot / cross / circle crosshair.', 'resolved'],
    ['general', 'Movement feels amazing', 'Strafe jumping on Reactor is so good. Thanks!', 'resolved'],
    ['bug', 'Stuck on podium screen', 'After the match the podium never went away, had to refresh.', 'open'],
    ['bug', 'Hat clips through visor', 'The Captain’s Tricorn clips into the Sovereign Visor.', 'ack'],
    ['feature', 'Trade history export', 'A CSV of my trades would be handy.', 'open'],
    ['general', 'bestgame!!!', 'buy cheap credits at …', 'spam'],
    ['bug', 'Sound cuts out on alt-tab', 'Audio doesn’t come back after tabbing out mid-match.', 'open'],
    ['feature', 'More Anomalous taunt effects', 'Sakura Drift on emotes is great — more please.', 'open'],
  ];
  FB.forEach(([type, title, body, status], i) => {
    const u = pick(players);
    const t = now - Math.floor((i + 1) * 2.7 * DAY * r()) - Math.floor(r() * DAY);
    st.feedback.run(t, u.id, u.name, type, title, body, status, t);
  });

  // A week of per-minute concurrency, following the same prime-time curve and growth.
  const peakW = Math.max(...HOUR_W);
  for (let t = now - 7 * DAY; t <= now; t += MIN) {
    const h = new Date(t).getUTCHours() + new Date(t).getUTCMinutes() / 60;
    const w = HOUR_W[Math.floor(h)] + (HOUR_W[(Math.floor(h) + 1) % 24] - HOUR_W[Math.floor(h)]) * (h % 1);
    const growth = 0.85 + 0.15 * ((t - (now - 7 * DAY)) / (7 * DAY));
    const online = Math.max(0, Math.round((4 + 58 * (w / peakW)) * growth * (weekend(t) ? 1.18 : 1) + gauss() * 2.2));
    const inMatch = Math.max(0, Math.min(online, Math.round(online * (0.66 + r() * 0.12))));
    st.conc.run(t, online, inMatch, Math.max(inMatch > 0 ? 1 : 0, Math.round(inMatch / (4.5 + r()))));
  }
});
tx();

const m = db.prepare(`SELECT COUNT(*) AS n FROM instagib_audit WHERE event = 'match'`).get() as { n: number };
const it = db.prepare(`SELECT COUNT(*) AS n FROM instagib_items`).get() as { n: number };
console.log(`seeded ${PLAYERS} players, ${m.n} matches, ${it.n} items, 7d of concurrency → ${abs}`);
