/* ── Player badges: staff crown + verified blue check. Server-authoritative —
   these components are purely presentational. Shown beside player names on the
   scoreboard, the leaderboard, and the playercard. (Extensible: future badges
   slot in here.) ── */
export function VerifiedBadge({ size = 13 }: { size?: number }) {
  return (
    <svg
      width={size} height={size} viewBox='0 0 24 24' role='img' aria-label='Verified'
      className='inline-block shrink-0 align-[-0.15em]'
    >
      <title>Verified</title>
      <circle cx='12' cy='12' r='11' fill='#3b9eff' />
      <path
        d='M6.5 12.5l3.4 3.4L17.6 8.4' fill='none' stroke='#fff' strokeWidth='2.5'
        strokeLinecap='round' strokeLinejoin='round'
      />
    </svg>
  );
}
export function AdminBadge({ size = 13 }: { size?: number }) {
  return (
    <svg
      width={size} height={size} viewBox='0 0 24 24' role='img' aria-label='Staff'
      className='inline-block shrink-0 align-[-0.15em]'
    >
      <title>Staff</title>
      <path
        d='M2.6 8.4l4 3.3L12 4.6l5.4 7.1 4-3.3-1.7 10H4.3z'
        fill='#ffcf3f' stroke='#7a5a10' strokeWidth='1.1' strokeLinejoin='round'
      />
      <circle cx='2.6' cy='8.4' r='1.4' fill='#ffe79a' stroke='#7a5a10' strokeWidth='0.7' />
      <circle cx='21.4' cy='8.4' r='1.4' fill='#ffe79a' stroke='#7a5a10' strokeWidth='0.7' />
      <circle cx='12' cy='4.6' r='1.5' fill='#ffe79a' stroke='#7a5a10' strokeWidth='0.7' />
    </svg>
  );
}
// Crown (admin) then check (verified), placed to the right of a player name.
export function NameBadges({
  admin,
  verified,
  size,
}: {
  admin?: boolean;
  verified?: boolean;
  size?: number;
}) {
  if (!admin && !verified) return null;
  return (
    <span className='inline-flex shrink-0 items-center gap-0.5'>
      {admin && <AdminBadge size={size} />}
      {verified && <VerifiedBadge size={size} />}
    </span>
  );
}
