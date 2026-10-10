'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startMock } = require('./mockRivian');

let mock;
let RivianClient;
let STATE_PROPERTIES;

test.before(async () => {
  mock = await startMock();
  process.env.RIVIAN_GRAPHQL_URL = mock.url;
  ({ RivianClient } = require('../dist/rivianClient'));
  ({ STATE_PROPERTIES } = require('../dist/state'));
});
test.after(() => mock.close());

test('MFA sign-in, vehicle list and state read', async () => {
  const client = new RivianClient();
  await client.createSession();
  assert.deepEqual(await client.login('me@example.com', 'pw'), { otpRequired: true });
  await client.loginWithOtp('me@example.com', '123456');
  assert.equal(client.getTokens().userSessionToken, 'user-sess');

  const vehicles = await client.getVehicles();
  assert.deepEqual(vehicles, [{ id: 'veh1', vin: '7PDSGBBA0SN000001', name: 'Rocinante', make: 'Rivian', model: 'R1S', modelYear: 2025 }]);

  const state = await client.getVehicleState('veh1', STATE_PROPERTIES);
  assert.equal(state.batteryLevel.value, 72.6);
  assert.equal(state.closureTailgateClosed, null);

  const read = mock.calls.find((c) => c.operationName === 'GetVehicleState');
  assert.equal(read.headers['u-sess'], 'user-sess');
  assert.equal(read.headers['a-sess'], 'app-sess');
  assert.equal(read.variables.vehicleID, 'veh1');
});

test('wrong password and bad session surface as typed errors', async () => {
  const client = new RivianClient();
  await assert.rejects(client.login('me@example.com', 'nope'), (err) => err.isAuthError && /Bad credentials/.test(err.message));

  const stale = new RivianClient({ accessToken: '', refreshToken: '', userSessionToken: 'expired' });
  await stale.createSession();
  await assert.rejects(stale.getVehicleState('veh1', STATE_PROPERTIES), (err) => err.isAuthError);
});

test('wrong OTP code is rejected', async () => {
  const client = new RivianClient();
  await client.login('me@example.com', 'pw');
  await assert.rejects(client.loginWithOtp('me@example.com', '000000'), /Invalid code/);
});
