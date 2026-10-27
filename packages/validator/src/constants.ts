// Constants copied from docs/validation_rules.md and R/helpers.R.

export const NIGERIA = { latMin: 4, latMax: 14, lonMin: 2.5, lonMax: 15 } as const;

export const STATE_BOX: Record<string, { latMin: number; latMax: number; lonMin: number; lonMax: number }> = {
  Lagos: { latMin: 6.3, latMax: 6.8, lonMin: 2.7, lonMax: 4.4 },
  Kano: { latMin: 11.5, latMax: 12.6, lonMin: 8.0, lonMax: 9.2 },
  Osun: { latMin: 7.0, latMax: 8.2, lonMin: 4.0, lonMax: 5.0 },
};

export const LGAS: Record<string, string[]> = {
  Lagos: ['Ikorodu', 'Alimosho', 'Epe', 'Badagry', 'Eti-Osa'],
  Kano: ['Dala', 'Nasarawa', 'Gwale', 'Tarauni', 'Ungogo'],
  Osun: ['Osogbo', 'Ife Central', 'Ilesa East', 'Iwo', 'Ede North'],
};

// Same values as data/lga_reference.csv
export const LGA_REF: Record<string, { lat: number; lon: number }> = {
  'Lagos|Ikorodu': { lat: 6.62, lon: 3.51 },
  'Lagos|Alimosho': { lat: 6.6, lon: 3.25 },
  'Lagos|Epe': { lat: 6.58, lon: 3.98 },
  'Lagos|Badagry': { lat: 6.43, lon: 2.88 },
  'Lagos|Eti-Osa': { lat: 6.45, lon: 3.6 },
  'Kano|Dala': { lat: 12.0, lon: 8.52 },
  'Kano|Nasarawa': { lat: 12.0, lon: 8.55 },
  'Kano|Gwale': { lat: 11.98, lon: 8.49 },
  'Kano|Tarauni': { lat: 11.97, lon: 8.54 },
  'Kano|Ungogo': { lat: 12.05, lon: 8.48 },
  'Osun|Osogbo': { lat: 7.77, lon: 4.56 },
  'Osun|Ife Central': { lat: 7.48, lon: 4.56 },
  'Osun|Ilesa East': { lat: 7.62, lon: 4.73 },
  'Osun|Iwo': { lat: 7.63, lon: 4.18 },
  'Osun|Ede North': { lat: 7.74, lon: 4.43 },
};

export const LGA_MAX_KM = 25;
export const GPS_TARGET_M = 10;
export const GPS_UNUSABLE_M = 50;

export const SPECIES = ['An. gambiae s.s.', 'An. coluzzii', 'An. arabiensis', 'An. funestus'] as const;
export const INSECTICIDES = ['Permethrin', 'Deltamethrin', 'Alphacypermethrin', 'Pirimiphos-methyl'] as const;

/** Reference date of the parity test (the brief fixes it so results are reproducible). */
export const PARITY_REF_DATE = '2026-10-08';
