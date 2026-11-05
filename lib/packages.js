// Single source of truth for pricing. Mirrors the "Content Packages for the GTA"
// and "$20 Walk-in Special" story highlights. Amounts are in cents (CAD).
const PACKAGES = [
  { key: 'walkin', group: 'walkin', name: '$20 Walk-in Special', price: 2000,
    detail: 'We walk into your shop, shoot, and you unlock the full set for $20 per barber.' },

  { key: 'starter', group: 'photography', name: 'Starter Shoot', price: 10000,
    detail: '1 hour · 1 location · unlimited edited photos' },
  { key: 'standard', group: 'photography', name: 'Standard Shoot', price: 22500,
    detail: '2 hours · up to 2 looks · unlimited edited photos' },
  { key: 'premium', group: 'photography', name: 'Premium Shoot', price: 40000,
    detail: '3 hours · multiple looks · unlimited edited photos · usage rights' },

  { key: 'reel', group: 'videography', name: 'Reel Package', price: 15000,
    detail: '1 shoot · unlimited edited reels · 1 revision' },
  { key: 'content_day', group: 'videography', name: 'Content Day', price: 50000,
    detail: 'Half day · unlimited edited reels/clips' },
  { key: 'full_production', group: 'videography', name: 'Full Production', price: 90000,
    detail: 'Full day · unlimited edited videos + photos' },
];

const ADDONS = [
  { key: 'rush', name: 'Rush editing (48-hr turnaround)', price: 7500 },
  { key: 'extra_location', name: 'Additional location', price: 10000 },
  { key: 'raw', name: 'Raw/unedited files', price: 15000 },
];

const byKey = (list, key) => list.find((p) => p.key === key);

module.exports = {
  PACKAGES,
  ADDONS,
  getPackage: (k) => byKey(PACKAGES, k),
  getAddon: (k) => byKey(ADDONS, k),
};
