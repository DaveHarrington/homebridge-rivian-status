import fs from 'node:fs';
import path from 'node:path';
import { AUTH_FILE_NAME } from './settings';
import type { RivianTokens, RivianVehicle } from './rivianClient';

/** What sign-in saves in the Homebridge storage folder. The password is never stored. */
export interface AuthStore {
  email: string;
  tokens: RivianTokens;
  vehicles: RivianVehicle[];
  savedAt: string;
}

export function authFilePath(storagePath: string): string {
  return path.join(storagePath, AUTH_FILE_NAME);
}

export function loadStore(storagePath: string): AuthStore | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(authFilePath(storagePath), 'utf-8')) as AuthStore;
    return parsed.tokens?.userSessionToken ? parsed : null;
  } catch {
    return null;
  }
}

export function saveStore(storagePath: string, store: AuthStore): void {
  const file = authFilePath(storagePath);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function deleteStore(storagePath: string): void {
  fs.rmSync(authFilePath(storagePath), { force: true });
}
