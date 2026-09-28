// Cosmetic item thumbnails — a rendered still of each item (a hat on a head,
// a gun finish, a finisher mid-burst…) for the Locker grid, the end-of-match
// reward cards and the Career Road, cached as data URLs.
//
// STUB: returns null (callers render a rarity glyph fallback). The Locker track
// replaces this with a shared offscreen renderer; keep the API stable.

export function getThumbnail(id: string): Promise<string | null> {
  void id;
  return Promise.resolve(null);
}

// Synchronous cache peek (null until getThumbnail has resolved once).
export function peekThumbnail(id: string): string | null {
  void id;
  return null;
}
