// Canonical control list — the SINGLE source of truth shared by the Landing
// page, the first-run onboarding primer, and the in-match Click-to-Play hint, so
// they can never drift apart. (They used to disagree: Landing omitted the
// right-click boost, and neither surface taught the railgun recharge — the core
// "one shot, then wait" rhythm a new player has to feel.)
export const CONTROLS: ReadonlyArray<readonly [string, string]> = [
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
