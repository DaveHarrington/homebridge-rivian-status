import type { Characteristic, CharacteristicValue, PlatformAccessory, Service, WithUUID } from 'homebridge';
import type { RivianStatusPlatform } from './platform';
import type { RivianVehicle } from './rivianClient';
import type { VehicleStatus } from './state';

const KM_PER_MILE = 1.609344;

/** Services that lived on the main accessory before 0.3.0, removed from its cache on upgrade. */
const LEGACY_SUBTYPES = [
  'doors', 'windows', 'frunk', 'liftgate', 'tailgate', 'tonneau', 'charge-port', 'charge-cable',
  'plugged-in', 'cabin', 'range',
];

/**
 * Exposes one vehicle to HomeKit, read-only. The vehicle's own accessory holds the lock and battery;
 * every other sensor is a separate accessory so the Home app gives each its own tile.
 * Nothing here writes to the vehicle.
 */
export class VehicleAccessory {
  private readonly S;
  private readonly C;
  private readonly isTruck: boolean;
  private readonly battery: Service;
  private readonly lock?: Service;
  private readonly contacts = new Map<string, { service: Service; isOpen: (s: VehicleStatus) => boolean | undefined }>();
  private readonly pluggedIn?: Service;
  private readonly cabin?: Service;
  private readonly range?: Service;

  constructor(
    private readonly platform: RivianStatusPlatform,
    private readonly main: PlatformAccessory,
    private readonly vehicle: RivianVehicle,
  ) {
    this.S = platform.api.hap.Service;
    this.C = platform.api.hap.Characteristic;
    const cfg = platform.cfg;
    // R1T is the only pickup; R1S, R2 and anything newer have a liftgate.
    this.isTruck = /r1t/i.test(vehicle.model ?? '');

    this.setInfo(main, vehicle.vin);
    for (const service of [...main.services]) {
      if (service.subtype && LEGACY_SUBTYPES.includes(service.subtype)) {
        main.removeService(service);
      }
    }

    this.battery = this.service(main, this.S.Battery, 'Battery', 'battery');

    const lock = main.getServiceById(this.S.LockMechanism, 'lock');
    if (cfg.showLock) {
      this.lock = this.service(main, this.S.LockMechanism, 'Locks', 'lock');
      this.lock.setPrimaryService(true);
      // Status only: HomeKit requires a target state, so make it read-only.
      const readOnly = { perms: [platform.api.hap.Perms.PAIRED_READ, platform.api.hap.Perms.NOTIFY] };
      this.lock.getCharacteristic(this.C.LockTargetState).setProps(readOnly);
    } else if (lock) {
      main.removeService(lock);
    }

    this.contact(cfg.showDoors, 'doors', 'Doors', (s) => s.doorsOpen);
    this.contact(cfg.showWindows, 'windows', 'Windows', (s) => s.windowsOpen);
    this.contact(cfg.showFrunk, 'frunk', 'Frunk', (s) => s.frunkOpen);
    this.contact(cfg.showRearClosure && !this.isTruck, 'liftgate', 'Liftgate', (s) => s.liftgateOpen);
    this.contact(cfg.showRearClosure && this.isTruck, 'tailgate', 'Tailgate', (s) => s.tailgateOpen);
    this.contact(cfg.showTonneau && this.isTruck, 'tonneau', 'Tonneau', (s) => s.tonneauOpen);
    this.contact(cfg.showChargePort, 'charge-port', 'Charge Port', (s) => s.chargePortOpen);

    // HomeKit has no "plugged in" type; an occupancy sensor reads naturally as Detected / Not Detected.
    this.pluggedIn = this.sensor(cfg.showPluggedIn, 'plugged-in', this.S.OccupancySensor, 'Plugged In');

    this.cabin = this.sensor(cfg.showCabinTemperature, 'cabin', this.S.TemperatureSensor, 'Cabin');
    this.cabin?.getCharacteristic(this.C.CurrentTemperature).setProps({ minValue: -50, maxValue: 100 });

    // HomeKit has no range characteristic; a light sensor's lux reading is the usual stand-in.
    this.range = this.sensor(cfg.showRangeSensor, 'range', this.S.LightSensor, 'Range');
  }

  private setInfo(accessory: PlatformAccessory, serial: string): void {
    accessory.getService(this.S.AccessoryInformation)!
      .setCharacteristic(this.C.Manufacturer, 'Rivian')
      .setCharacteristic(this.C.Model, [this.vehicle.modelYear, this.vehicle.model].filter(Boolean).join(' ') || 'Rivian')
      .setCharacteristic(this.C.SerialNumber, serial);
  }

  private service(accessory: PlatformAccessory, type: WithUUID<typeof Service>, name: string, subtype: string): Service {
    const service = accessory.getServiceById(type, subtype) ?? accessory.addService(type, name, subtype);
    service.setCharacteristic(this.C.Name, name);
    if (!service.testCharacteristic(this.C.ConfiguredName)) {
      service.addOptionalCharacteristic(this.C.ConfiguredName);
      service.setCharacteristic(this.C.ConfiguredName, name);
    }
    return service;
  }

  /**
   * Returns the service on the sensor's own accessory when enabled. A disabled sensor's accessory
   * isn't requested, so the platform removes it.
   */
  private sensor(enabled: boolean, key: string, type: WithUUID<typeof Service>, name: string): Service | undefined {
    if (!enabled) {
      return undefined;
    }
    const accessory = this.platform.accessoryFor(this.vehicle, key, `${this.vehicle.name} ${name}`);
    this.setInfo(accessory, `${this.vehicle.vin}-${key}`);
    return this.service(accessory, type, name, key);
  }

  private contact(enabled: boolean, key: string, name: string, isOpen: (s: VehicleStatus) => boolean | undefined): void {
    const service = this.sensor(enabled, key, this.S.ContactSensor, name);
    if (service) {
      this.contacts.set(key, { service, isOpen });
    }
  }

  /** Pushes fresh status to HomeKit. Values Rivian didn't report keep their last reading. */
  update(status: VehicleStatus): void {
    const C = this.C;
    const set = (service: Service | undefined, characteristic: WithUUID<new () => Characteristic>, value?: CharacteristicValue) => {
      if (service && value !== undefined) {
        service.updateCharacteristic(characteristic, value);
      }
    };

    if (status.batteryPercent !== undefined) {
      set(this.battery, C.BatteryLevel, status.batteryPercent);
      set(this.battery, C.StatusLowBattery, status.batteryPercent <= this.platform.lowBatteryPercent
        ? C.StatusLowBattery.BATTERY_LEVEL_LOW
        : C.StatusLowBattery.BATTERY_LEVEL_NORMAL);
    }
    set(this.battery, C.ChargingState, status.charging ? C.ChargingState.CHARGING : C.ChargingState.NOT_CHARGING);

    if (status.locked !== undefined) {
      const current = status.locked ? C.LockCurrentState.SECURED : C.LockCurrentState.UNSECURED;
      const target = status.locked ? C.LockTargetState.SECURED : C.LockTargetState.UNSECURED;
      set(this.lock, C.LockCurrentState, current);
      set(this.lock, C.LockTargetState, target);
    }

    for (const { service, isOpen } of this.contacts.values()) {
      const open = isOpen(status);
      if (open !== undefined) {
        set(service, C.ContactSensorState, open
          ? C.ContactSensorState.CONTACT_NOT_DETECTED
          : C.ContactSensorState.CONTACT_DETECTED);
      }
    }

    if (status.pluggedIn !== undefined) {
      set(this.pluggedIn, C.OccupancyDetected, status.pluggedIn
        ? C.OccupancyDetected.OCCUPANCY_DETECTED
        : C.OccupancyDetected.OCCUPANCY_NOT_DETECTED);
    }

    set(this.cabin, C.CurrentTemperature, status.cabinTempC);

    if (status.rangeKm !== undefined) {
      const range = this.platform.rangeUnit === 'mi' ? status.rangeKm / KM_PER_MILE : status.rangeKm;
      // Light sensors can't report 0 lux; 0.0001 is the minimum.
      set(this.range, C.CurrentAmbientLightLevel, Math.max(0.0001, Math.round(range)));
    }
  }
}
