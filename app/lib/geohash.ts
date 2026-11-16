// Minimal geohash encode/decode. A 6-character cell is about 1.2 km x 0.6 km,
// precise enough to check a worker was near the task without putting exact
// coordinates on-chain.

const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';

export function encode(lat: number, lng: number, precision = 6): string {
  let latRange = [-90, 90];
  let lngRange = [-180, 180];
  let hash = '';
  let bit = 0;
  let ch = 0;
  let even = true;
  while (hash.length < precision) {
    const range = even ? lngRange : latRange;
    const value = even ? lng : lat;
    const mid = (range[0] + range[1]) / 2;
    if (value >= mid) {
      ch = (ch << 1) | 1;
      range[0] = mid;
    } else {
      ch = ch << 1;
      range[1] = mid;
    }
    if (even) lngRange = range;
    else latRange = range;
    even = !even;
    if (++bit === 5) {
      hash += BASE32[ch];
      bit = 0;
      ch = 0;
    }
  }
  return hash;
}

export function decode(hash: string): { lat: number; lng: number } {
  const latRange = [-90, 90];
  const lngRange = [-180, 180];
  let even = true;
  for (const c of hash.toLowerCase()) {
    const idx = BASE32.indexOf(c);
    if (idx < 0) throw new Error(`Invalid geohash: ${hash}`);
    for (let b = 4; b >= 0; b--) {
      const bitOn = (idx >> b) & 1;
      const range = even ? lngRange : latRange;
      const mid = (range[0] + range[1]) / 2;
      if (bitOn) range[0] = mid;
      else range[1] = mid;
      even = !even;
    }
  }
  return { lat: (latRange[0] + latRange[1]) / 2, lng: (lngRange[0] + lngRange[1]) / 2 };
}

/** Great-circle distance in km. */
export function distanceKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function isValid(hash: string): boolean {
  return hash.length > 0 && [...hash.toLowerCase()].every((c) => BASE32.includes(c));
}
