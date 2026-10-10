'use strict';

const { HomebridgePluginUiServer, RequestError } = require('@homebridge/plugin-ui-utils');
const { RivianClient } = require('../dist/rivianClient');
const { loadStore, saveStore, deleteStore } = require('../dist/store');

class RivianStatusUiServer extends HomebridgePluginUiServer {
  constructor() {
    super();
    // Holds the half-finished sign-in (CSRF and OTP tokens) between the password and code steps.
    this.pending = null;

    this.onRequest('/status', this.status.bind(this));
    this.onRequest('/login', this.login.bind(this));
    this.onRequest('/verify-otp', this.verifyOtp.bind(this));
    this.onRequest('/sign-out', this.signOut.bind(this));
    this.ready();
  }

  status() {
    const store = loadStore(this.homebridgeStoragePath);
    if (!store) {
      return { signedIn: false };
    }
    return {
      signedIn: true,
      email: store.email,
      savedAt: store.savedAt,
      vehicles: store.vehicles.map((v) => ({ name: v.name, model: v.model, modelYear: v.modelYear })),
    };
  }

  async login(payload) {
    const email = String(payload?.email ?? '').trim();
    const password = String(payload?.password ?? '');
    if (!email || !password) {
      throw new RequestError('Enter your Rivian email and password.', { status: 400 });
    }
    const client = new RivianClient();
    try {
      await client.createSession();
      const { otpRequired } = await client.login(email, password);
      if (otpRequired) {
        this.pending = { client, email };
        return { otpRequired: true };
      }
      return { otpRequired: false, ...(await this.finish(client, email)) };
    } catch (err) {
      throw new RequestError(err.message || 'Sign-in failed.', { status: 401 });
    }
  }

  async verifyOtp(payload) {
    if (!this.pending) {
      throw new RequestError('Start again with your email and password.', { status: 400 });
    }
    const code = String(payload?.code ?? '').trim();
    if (!code) {
      throw new RequestError('Enter the code Rivian sent you.', { status: 400 });
    }
    try {
      const { client, email } = this.pending;
      await client.loginWithOtp(email, code);
      this.pending = null;
      return this.finish(client, email);
    } catch (err) {
      throw new RequestError(err.message || 'Verification failed.', { status: 401 });
    }
  }

  async finish(client, email) {
    const vehicles = await client.getVehicles();
    saveStore(this.homebridgeStoragePath, {
      email,
      tokens: client.getTokens(),
      vehicles,
      savedAt: new Date().toISOString(),
    });
    return { vehicles: vehicles.map((v) => ({ name: v.name, model: v.model, modelYear: v.modelYear })) };
  }

  signOut() {
    this.pending = null;
    deleteStore(this.homebridgeStoragePath);
    return { signedIn: false };
  }
}

(() => new RivianStatusUiServer())();
