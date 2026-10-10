import type { API, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig } from 'homebridge';
import {
  DEFAULT_LOW_BATTERY_PERCENT, DEFAULT_POLL_SECONDS, MIN_POLL_SECONDS, PLATFORM_NAME, PLUGIN_NAME,
} from './settings';
import { RivianApiError, RivianClient, type RivianVehicle } from './rivianClient';
import { type AuthStore, loadStore, saveStore } from './store';
import { flattenState, STATE_PROPERTIES, toStatus } from './state';
import { VehicleAccessory } from './vehicleAccessory';

interface RivianStatusConfig extends PlatformConfig {
  pollIntervalSeconds?: number;
  lowBatteryPercent?: number;
  rangeUnit?: 'mi' | 'km';
  showLock?: boolean;
  showDoors?: boolean;
  showWindows?: boolean;
  showFrunk?: boolean;
  showRearClosure?: boolean;
  showTonneau?: boolean;
  showChargePort?: boolean;
  showPluggedIn?: boolean;
  /** Pre-0.2.0 name for showPluggedIn. */
  showChargeCable?: boolean;
  showCabinTemperature?: boolean;
  showRangeSensor?: boolean;
}

/** Display toggles, with the defaults applied. */
export interface DisplayConfig {
  showLock: boolean;
  showDoors: boolean;
  showWindows: boolean;
  showFrunk: boolean;
  showRearClosure: boolean;
  showTonneau: boolean;
  showChargePort: boolean;
  showPluggedIn: boolean;
  showCabinTemperature: boolean;
  showRangeSensor: boolean;
}

export class RivianStatusPlatform implements DynamicPlatformPlugin {
  readonly cfg: DisplayConfig;
  readonly rangeUnit: 'mi' | 'km';
  readonly lowBatteryPercent: number;
  private readonly pollMs: number;
  private readonly cached: PlatformAccessory[] = [];
  private readonly wanted = new Set<string>();
  private readonly vehicles = new Map<string, { vehicle: RivianVehicle; accessory: VehicleAccessory }>();
  private client?: RivianClient;
  private store: AuthStore | null = null;
  private timer?: NodeJS.Timeout;
  private lastError = '';

  constructor(readonly log: Logging, config: PlatformConfig, readonly api: API) {
    const c = config as RivianStatusConfig;
    const on = (v: boolean | undefined) => v ?? true;
    this.cfg = {
      showLock: on(c.showLock),
      showDoors: on(c.showDoors),
      showWindows: on(c.showWindows),
      showFrunk: on(c.showFrunk),
      showRearClosure: on(c.showRearClosure),
      showTonneau: on(c.showTonneau),
      showChargePort: on(c.showChargePort),
      showPluggedIn: on(c.showPluggedIn ?? c.showChargeCable),
      showCabinTemperature: on(c.showCabinTemperature),
      showRangeSensor: c.showRangeSensor ?? false,
    };
    this.rangeUnit = c.rangeUnit === 'km' ? 'km' : 'mi';
    this.lowBatteryPercent = c.lowBatteryPercent ?? DEFAULT_LOW_BATTERY_PERCENT;
    this.pollMs = Math.max(MIN_POLL_SECONDS, c.pollIntervalSeconds ?? DEFAULT_POLL_SECONDS) * 1000;

    api.on('didFinishLaunching', () => {
      this.start().catch((err) => this.log.error('Startup failed:', (err as Error).message));
    });
    api.on('shutdown', () => clearTimeout(this.timer));
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.cached.push(accessory);
  }

  private get storagePath(): string {
    return this.api.user.storagePath();
  }

  private async start(): Promise<void> {
    this.store = loadStore(this.storagePath);
    if (!this.store) {
      this.log.warn('Not signed in. Open this plugin\'s settings in the Homebridge UI and sign in to your Rivian account.');
      // Keep checking so sign-in from the UI takes effect without a restart.
      this.schedule();
      return;
    }
    this.client = new RivianClient(this.store.tokens);
    let vehicles = this.store.vehicles;
    try {
      await this.client.createSession();
      vehicles = await this.client.getVehicles();
      this.store = { ...this.store, vehicles };
      saveStore(this.storagePath, this.store);
    } catch (err) {
      this.reportError('loading your vehicles', err);
      this.log.info(`Using the ${vehicles.length} vehicle(s) saved at sign-in.`);
    }
    this.setupAccessories(vehicles);
    await this.poll();
    this.log.info(`Reading vehicle status every ${this.pollMs / 1000}s.`);
  }

  private setupAccessories(vehicles: RivianVehicle[]): void {
    this.wanted.clear();
    for (const vehicle of vehicles) {
      const main = this.accessoryFor(vehicle);
      main.context.vehicleId = vehicle.id;
      this.vehicles.set(vehicle.id, { vehicle, accessory: new VehicleAccessory(this, main, vehicle) });
    }
    const stale = this.cached.filter((a) => !this.wanted.has(a.UUID));
    if (stale.length) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
      this.log.info(`Removed ${stale.length} accessory(s): ${stale.map((a) => a.displayName).join(', ')}.`);
    }
  }

  /**
   * Gets the cached accessory for a vehicle, or for one of its sensors when `key` is given,
   * registering it if new. Anything not requested during setup is removed afterwards.
   */
  accessoryFor(vehicle: RivianVehicle, key?: string, name = vehicle.name): PlatformAccessory {
    // The vehicle's own accessory keeps its pre-0.3.0 UUID so its room and automations survive.
    const uuid = this.api.hap.uuid.generate(key ? `rivian-status:${vehicle.vin}:${key}` : `rivian-status:${vehicle.vin}`);
    this.wanted.add(uuid);
    let accessory = this.cached.find((a) => a.UUID === uuid);
    if (!accessory) {
      accessory = new this.api.platformAccessory(name, uuid);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.cached.push(accessory);
      this.log.info(`Added ${name}.`);
    }
    return accessory;
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.tick().catch((err) => this.log.debug('Poll failed:', (err as Error).message));
    }, this.pollMs);
  }

  private async tick(): Promise<void> {
    if (!this.client) {
      // Not signed in at startup; start properly once the UI has saved a session.
      return loadStore(this.storagePath) ? this.start() : this.schedule();
    }
    return this.poll();
  }

  private async poll(): Promise<void> {
    try {
      for (const { vehicle, accessory } of this.vehicles.values()) {
        const raw = await this.withSession(() => this.client!.getVehicleState(vehicle.id, STATE_PROPERTIES));
        const status = toStatus(flattenState(raw));
        this.log.debug(`${vehicle.name}:`, JSON.stringify(status));
        accessory.update(status);
      }
      if (this.lastError) {
        this.log.info('Reading vehicle status again.');
        this.lastError = '';
      }
    } catch (err) {
      this.reportError('reading vehicle status', err);
    } finally {
      this.schedule();
    }
  }

  /**
   * Runs a request, and on an auth error retries once with a fresh app session.
   * If that fails too, picks up tokens from a newer sign-in in the UI, if any.
   */
  private async withSession<T>(request: () => Promise<T>): Promise<T> {
    try {
      return await request();
    } catch (err) {
      if (!(err instanceof RivianApiError && err.isAuthError)) {
        throw err;
      }
      const latest = loadStore(this.storagePath);
      if (latest && latest.tokens.userSessionToken !== this.store?.tokens.userSessionToken) {
        this.store = latest;
        this.client = new RivianClient(latest.tokens);
      }
      await this.client!.createSession();
      return request();
    }
  }

  /** Logs each distinct error once, so a long outage doesn't flood the log. */
  private reportError(context: string, err: unknown): void {
    const message = (err as Error).message;
    const auth = err instanceof RivianApiError && err.isAuthError;
    const text = auth
      ? `Rivian rejected the saved session while ${context}. Open this plugin's settings and sign in again.`
      : `Error ${context}: ${message}`;
    if (text !== this.lastError) {
      this.lastError = text;
      (auth ? this.log.error : this.log.warn).call(this.log, text);
    } else {
      this.log.debug(text);
    }
  }
}
