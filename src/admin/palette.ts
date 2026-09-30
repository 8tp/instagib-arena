// Chart + label constants shared by the admin tabs.

// Validated categorical order on the console surface #0c1016 (dataviz
// validator: adjacent CVD ΔE ≥ 8.4, normal-vision ≥ 19.3, all ≥ 3:1 contrast).
export const SERIES = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9'] as const;

export const MODE_LABEL: Record<string, string> = { ffa: 'FFA', duel: 'Duel', tdm: 'TDM', ranked: 'Ranked', practice: 'Practice', unknown: 'Unknown' };
