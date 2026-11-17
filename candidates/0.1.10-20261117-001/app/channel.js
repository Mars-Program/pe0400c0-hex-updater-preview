export class ByteQueue {
  constructor(maximum = 1048576) { this.chunks = []; this.offset = 0; this.length = 0; this.maximum = maximum; this.error = null; this.waiter = null; }
  push(bytes) {
    if (this.error) return;
    if (this.length + bytes.length > this.maximum) { this.fail(new Error('Serial receive buffer exceeded its bound.')); return; }
    if (bytes.length) { this.chunks.push(bytes.slice()); this.length += bytes.length; }
    this.wake();
  }
  fail(error) { this.error = error instanceof Error ? error : new Error(String(error)); this.wake(); }
  wake() { if (this.waiter) { const resume = this.waiter; this.waiter = null; resume(); } }
  async read(timeout) {
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 120000) throw new Error('Invalid serial read deadline.');
    if (this.error) throw this.error;
    if (!this.length) {
      if (this.waiter) throw new Error('Only one serial reader is allowed.');
      await new Promise(resolve => {
        const timer = setTimeout(() => { if (this.waiter === finish) this.waiter = null; resolve(); }, timeout);
        const finish = () => { clearTimeout(timer); resolve(); };
        this.waiter = finish;
      });
    }
    if (this.error) throw this.error;
    if (!this.length) return -1;
    const value = this.chunks[0][this.offset++];
    this.length--;
    if (this.offset === this.chunks[0].length) { this.chunks.shift(); this.offset = 0; }
    return value;
  }
}

export async function deadline(promise, milliseconds, message) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

// Identification only. A structured receive-only startup failure permits one
// reconnect; thrown errors, responses, cancellation and failed closes never do.
export async function identifyWithRetry({ createChannel, identify, onAttempt = async () => {}, onRetry = async () => {},
  canceled = () => false, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const checkCanceled = () => { if (canceled()) throw new Error('Device identification canceled.'); };
  for (let attempt = 1; attempt <= 2; attempt++) {
    checkCanceled(); await onAttempt(attempt); checkCanceled();
    const transport = createChannel();
    let result;
    try {
      await transport.open(); checkCanceled();
      result = await identify(); checkCanceled();
    } finally { await transport.close(); }
    if (!result?.retryable) return result;
    if (result.code !== 'INITIAL_SYNC_UNSTABLE' || result.querySent !== false || attempt === 2)
      throw new Error(result.message ?? 'Device identification could not synchronize. Export the log and check the connection.');
    await onRetry(result); checkCanceled();
    await wait(200); checkCanceled();
  }
}

export class WebSerialChannel {
  constructor(port, beforeWrite = async () => {}, signals = { dataTerminalReady: true, requestToSend: true }, onResetBreak = () => {}) {
    this.port = port; this.beforeWrite = beforeWrite; this.queue = new ByteQueue();
    this.signals = { ...signals };
    this.onResetBreak = onResetBreak; this.resetDeadline = 0; this.resetBreaks = 0;
    this.resetTerminal = null; this.resetTail = '';
    this.opened = false; this.closing = false; this.reader = null; this.writer = null; this.readTask = null; this.writing = false;
    this.onDisconnect = () => this.queue.fail(new Error('Serial device disconnected. No update was retried.'));
  }
  async open() {
    await this.port.open({ baudRate: 921600, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none', bufferSize: 65536 });
    this.opened = true;
    try {
      await this.port.setSignals(this.signals);
      this.port.addEventListener('disconnect', this.onDisconnect);
      if (!this.port.readable || !this.port.writable) throw new Error('Serial streams are unavailable.');
      this.reader = this.port.readable.getReader(); this.writer = this.port.writable.getWriter();
      this.readTask = this.pump();
    } catch (error) { await this.close().catch(() => {}); throw error; }
  }
  async pump() {
    while (!this.closing) {
      let recover = false;
      try {
        while (!this.closing) {
          const { value, done } = await this.reader.read();
          if (done) { if (!this.closing) this.queue.fail(new Error('Serial read stream ended before completion.')); break; }
          if (value) {
            if (this.resetTerminal) {
              this.resetTail = (this.resetTail + new TextDecoder('ascii').decode(value)).slice(-2048);
              if (this.resetTail.includes('\r\n' + this.resetTerminal + '\r\n')) {
                this.resetTerminal = null; this.resetTail = ''; this.expectReset(true);
              }
            }
            this.queue.push(value);
          }
        }
      } catch (error) {
        // Chrome replaces readable after a nonfatal UART break. EAO permits a
        // receive-only recovery in a named, bounded MCU-reset phase. Neither a
        // packet nor command is resent. All transfer/other errors remain fatal.
        if (!this.closing && error?.name === 'BreakError' && Date.now() < this.resetDeadline && this.resetBreaks < 8) {
          this.resetBreaks++; recover = true; this.onResetBreak(this.resetBreaks);
        } else if (!this.closing) this.queue.fail(error);
      } finally { this.reader.releaseLock(); this.reader = null; }
      if (!recover || this.closing) break;
      // FTDI can report the same held-low reset as several queued BREAK events.
      // Debounce reader renewal, bounded to eight events and the reset deadline.
      await new Promise(resolve => setTimeout(resolve, 25));
      if (this.closing) break;
      if (!this.port.readable) { this.queue.fail(new Error('Serial device disappeared during expected reset.')); break; }
      try { this.reader = this.port.readable.getReader(); }
      catch (error) { this.queue.fail(error); break; }
    }
  }
  expectReset(expected) { this.resetDeadline = expected ? Date.now() + 15000 : 0; this.resetBreaks = 0; }
  expectResetAfter(terminal) {
    if (!/^@UPD,RESULT,APP,V5,[0-9A-F]{8},PASS,PRESERVE,[0-9A-F]{8},[0-9A-F]{8},[0-9A-F]{8},[0-9A-F]{8},NEW_AUTHORITY$/.test(terminal)) throw new Error('Invalid expected EAO terminal.');
    this.resetTerminal = terminal; this.resetTail = '\r\n';
  }
  readByte(timeout) { return this.queue.read(timeout); }
  async write(bytes) {
    if (!this.opened || this.closing || this.queue.error) throw this.queue.error ?? new Error('Serial port is not open.');
    if (this.writing) throw new Error('Concurrent serial writes are forbidden.');
    if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > 4096) throw new Error('Invalid bounded binary write.');
    this.writing = true;
    try {
      // Commit queued log events and the persistent-boundary marker before TX.
      await this.beforeWrite();
      if (this.queue.error) throw this.queue.error;
      await deadline(this.writer.write(bytes), 10000, 'Serial write timeout. Delivery is uncertain; no resend was attempted.');
    } catch (error) { this.queue.fail(error); throw error; }
    finally { this.writing = false; }
  }
  async close() {
    if (!this.opened) return;
    this.closing = true;
    this.queue.fail(new Error('Serial port closed.'));
    const errors = [];
    try { if (this.reader) await deadline(this.reader.cancel(), 3000, 'Reader did not close.'); }
    catch (e) { errors.push(e); }
    try { if (this.readTask) await deadline(this.readTask, 3000, 'Reader lock was not released.'); }
    catch (e) { errors.push(e); }
    try { if (this.writer) { await deadline(this.writer.abort(), 3000, 'Writer did not close.'); this.writer.releaseLock(); this.writer = null; } }
    catch (e) { errors.push(e); }
    try { await deadline(this.port.close(), 3000, 'Serial port release timed out.'); }
    catch (e) { errors.push(e); }
    this.port.removeEventListener('disconnect', this.onDisconnect);
    this.opened = false;
    if (errors.length) throw new Error(errors.map(e => e.message).join(' '));
  }
}
