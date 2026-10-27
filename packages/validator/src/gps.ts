import { GPS_TARGET_M, GPS_UNUSABLE_M } from './constants';

/** One position reading from the phone (for example Expo Location's coords). */
export interface GpsFix {
  latitude: number;
  longitude: number;
  /** Horizontal accuracy radius in metres; null when the phone did not report one. */
  accuracy: number | null;
}

/** How long the app keeps trying for a fix of 10 m or better (docs/field_form_spec.md). */
export const GPS_WAIT_MS = 60_000;

export type GpsPhase =
  | 'none' //       no reading yet
  | 'accepted' //   10 m or better: accept the fix, stop trying
  | 'improving' //  worse than 10 m, still within the 60 s window: keep trying, the user may already continue
  | 'poor' //       worse than 10 m after 60 s: the user may continue, saved with the GPS_accuracy_poor warning
  | 'unusable'; //  worse than 50 m or no accuracy value: cannot be saved

export interface GpsStatus {
  phase: GpsPhase;
  /** Message to show next to the coordinates. */
  message: string;
  /** Keep listening for a better fix. */
  keepTrying: boolean;
  /** The Save button may be used (the Block rules still run when Save is tapped). */
  canSave: boolean;
}

/** The better of two fixes: lower accuracy radius wins; a fix without accuracy never beats one with it. */
export function betterFix(current: GpsFix | null, next: GpsFix): GpsFix {
  if (!current) return next;
  if (next.accuracy === null) return current;
  if (current.accuracy === null) return next;
  return next.accuracy < current.accuracy ? next : current;
}

export function gpsStatus(fix: GpsFix | null, elapsedMs: number): GpsStatus {
  const waited = elapsedMs >= GPS_WAIT_MS;
  if (!fix) {
    return { phase: 'none', message: 'Getting your location… Move to open sky.', keepTrying: !waited, canSave: false };
  }
  const acc = fix.accuracy;
  if (acc === null || !Number.isFinite(acc)) {
    return {
      phase: 'unusable',
      message: 'The phone gave no GPS accuracy value, so this location cannot be saved. Move to open sky and recapture.',
      keepTrying: !waited,
      canSave: false,
    };
  }
  if (acc <= GPS_TARGET_M) {
    return { phase: 'accepted', message: `Accuracy: ${round(acc)} m. Location accepted.`, keepTrying: false, canSave: true };
  }
  if (acc > GPS_UNUSABLE_M) {
    return {
      phase: 'unusable',
      message: `Accuracy: ${round(acc)} m is worse than ${GPS_UNUSABLE_M} m, so this location cannot be saved. Move to open sky and recapture.`,
      keepTrying: !waited,
      canSave: false,
    };
  }
  if (!waited) {
    return {
      phase: 'improving',
      message: `Accuracy: ${round(acc)} m. Waiting for a better GPS signal. Move to open sky.`,
      keepTrying: true,
      canSave: true,
    };
  }
  return {
    phase: 'poor',
    message: `Accuracy: ${round(acc)} m (target ${GPS_TARGET_M} m or better). You can continue; the record will be saved with a GPS warning, or recapture the location.`,
    keepTrying: false,
    canSave: true,
  };
}

const round = (n: number) => Math.round(n * 10) / 10;
