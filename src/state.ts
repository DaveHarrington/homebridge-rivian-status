import type { RawVehicleState } from './rivianClient';

/** Scalar vehicle-state fields this plugin reads. Each resolves to `{ timeStamp, value }`. */
export const STATE_PROPERTIES = [
  'batteryLevel',
  'batteryLimit',
  'distanceToEmpty',
  'chargerState',
  'chargerStatus',
  'chargePortState',
  'timeToEndOfCharge',
  'doorFrontLeftLocked',
  'doorFrontRightLocked',
  'doorRearLeftLocked',
  'doorRearRightLocked',
  'doorFrontLeftClosed',
  'doorFrontRightClosed',
  'doorRearLeftClosed',
  'doorRearRightClosed',
  'windowFrontLeftClosed',
  'windowFrontRightClosed',
  'windowRearLeftClosed',
  'windowRearRightClosed',
  'closureFrunkClosed',
  'closureLiftgateClosed',
  'closureTailgateClosed',
  'closureTonneauClosed',
  'cabinClimateInteriorTemperature',
  'powerState',
] as const;

export type StateKey = (typeof STATE_PROPERTIES)[number];
export type VehicleValues = Partial<Record<StateKey, unknown>>;

/** The plugin's view of a vehicle. `undefined` means Rivian didn't report it. */
export interface VehicleStatus {
  batteryPercent?: number;
  charging: boolean;
  pluggedIn?: boolean;
  chargePortOpen?: boolean;
  rangeKm?: number;
  locked?: boolean;
  doorsOpen?: boolean;
  windowsOpen?: boolean;
  frunkOpen?: boolean;
  liftgateOpen?: boolean;
  tailgateOpen?: boolean;
  tonneauOpen?: boolean;
  cabinTempC?: number;
}

export function flattenState(raw: RawVehicleState): VehicleValues {
  const out: VehicleValues = {};
  for (const [key, entry] of Object.entries(raw)) {
    out[key as StateKey] = entry?.value ?? undefined;
  }
  return out;
}

function str(value: unknown): string | undefined {
  return value === undefined || value === null || value === '' ? undefined : String(value).toLowerCase();
}

function num(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

// Some fields report booleans as strings: for a `...Closed` field, 'true' means closed.
const OPEN_VALUES = new Set(['open', 'opened', 'unlatched', 'ajar', 'false']);
const CLOSED_VALUES = new Set(['closed', 'close', 'latched', 'true']);

/** true when open, false when closed, undefined when unknown. */
export function isOpen(value: unknown): boolean | undefined {
  const v = str(value);
  if (v === undefined) {
    return undefined;
  }
  if (OPEN_VALUES.has(v)) {
    return true;
  }
  return CLOSED_VALUES.has(v) ? false : undefined;
}

export function isLocked(value: unknown): boolean | undefined {
  const v = str(value);
  if (v === undefined) {
    return undefined;
  }
  if (v === 'locked' || v === 'true') {
    return true;
  }
  return v === 'unlocked' || v === 'false' ? false : undefined;
}

/** Combines several closures: open if any is open, closed only if every known one is closed. */
function anyOpen(values: unknown[]): boolean | undefined {
  const known = values.map(isOpen).filter((v): v is boolean => v !== undefined);
  return known.length ? known.some(Boolean) : undefined;
}

/** Locked only if every known door is locked. */
function allLocked(values: unknown[]): boolean | undefined {
  const known = values.map(isLocked).filter((v): v is boolean => v !== undefined);
  return known.length ? known.every(Boolean) : undefined;
}

/**
 * `chargerStatus` is the reliable charging signal: `chrgr_sts_connected_charging`
 * while charging, `chrgr_sts_connected_no_chrg` when plugged in but idle, and
 * `chrgr_sts_not_connected` when unplugged. `chargerState` has values like
 * `charging_ready`, which means plugged in, not charging, so it is a fallback only.
 */
export function chargeInfo(chargerStatus: unknown, chargerState: unknown): { charging: boolean; pluggedIn?: boolean } {
  const status = str(chargerStatus);
  if (status) {
    return {
      charging: status.includes('connected_charging'),
      pluggedIn: !status.includes('not_connected'),
    };
  }
  const state = str(chargerState);
  return {
    charging: state !== undefined && state.startsWith('charging_active'),
    pluggedIn: undefined,
  };
}

export function toStatus(v: VehicleValues): VehicleStatus {
  const battery = num(v.batteryLevel);
  return {
    batteryPercent: battery === undefined ? undefined : Math.max(0, Math.min(100, Math.round(battery))),
    ...chargeInfo(v.chargerStatus, v.chargerState),
    chargePortOpen: isOpen(v.chargePortState),
    rangeKm: num(v.distanceToEmpty),
    locked: allLocked([v.doorFrontLeftLocked, v.doorFrontRightLocked, v.doorRearLeftLocked, v.doorRearRightLocked]),
    doorsOpen: anyOpen([v.doorFrontLeftClosed, v.doorFrontRightClosed, v.doorRearLeftClosed, v.doorRearRightClosed]),
    windowsOpen: anyOpen([v.windowFrontLeftClosed, v.windowFrontRightClosed, v.windowRearLeftClosed, v.windowRearRightClosed]),
    frunkOpen: isOpen(v.closureFrunkClosed),
    liftgateOpen: isOpen(v.closureLiftgateClosed),
    tailgateOpen: isOpen(v.closureTailgateClosed),
    tonneauOpen: isOpen(v.closureTonneauClosed),
    cabinTempC: num(v.cabinClimateInteriorTemperature),
  };
}
