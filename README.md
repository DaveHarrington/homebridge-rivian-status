# homebridge-rivian-status

Read-only Rivian status in Apple Home, through Rivian's cloud API. It works with Gen1 and Gen2 vehicles because it
only reads state: it sends no vehicle commands, so it needs no phone key and no Bluetooth pairing.

> Unofficial. Not affiliated with Rivian. It uses the private GraphQL API the Rivian app uses, which can change
> without notice.

## What shows up in Home

The vehicle's own accessory holds only the lock. Every other sensor is a separate accessory named after the
vehicle (for example "R1S Doors"), so the Home app gives each its own tile:

| Service | Shows | Notes |
| --- | --- | --- |
| Charge | Charge % on the tile, plus charging state and low battery | Shown as a humidity sensor, the only type Home shows a % for on the tile, so automations read "humidity". Low battery threshold is configurable (default 20%). |
| Lock | Locked when all four doors are locked | Status only; it can't lock or unlock. |
| Contact sensors | Doors, Windows, Frunk, Liftgate (R1S, R2) or Tailgate and Tonneau (R1T), Charge Port | "Open" if any one is open. |
| Plugged In | Occupancy sensor: Detected while the charge cable is connected | |
| Cabin | Interior temperature | |
| Range | Light sensor where lux = miles or km | Off by default. HomeKit has no range type. |

Each can be turned off in the plugin settings.

## Setup

1. Install the plugin. It isn't on npm, so install it from GitHub
   (`sudo npm install -g github:DaveHarrington/homebridge-rivian-status`) or from a tarball built with `npm pack`
   (`sudo npm install -g ./homebridge-rivian-status-<version>.tgz`).
2. In the Homebridge UI, open the plugin's settings and sign in with your Rivian email and password. If Rivian
   sends a verification code, enter it.
3. Restart Homebridge.

The password goes to Rivian only and isn't saved. Sign-in saves Rivian's session token to
`<homebridge storage>/rivian-status-auth.json` (mode 600). If Rivian ends the session, the log says so: sign in again
from the settings page, and the plugin picks up the new session on its next poll without a restart.

## How it reads

Every poll interval (default 120 s, minimum 30 s) it asks Rivian's cloud for the vehicle's last-known state. That
doesn't wake the vehicle, so readings can be a little stale while it sleeps. A value Rivian doesn't report leaves the
last reading in place.

## Development

```bash
npm install
npm test   # builds, then runs unit tests against a mock Rivian API (test/mockRivian.js)
npm pack   # builds homebridge-rivian-status-<version>.tgz
```

`RIVIAN_GRAPHQL_URL` points the client at a different endpoint, for testing against the mock.

The API calls are based on [homebridge-rivian](https://github.com/tvearl/homebridge-rivian) (MIT) and
[rivian-python-client](https://github.com/bretterer/rivian-python-client).
