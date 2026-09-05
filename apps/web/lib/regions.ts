import { geolocation } from "@vercel/functions";
import { env } from "./env";
import type { Region } from "./schema";

export type { Region } from "./schema";

/** Approximate coordinates of each supported Vercel Sandbox region. */
export const REGION_COORDS: Record<Region, { lat: number; lon: number }> = {
  iad1: { lat: 38.95, lon: -77.45 }, // Washington, D.C.
  sfo1: { lat: 37.77, lon: -122.42 }, // San Francisco
  cle1: { lat: 41.5, lon: -81.7 }, // Cleveland
  cdg1: { lat: 49.0, lon: 2.55 }, // Paris
};

/** All supported regions, in the order the dashboard lists them. */
export const REGIONS: Region[] = ["iad1", "sfo1", "cle1", "cdg1"];

function haversineKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** The region nearest to a latitude/longitude pair. */
export function nearestRegionTo(point: { lat: number; lon: number }): Region {
  let best: Region = env().ZS_DEFAULT_REGION;
  let bestKm = Number.POSITIVE_INFINITY;
  for (const region of REGIONS) {
    const km = haversineKm(point, REGION_COORDS[region]);
    if (km < bestKm) {
      bestKm = km;
      best = region;
    }
  }
  return best;
}

/**
 * Picks the region nearest to the requester using Vercel's geolocation
 * headers; falls back to `ZS_DEFAULT_REGION` when the headers are absent
 * (local development).
 */
export function nearestRegion(req: Request): Region {
  const geo = geolocation(req);
  const lat = geo.latitude !== undefined ? Number(geo.latitude) : Number.NaN;
  const lon = geo.longitude !== undefined ? Number(geo.longitude) : Number.NaN;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return env().ZS_DEFAULT_REGION;
  return nearestRegionTo({ lat, lon });
}
