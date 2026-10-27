import * as Location from 'expo-location';
import { useCallback, useEffect, useRef, useState } from 'react';
import { GPS_WAIT_MS, betterFix, gpsStatus, type GpsFix } from '@vecdim/validator';

/**
 * GPS capture for the form (docs/field_form_spec.md): ask for the most accurate fix, show its accuracy,
 * keep the best reading for up to 60 s, and let the user recapture at any time.
 * `restore` puts back a fix saved in a draft without starting a new search.
 */
export function useGps(initial: GpsFix | null) {
  const [fix, setFix] = useState<GpsFix | null>(initial);
  const [elapsed, setElapsed] = useState(initial ? GPS_WAIT_MS : 0);
  const [permission, setPermission] = useState<'unknown' | 'granted' | 'denied'>('unknown');
  const [searching, setSearching] = useState(false);
  const best = useRef<GpsFix | null>(initial);
  const sub = useRef<Location.LocationSubscription | null>(null);
  const startedAt = useRef(Date.now());
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const stop = useCallback(() => {
    sub.current?.remove();
    sub.current = null;
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    setSearching(false);
  }, []);

  const start = useCallback(async () => {
    stop();
    best.current = null;
    setFix(null);
    setElapsed(0);
    startedAt.current = Date.now();
    const perm = await Location.requestForegroundPermissionsAsync();
    if (perm.status !== 'granted') {
      setPermission('denied');
      return;
    }
    setPermission('granted');
    setSearching(true);
    timer.current = setInterval(() => {
      const ms = Date.now() - startedAt.current;
      setElapsed(ms);
      if (ms >= GPS_WAIT_MS) stop();
    }, 1000);
    try {
      sub.current = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.BestForNavigation, timeInterval: 1000, distanceInterval: 0 },
        (loc) => {
          const reading: GpsFix = {
            latitude: loc.coords.latitude,
            longitude: loc.coords.longitude,
            accuracy: loc.coords.accuracy ?? null,
          };
          best.current = betterFix(best.current, reading);
          setFix(best.current);
          // 10 m or better: accept and stop trying
          if (best.current.accuracy !== null && best.current.accuracy <= 10) stop();
        },
      );
    } catch {
      stop();
    }
  }, [stop]);

  useEffect(() => stop, [stop]);

  /** Inject a reading (test tools). It replaces the current fix instead of competing with it. */
  const simulate = useCallback(
    (reading: GpsFix) => {
      stop();
      best.current = reading;
      setFix(reading);
      setElapsed(0);
      startedAt.current = Date.now();
      if (reading.accuracy === null || reading.accuracy > 10) {
        // behave like a real search: keep the 60 s window running so the "waiting" and "poor" states can be seen
        timer.current = setInterval(() => {
          const ms = Date.now() - startedAt.current;
          setElapsed(ms);
          if (ms >= GPS_WAIT_MS) stop();
        }, 1000);
        setSearching(true);
      }
    },
    [stop],
  );

  const status = gpsStatus(fix, elapsed);
  return { fix, status, permission, searching, start, simulate, stop };
}
