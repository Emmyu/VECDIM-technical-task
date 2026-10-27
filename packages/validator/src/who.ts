export type WhoClass = 'Susceptible' | 'Possible resistance' | 'Resistant';

/**
 * Rounds to 1 decimal the way R's round(x, 1) does for exact ties (half to even),
 * so the class is computed from the same number as R/02_descriptive_analysis.R.
 */
export function round1(x: number): number {
  const scaled = x * 10;
  const floor = Math.floor(scaled);
  const diff = scaled - floor;
  if (Math.abs(diff - 0.5) < 1e-9) return (floor % 2 === 0 ? floor : floor + 1) / 10;
  return Math.round(scaled) / 10;
}

/** 100 x n_dead / n_exposed rounded to 1 decimal, or null when it cannot be computed. */
export function mortalityPct(nDead: number | null | undefined, nExposed: number | null | undefined): number | null {
  if (nDead == null || nExposed == null || !Number.isFinite(nDead) || !Number.isFinite(nExposed) || nExposed <= 0) {
    return null;
  }
  return round1((100 * nDead) / nExposed);
}

/** WHO tube-test class from the already-rounded mortality. No Abbott correction. */
export function whoClass(mortality: number | null): WhoClass | null {
  if (mortality == null) return null;
  if (mortality >= 98) return 'Susceptible';
  if (mortality >= 90) return 'Possible resistance';
  return 'Resistant';
}
