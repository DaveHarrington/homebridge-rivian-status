import type { Characteristic, CharacteristicValue, PlatformAccessory, Service, WithUUID } from 'homebridge';
import type { RivianStatusPlatform } from './platform';
import type { RivianVehicle } from './rivianClient';
import type { VehicleStatus } from './state';

const KM_PER_MILE = 1.609344;

/**
 * Exposes one vehicle as a single HomeKit accessory with read-only services.
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
    private readonly accessory: PlatformAccessory,
    vehicle: RivianVehicle,
  ) {
    this.S = platform.api.hap.Service;
    this.C = platform.api.hap.Characteristic;
    const cfg = platform.cfg;
    // R1T is the only pickup; R1S, R2 and anything newer have a liftgate.
    this.isTruck = /r1t/i.test(vehicle.model ?? '');

    accessory.getService(this.S.AccessoryInformation)!
      .setCharacteristic(this.C.Manufacturer, 'Rivian')
      .setCharacteristic(this.C.Model, [vehicle.modelYear, vehicle.model].filter(Boolean).join(' ') || 'Rivian')
      .setCharacteristic(this.C.SerialNumber, vehicle.vin);

    this.battery = this.service(this.S.Battery, 'battery', 'Battery');

    this.lock = this.optional(cfg.showLock, this.S.LockMechanism, 'lock', 'Locks');
    if (this.lock) {
      // Status only: HomeKit requires a target state, so make it read-only.
      const readOnly = { perms: [platform.api.hap.Perms.PAIRED_READ, platform.api.hap.Perms.NOTIFY] };
      this.lock.getCharacteristic(this.C.LockTargetState).setProps(readOnly);
    }

    this.contact(cfg.showDoors, 'doors', 'Doors', (s) => s.doorsOpen);
    this.contact(cfg.showWindows, 'windows', 'Windows', (s) => s.windowsOpen);
    this.contact(cfg.showFrunk, 'frunk', 'Frunk', (s) => s.frunkOpen);
    this.contact(cfg.showRearClosure && !this.isTruck, 'liftgate', 'Liftgate', (s) => s.liftgateOpen);
    this.contact(cfg.showRearClosure && this.isTruck, 'tailgate', 'Tailgate', (s) => s.tailgateOpen);
    this.contact(cfg.showTonneau && this.isTruck, 'tonneau', 'Tonneau', (s) => s.tonneauOpen);
    this.contact(cfg.showChargePort, 'charge-port', 'Charge Port', (s) => s.chargePortOpen);

    // HomeKit has no "plugged in" type; an occupancy sensor reads naturally as Detected / Not Detected.
    this.pluggedIn = this.optional(cfg.showPluggedIn, this.S.OccupancySensor, 'plugged-in', 'Plugged In');
    // Replaced by the Plugged In sensor in 0.2.0.
    this.optional(false, this.S.ContactSensor, 'charge-cable', 'Charge Cable');

    this.cabin = this.optional(cfg.showCabinTemperature, this.S.TemperatureSensor, 'cabin', 'Cabin');
    if (this.cabin) {
      this.cabin.getCharacteristic(this.C.CurrentTemperature).setProps({ minValue: -50, maxValue: 100 });
    }

    // HomeKit has no range characteristic; a light sensor's lux reading is the usual stand-in.
    this.range = this.optional(cfg.showRangeSensor, this.S.LightSensor, 'range', 'Range');
  }

  private service(type: WithUUID<typeof Service>, subtype: string, name: string): Service {
    const service = this.accessory.getServiceById(type, subtype)
      ?? this.accessory.addService(type, name, subtype);
    service.setCharacteristic(this.C.Name, name);
    if (!service.testCharacteristic(this.C.ConfiguredName)) {
      service.addOptionalCharacteristic(this.C.ConfiguredName);
      service.setCharacteristic(this.C.ConfiguredName, name);
    }
    return service;
  }

  /** Adds the service when enabled, and removes a cached one when it's been turned off. */
  private optional(enabled: boolean, type: WithUUID<typeof Service>, subtype: string, name: string): Service | undefined {
    if (enabled) {
      return this.service(type, subtype, name);
    }
    const existing = this.accessory.getServiceById(type, subtype);
    if (existing) {
      this.accessory.removeService(existing);
    }
    return undefined;
  }

  private contact(enabled: boolean, subtype: string, name: string, isOpen: (s: VehicleStatus) => boolean | undefined): void {
    const service = this.optional(enabled, this.S.ContactSensor, subtype, name);
    if (service) {
      this.contacts.set(subtype, { service, isOpen });
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
