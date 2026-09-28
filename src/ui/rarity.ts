// Rarity colour language + the thumbnail hook shared by item tiles.
import { useEffect, useState } from 'react';
import type { Rarity } from '../game/cosmetics';
import { getThumbnail, peekThumbnail } from '../game/thumbs';

export const RARITY_COLOR: Record<Rarity, { from: string; to: string; edge: string; text: string }> = {
  common: { from: '#4b5563', to: '#1f2937', edge: '#9ca3af', text: '#e5e7eb' },
  rare: { from: '#1d6fd8', to: '#0b2a57', edge: '#60a5fa', text: '#dbeafe' },
  epic: { from: '#8b2fd6', to: '#2e0b4d', edge: '#c084fc', text: '#f3e8ff' },
  legendary: { from: '#e07a12', to: '#4a2106', edge: '#fbbf24', text: '#fff7e6' },
};

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
