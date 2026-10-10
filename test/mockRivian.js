'use strict';
// A stand-in for Rivian's GraphQL gateway, for tests and local runs.
const http = require('node:http');

const VEHICLE_STATE = {
  batteryLevel: 72.6,
  distanceToEmpty: 402.3,
  chargerStatus: 'chrgr_sts_connected_charging',
  chargerState: 'charging_active',
  chargePortState: 'open',
  doorFrontLeftLocked: 'locked',
  doorFrontRightLocked: 'locked',
  doorRearLeftLocked: 'locked',
  doorRearRightLocked: 'unlocked',
  doorFrontLeftClosed: 'closed',
  doorFrontRightClosed: 'closed',
  doorRearLeftClosed: 'closed',
  doorRearRightClosed: 'closed',
  windowFrontLeftClosed: 'closed',
  windowFrontRightClosed: 'open',
  windowRearLeftClosed: 'closed',
  windowRearRightClosed: 'closed',
  closureFrunkClosed: 'closed',
  closureLiftgateClosed: 'open',
  closureTailgateClosed: null,
  closureTonneauClosed: null,
  cabinClimateInteriorTemperature: 21.5,
  powerState: 'sleep',
};

function startMock({ mfa = true, state = VEHICLE_STATE } = {}) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const { operationName, variables, query } = JSON.parse(body);
      calls.push({ operationName, variables, query, headers: req.headers });
      const send = (obj) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(obj));
      };
      const authed = req.headers['u-sess'] === 'user-sess';
      switch (operationName) {
        case 'CreateCSRFToken':
          return send({ data: { createCsrfToken: { csrfToken: 'csrf', appSessionToken: 'app-sess' } } });
        case 'Login':
          if (variables.password !== 'pw') {
            return send({ errors: [{ message: 'Bad credentials', extensions: { code: 'UNAUTHENTICATED' } }], data: null });
          }
          return send({ data: { login: mfa ? { otpToken: 'otp-tok' } : tokens() } });
        case 'LoginWithOTP':
          if (variables.otpCode !== '123456' || variables.otpToken !== 'otp-tok') {
            return send({ errors: [{ message: 'Invalid code', extensions: { code: 'BAD_USER_INPUT' } }], data: null });
          }
          return send({ data: { loginWithOTP: tokens() } });
        case 'getUserInfo':
          if (!authed) return unauth(send);
          return send({ data: { currentUser: { id: 'u1', vehicles: [
            { id: 'veh1', vin: '7PDSGBBA0SN000001', name: 'Rocinante', vehicle: { modelYear: 2025, make: 'Rivian', model: 'R1S' } },
          ] } } });
        case 'GetVehicleState': {
          if (!authed) return unauth(send);
          const vehicleState = {};
          for (const m of query.matchAll(/(\w+) \{ timeStamp value \}/g)) {
            const v = state[m[1]];
            vehicleState[m[1]] = v === undefined || v === null ? null : { timeStamp: '2026-10-09T12:00:00Z', value: v };
          }
          return send({ data: { vehicleState } });
        }
        default:
          return send({ errors: [{ message: `unknown op ${operationName}` }] });
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    resolve({ url: `http://127.0.0.1:${server.address().port}/graphql`, calls, close: () => { server.closeAllConnections(); server.close(); } });
  }));
}

function tokens() {
  return { accessToken: 'access', refreshToken: 'refresh', userSessionToken: 'user-sess' };
}

function unauth(send) {
  send({ errors: [{ message: 'Unauthenticated', extensions: { code: 'UNAUTHENTICATED' } }], data: null });
}

module.exports = { startMock, VEHICLE_STATE };

if (require.main === module) {
  startMock().then((m) => console.log(m.url));
}
