// Rarity colour language + the thumbnail hook shared by item tiles.
import { useEffect, useState } from 'react';
import type { Rarity } from '../game/cosmetics';
import { getThumbnail, peekThumbnail } from '../game/thumbs';

// Fortnite-style tiers: grey / blue / purple / gold. `from`/`to` = the tile's
// radial backdrop, `edge` = the rim / bar / glow, `text` = label on the tile.
export const RARITY_COLOR: Record<Rarity, { from: string; to: string; edge: string; text: string }> = {
  common: { from: '#56606e', to: '#1c222b', edge: '#a3adbb', text: '#eef1f5' },
  rare: { from: '#1f78e6', to: '#0a2450', edge: '#5fb0ff', text: '#e2efff' },
  epic: { from: '#9335e0', to: '#2a0a48', edge: '#cc8cff', text: '#f5eaff' },
  legendary: { from: '#e8850f', to: '#4a1d04', edge: '#ffc23d', text: '#fff6e0' },
};

export const RARITY_LABEL: Record<Rarity, string> = {
  common: 'Common',
  rare: 'Rare',
  epic: 'Epic',
  legendary: 'Legendary',
};

// Sort key: higher = rarer.
export const RARITY_RANK: Record<Rarity, number> = { common: 0, rare: 1, epic: 2, legendary: 3 };

export function useThumbnail(id: string): string | null {
  const [url, setUrl] = useState<string | null>(() => peekThumbnail(id));
  useEffect(() => {
    let live = true;
    setUrl(peekThumbnail(id));
    void getThumbnail(id).then((u) => {
      if (live) setUrl(u);
    });
    return () => {
      live = false;
    };
  }, [id]);
  return url;
}
