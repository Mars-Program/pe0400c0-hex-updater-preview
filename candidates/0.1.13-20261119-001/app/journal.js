export const requiresDeviceInspection = run => !!(run.persistent || run.requiresDeviceCheck) && ['RUNNING','RECOVERY_STATE_UNKNOWN'].includes(run.status);

export class JournalStore {
  static async open() {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('pe0400c0-hex-web-v1', 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('runs', { keyPath: 'id' });
        const events = request.result.createObjectStore('events', { keyPath: ['id', 'seq'] });
        events.createIndex('run', 'id');
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('Close other updater tabs to open the session journal.'));
    });
    return new JournalStore(db);
  }
  constructor(db) { this.db = db; this.current = null; this.pending = []; this.sequence = 0; this.chain = Promise.resolve(); }
  async list() {
    return new Promise((resolve, reject) => {
      const request = this.db.transaction('runs').objectStore('runs').getAll();
      request.onsuccess = () => resolve(request.result.sort((a,b) => b.started.localeCompare(a.started)));
      request.onerror = () => reject(request.error);
    });
  }
  async begin(filename) {
    await this.flush();
    this.current = { id: crypto.randomUUID(), started: new Date().toISOString(), filename,
      tool: 'HEX Updater Web', version: '0.1.13', status: 'VALIDATING', persistent: false, deviceActions: 'NOT_STARTED' };
    this.sequence = 0; await this.flush();
  }
  log(text) {
    if (!this.current) return;
    if (this.sequence >= 100000) throw new Error('Session log event limit reached.');
    this.pending.push({ id: this.current.id, seq: this.sequence++, time: new Date().toISOString(), text: String(text) });
  }
  flush() {
    // Snapshot only after prior flush finishes; no concurrent event batches.
    this.chain = this.chain.then(async () => {
      if (!this.current) return;
      const events = this.pending.slice();
      const run = structuredClone(this.current);
      await new Promise((resolve, reject) => {
        const tx = this.db.transaction(['runs','events'], 'readwrite', { durability: 'strict' });
        tx.objectStore('runs').put(run);
        for (const entry of events) tx.objectStore('events').put(entry);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error ?? new Error('Session journal write failed.'));
        tx.onabort = () => reject(tx.error ?? new Error('Session journal write was aborted.'));
      });
      this.pending.splice(0, events.length);
    });
    return this.chain;
  }
  async resolveReadOnlyPreflight(reviewed, verificationRunId, board) {
    // Caller holds the common Web Lock, has matched the original no-write
    // transcript and field records, and has verified the restarted APP.
    await new Promise((resolve, reject) => {
      const tx=this.db.transaction('runs','readwrite',{durability:'strict'});
      const store=tx.objectStore('runs');
      const query=store.get(reviewed.id);
      query.onsuccess=()=>{
        const old=query.result;
        if (!old || old.status!==reviewed.status || old.updated!==reviewed.updated || old.persistent!==false ||
            old.result?.code!=='DEVICE_CHECK_REQUIRED' || old.requiresDeviceCheck!==true) { tx.abort(); return; }
        store.put({...old, status:'READ_ONLY_PREFLIGHT_REVIEWED', previousStatus:old.status,
          inspectedAt:new Date().toISOString(), verificationRunId, inspectedBoard:board});
      };
      tx.oncomplete=resolve;
      tx.onabort=()=>reject(new Error('Original read-only session changed. Preserve both records.'));
      tx.onerror=()=>reject(tx.error);
    });
  }
  async export(run = this.current) {
    if (!run) throw new Error('No session is available.');
    let flushError = null;
    try { await this.flush(); } catch (error) { flushError = String(error); }
    const events = await new Promise((resolve, reject) => {
      const request = this.db.transaction('events').objectStore('events').index('run').getAll(run.id);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    return { run, journalError: flushError, events: [...events, ...this.pending.filter(e => e.id === run.id)] };
  }
}
