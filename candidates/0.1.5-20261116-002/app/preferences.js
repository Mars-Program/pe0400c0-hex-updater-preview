export const orientationStorageKey = 'pe0400c0-hex-web.boot-orientation.v1';
const valid = value => value === '1' || value === '2';

// A presentation preference only. Never persist a port, package ID or approval.
export class OrientationPreference {
  constructor(getStorage = () => globalThis.localStorage) {
    this.getStorage = getStorage;
    this.value = '1';
    this.origin = 'default';
    this.saved = false;
    this.available = true;
    try {
      const stored = getStorage().getItem(orientationStorageKey);
      if (valid(stored)) { this.value = stored; this.origin = 'remembered'; this.saved = true; }
    } catch { this.available = false; }
  }
  remember(value) {
    if (!valid(value)) throw new Error('BOOT orientation must be Portrait or Landscape.');
    this.value = value;
    this.origin = 'selected';
    try {
      const storage = this.getStorage();
      storage.setItem(orientationStorageKey, value);
      this.saved = storage.getItem(orientationStorageKey) === value;
      this.available = this.saved;
    } catch { this.saved = false; this.available = false; }
    return this.saved;
  }
}
