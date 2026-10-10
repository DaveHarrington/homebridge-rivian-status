'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { toStatus, chargeInfo } = require('../dist/state');
const { VEHICLE_STATE } = require('./mockRivian');

test('maps a full vehicle state', () => {
  assert.deepEqual(toStatus(VEHICLE_STATE), {
    batteryPercent: 73,
    charging: true,
    pluggedIn: true,
    chargePortOpen: true,
    rangeKm: 402.3,
    locked: false, // one rear door is unlocked
    doorsOpen: false,
    windowsOpen: true,
    frunkOpen: false,
    liftgateOpen: true,
    tailgateOpen: undefined,
    tonneauOpen: undefined,
    cabinTempC: 21.5,
  });
});

test('missing fields stay unknown instead of defaulting', () => {
  const s = toStatus({});
  assert.equal(s.batteryPercent, undefined);
  assert.equal(s.locked, undefined);
  assert.equal(s.doorsOpen, undefined);
  assert.equal(s.pluggedIn, undefined);
  assert.equal(s.charging, false);
});

test('charger status distinguishes plugged-in idle from charging', () => {
  assert.deepEqual(chargeInfo('chrgr_sts_connected_no_chrg', 'charging_ready'), { charging: false, pluggedIn: true });
  assert.deepEqual(chargeInfo('chrgr_sts_not_connected', undefined), { charging: false, pluggedIn: false });
  assert.deepEqual(chargeInfo(undefined, 'charging_active_dc'), { charging: true, pluggedIn: undefined });
  assert.deepEqual(chargeInfo(undefined, 'charging_ready'), { charging: false, pluggedIn: undefined });
});

test('all doors locked reads as locked; string booleans are understood', () => {
  const s = toStatus({
    doorFrontLeftLocked: 'locked', doorFrontRightLocked: 'true', doorRearLeftLocked: 'locked', doorRearRightLocked: null,
    closureFrunkClosed: 'false',
  });
  assert.equal(s.locked, true);
  assert.equal(s.frunkOpen, true);
});
