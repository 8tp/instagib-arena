// Username moderation for account registration. This is the ONLY place a human
// picks a name: in-game display names are server-assigned (the account username,
// or "Guest N" for guests — see server/instagib-game.ts), so guarding the
// register endpoint keeps slurs and profanity off the scoreboard, killfeed, and
// leaderboard everywhere they could be seen.
//
// The filter is deliberately blunt: it normalizes a name (lowercase, undo common
// leetspeak, drop every non-letter) and also collapses repeated letters, then
// substring-matches a curated blocklist. That trades some false positives (an
// offensive fragment inside a longer innocuous word — "spic" in "auspicious",
// "rape" in "grape") for resilience against padding/leet evasion. The blocklist
// below is the one knob to tune; it skews to unambiguous slurs + strong profanity
// and intentionally omits high-collateral short words (e.g. "ass").

// Common leetspeak → letter. Applied before non-letters are stripped, so
// "n1gg3r" / "f@ggot" canonicalize to their plain spelling. (Usernames are
// [A-Za-z0-9_], so the symbol entries only matter if this is reused elsewhere.)
const LEET: Record<string, string> = {
  '0': 'o',
  '1': 'i',
  '!': 'i',
  '|': 'i',
  '3': 'e',
  '4': 'a',
  '@': 'a',
  '5': 's',
  '$': 's',
  '6': 'g',
  '7': 't',
  '9': 'g',
};

// lowercase + leet-fold + strip anything that isn't a letter.
function canon(s: string): string {
  let out = '';
  for (const ch of s.toLowerCase()) out += LEET[ch] ?? ch;
  return out.replace(/[^a-z]/g, '');
}

// Collapse runs of the same letter to one ("niiigger" → "niger") so elongation
// can't slip a term past the plain check.
const squeeze = (s: string): string => s.replace(/(.)\1+/g, '$1');

// Curated blocklist (natural spelling). Slurs first, then strong profanity, then
// violence/extremism. Tune here.
const BLOCKLIST: readonly string[] = [
  // racial / ethnic / religious slurs
  'nigger', 'nigga', 'niglet', 'chink', 'spic', 'kike', 'gook', 'coon',
  'beaner', 'wetback', 'raghead', 'towelhead', 'jigaboo', 'darkie', 'darky',
  'kaffir', 'redskin',
  // homophobic / transphobic
  'faggot', 'fagot', 'dyke', 'tranny', 'shemale',
  // ableist
  'retard', 'retarded',
  // sexual / strong profanity
  'fuck', 'shit', 'cunt', 'bitch', 'pussy', 'whore', 'slut', 'dildo', 'wank',
  'jizz', 'bukkake',
  // violence / extremism
  'rape', 'rapist', 'molest', 'pedo', 'paedo', 'nazi', 'hitler', 'kkk',
  'incest', 'bestiality',
];

// Pre-squeezed terms (length-gated below) so elongated/leet variants are caught
// without the squeezed form colliding with short innocuous strings.
const SQUEEZED = BLOCKLIST.map(squeeze);

// True if `name` contains a blocklisted term after normalization. Checks both the
// canonical form (exact-ish, catches leet) and the squeezed form (catches
// elongation); the squeezed check is gated to terms ≥4 chars so short words like
// "coon"→"con" don't start matching "control".
export function containsProfanity(name: string): boolean {
  const n = canon(name);
  if (!n) return false;
  const sq = squeeze(n);
  for (let i = 0; i < BLOCKLIST.length; i++) {
    if (n.includes(BLOCKLIST[i])) return true;
    const st = SQUEEZED[i];
    if (st.length >= 4 && sq.includes(st)) return true;
  }
  return false;
}

// Names reserved so a registered account can't impersonate staff or a guest slot
// (guests render as "Guest N"). Checked case-insensitively on the raw username.
const RESERVED = new Set([
  'admin', 'administrator', 'moderator', 'mod', 'staff', 'server', 'system',
  'owner', 'root', 'null', 'undefined', 'console', 'everyone', 'bot',
]);

export function isReservedName(name: string): boolean {
  const l = name.trim().toLowerCase();
  return RESERVED.has(l) || l.startsWith('guest');
}
