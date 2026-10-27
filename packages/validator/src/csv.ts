/** Minimal CSV parser (RFC 4180 quotes). Returns rows of objects keyed by the header row. */
export function parseCsv(textIn: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  const s = textIn.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQuotes = false;
      } else cell += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(cell);
      cell = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else cell += ch;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  const [header, ...body] = rows;
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

/** The CSV marks missing values as NA (or an empty cell). Numeric columns become numbers; the rest stay text. */
export function csvRowToRecord(row: Record<string, string>, numeric: string[]): Record<string, string | number | null> {
  const out: Record<string, string | number | null> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v === 'NA' || v === '') out[k] = null;
    else out[k] = numeric.includes(k) ? Number(v) : v;
  }
  return out;
}

export const NUMERIC_COLUMNS = [
  'latitude', 'longitude', 'n_exposed', 'n_dead', 'mortality_pct', 'larval_density', 'rainfall_mm', 'temp_c',
  'ndvi', 'elevation_m', 'dist_water_km', 'urban', 'itn_use_pct', 'irs_covered', 'slide_positivity_pct', 'high_risk',
];
