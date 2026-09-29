// ── Replay audio bridge ──────────────────────────────────────────────────────
//
// Turns the ReplayPlayer's events (shots, frags, other actors' movement) into
// sound on a SoundManager. Shared by the in-game killcam / Play of the Match and
// the standalone weekly-challenge rewatch, so both sound the same. All output is
// spatialised from the replay camera (the listener pose follows it), goes through
// the SFX bus (so master / SFX volume + mute apply), and is silent until the
// caller has started the replay treatment (`SoundManager.replayBegin`).
import type { SoundClipName, SoundManager } from './audio';
import type { ReplaySfx } from './replay';

// Announcer line for a multi-kill chain, by running count.
const CHAIN_LINE: Record<number, SoundClipName> = {
  2: 'double-kill',
  3: 'triple-kill',
  4: 'quad-kill',
  5: 'penta-kill',
};

export function makeReplaySfx(audio: SoundManager, opts: { announcer?: boolean } = {}): ReplaySfx {
  return {
    shot(s, star, lethal) {
      audio.replayShot(s.origin.x, s.origin.y, s.origin.z, star, star ? 0.85 : 0.9);
      // A miss (or a wall graze): the impact where the rail ended.
      if (!lethal) audio.replayImpact(s.end.x, s.end.y, s.end.z, 0.7);
    },
    kill(at, k, finisher, star, chain) {
      audio.replayGib(at.x, at.y, at.z, finisher, k.headshot, star, star ? 0.8 : 0.9);
      if (!star) return;
      // The star's own hit confirm (a higher double tick on a headshot)…
      audio.hitConfirm(k.headshot, 0.55);
      // …and, in Play of the Match, the announcer's callout for the chain.
      if (opts.announcer === false) return;
      const line = CHAIN_LINE[Math.min(5, chain)];
      if (chain >= 2 && line) audio.play(line, 0.9);
      else if (k.headshot) audio.play('headshot', 0.8);
    },
    move(kind, x, y, z, strength, star) {
      audio.replayMove(kind, x, y, z, strength, star);
    },
  };
}
