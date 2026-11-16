import { createBootResourceLoader, startValidationEngine } from './engine-loader.js';
import { WebSerialChannel, identifyWithRetry } from './channel.js';
import { JournalStore } from './journal.js';
import { OrientationPreference } from './preferences.js';
const $ = id => document.getElementById(id);
const assembly = 'PE0400C0.HexUpdater.Web';
const invoke = (method, ...args) => DotNet.invokeMethodAsync(assembly, method, ...args);
let engineReady = false, busy = false, persistent = false, blocked = false, prepared = null;
let selectedPort = null, channel = null, journal = null, wakeLock = null, resolveConfirmation = null;
let uiEvents = [], uiTimer, eventCount = 0;
let step = 1, source = null, inspection = null, file = null, lastSuccess = false, stopping = false;
let validationFailed = false, deviceReport = null, actionStatuses = [];
const preference = new OrientationPreference();
$('orientation').value = preference.value;
const orientationName = value => Number(value) === 2 ? 'Landscape · 800 × 480 · clockwise' : Number(value) === 1 ? 'Portrait · 480 × 800 · native' : 'Not confirmed';
const guidance = ['', 'Identify the connected device. Version rules select available actions; actual capabilities are checked before writing.',
  'Choose an APP HEX. File checks run automatically; BOOT direction only affects the update screen.',
  'Wait for the final MCU result, then export the session log.'];
function showCompatibility() {
  $('boot-version').textContent = deviceReport?.bootVersion ?? 'Not identified';
  $('summary-boot').textContent = deviceReport?.bootVersion ?? 'Not identified';
  $('app-version').textContent = deviceReport?.appVersion ?? (deviceReport ? 'Device is in BOOT mode' : 'Not identified');
  $('compatibility-message').textContent = deviceReport?.message ?? 'Identify the connected device to see available actions.';
  $('compatibility-rule').textContent = deviceReport ? `${deviceReport.profileId ?? 'No supported rule'} · registry ${deviceReport.registryRevision} · ${deviceReport.code}` : 'No device rule selected.';
  $('compatibility').classList.toggle('unsupported', !!deviceReport && !deviceReport.supported);
  for (const [id, prefix] of [['app-reset','app'], ['image','image'], ['video','video']]) {
    const action = actionStatuses.find(a => a.id === id);
    $('action-' + prefix + '-state').textContent = !deviceReport ? 'Identify device first' :
      !action?.policySupported ? 'Unsupported BOOT version' : !action.implemented ? 'Not available in this tool' :
      !deviceReport.supported ? 'Blocked by compatibility check' : 'Available · live checks required';
    $('action-' + prefix + '-detail').textContent = !deviceReport ? 'Available actions appear after the version query.' : action?.description ?? deviceReport.message;
  }
}
function showPreference() {
  $('orientation-feedback').textContent = !preference.available ? 'This choice is kept for this page only; Chrome could not save the preference.' :
    preference.origin === 'default' ? 'First use: Portrait. Changes are remembered in this Chrome profile.' :
    preference.origin === 'remembered' ? 'Using your last setting in this Chrome profile. You can change it here.' :
    'Saved for next time in this Chrome profile.';
}
showPreference();
const bytes = n => n.toLocaleString('en-US') + ' bytes';
const stageNames = { DISCOVERY:'Checking device', MCU_ERASE:'Erasing APP', MCU_PROGRAM:'Programming APP', MCU_VERIFY:'Verifying Flash', MCU_COMMIT:'Committing update', YMODEM:'Sending package', YMODEM_COMPLETE:'Transfer complete', COMPLETE:'Update complete' };
function status(title, detail, mode = '') {
  $('status').textContent = title; $('detail').textContent = detail; $('result').className = 'result ' + mode;
  $('state-label').textContent = mode === 'error' ? 'ACTION REQUIRED' : mode === 'success' ? 'COMPLETE' : busy ? 'IN PROGRESS' : 'READY';
}
function applyState() {
  const editable = engineReady && !busy && !blocked;
  $('state-label').textContent = $('result').classList.contains('error') ? 'ACTION REQUIRED' : $('result').classList.contains('success') ? 'COMPLETE' : busy ? 'IN PROGRESS' : 'READY';
  $('firmware').disabled = !editable || step !== 2 || !deviceReport?.supported;
  $('orientation').disabled = !editable || step !== 2;
  $('choose-action-reset').disabled = !editable || step !== 1 || !selectedPort || !deviceReport?.supported || !actionStatuses.find(a => a.id === 'app-reset')?.canExecute;
  $('cancel-identify').hidden = !busy || step !== 1;
  $('cancel-identify').disabled = !busy || !channel || stopping;
  $('retry-validation').hidden = !validationFailed || step !== 2;
  $('retry-validation').disabled = !editable || !file;
  $('panel-1').setAttribute('aria-busy', String(busy && step === 1));
  $('panel-2').setAttribute('aria-busy', String(busy && step === 2));
  $('use-recommended').disabled = !editable || !inspection?.recommendedOrientation || step !== 2;
  $('connect').disabled = !editable || step !== 1 || !('serial' in navigator);
  $('update').disabled = !editable || !prepared || !selectedPort || !deviceReport?.supported || step !== 2;
  $('stop').disabled = !busy || !channel || persistent || stopping;
  $('stop').hidden = !busy;
  $('export').disabled = !journal?.current;
  $('back-firmware').disabled = !editable;
  $('retry-prepare').hidden = step !== 3 || busy || blocked || lastSuccess;
  $('retry-prepare').disabled = !editable;
  $('new-update').hidden = step !== 3 || busy || blocked || !lastSuccess;
  $('new-update').disabled = !editable;
  for (let n = 1; n <= 3; n++) {
    $('panel-' + n).hidden = n !== step;
    const button = $('step-' + n);
    button.disabled = !editable || n >= step || n === 3;
    button.classList.toggle('complete', n < step);
    if (n === step) button.setAttribute('aria-current', 'step'); else button.removeAttribute('aria-current');
  }
  $('summary-file').textContent = file?.name ?? 'Not selected';
  $('summary-orientation').textContent = orientationName($('orientation').value);
  $('step-guidance').textContent = blocked ? 'The device needs an engineering check. Returning or retrying cannot clear an unknown result.' : guidance[step];
  document.body.dataset.step = String(step);
}
function showStep(value) { step = value; applyState(); $('heading-' + value).focus(); }
function clearPort() {
  selectedPort = null; deviceReport = null; showCompatibility();
  $('port-name').textContent = 'No device identified';
  $('port-detail').textContent = '921600 baud · 8N1';
  $('port-dot').classList.remove('ready');
  $('connect').textContent = 'Connect & identify';
}
function clearPackage() { prepared = null; $('metadata').hidden = true; }
function resetProgress() {
  $('transfer').value = $('device').value = 0;
  $('transfer-label').textContent = $('device-label').textContent = '—';
  $('device-stage').textContent = 'Device verification';
  $('outcome-guide').textContent = '';
}
function showRecommendation() {
  const recommended = inspection?.recommendedOrientation === 2;
  $('recommendation').hidden = !inspection;
  $('recommendation-title').textContent = recommended ? 'HEX suggests Landscape · 800 × 480' : 'No direction hint in this HEX';
  $('recommendation-detail').textContent = recommended ? 'Based on image/video dimensions. Your selected BOOT setting stays unchanged unless you choose to use this suggestion.' :
    'No enabled image/video dimensions. Continue with your selected BOOT setting.';
  $('use-recommended').hidden = !recommended;
  $('recommendation').classList.toggle('no-advice', !recommended);
}
async function goBack(target) {
  if (busy || blocked || target >= step || target < 1) return;
  // Back always clears device authority; retained HEX is rechecked afterwards.
  busy = true; clearPackage(); clearPort(); applyState();
  try {
    await invoke('Invalidate', false); await invoke('ForgetDevice');
    resetProgress(); lastSuccess = false; persistent = false;
    log('BACK_TO_DEVICE; device identity and prepared package cleared.');
    showStep(1); status('Identify your device', 'Reconnect and identify the device again. Your selected HEX will be rechecked when you continue.');
  } catch (error) { blocked = true; status('Unable to clear preparation', cleanError(error), 'error'); }
  finally { busy = false; applyState(); }
}
async function chooseAppAction() {
  if (busy || blocked || step !== 1 || !deviceReport?.supported || !selectedPort || !actionStatuses.find(a => a.id === 'app-reset')?.canExecute) return;
  busy = true; showStep(2);
  try {
    if (source && inspection && file) await prepareFirmware();
    else status('Choose your firmware', 'APP HEX update selected for BOOT ' + deviceReport.bootVersion + '. Choose the HEX to check it automatically.');
  } finally { busy = false; applyState(); }
}
function log(text) {
  journal?.log(text); eventCount++;
  uiEvents.push(new Date().toLocaleTimeString('en-GB') + '  ' + text);
  if (uiEvents.length > 2000) uiEvents = uiEvents.slice(-1500);
  if (!uiTimer) uiTimer = setTimeout(() => { $('log').textContent = uiEvents.join('\n'); $('log').scrollTop = $('log').scrollHeight; $('log-count').textContent = eventCount + ' events'; uiTimer = null; }, 100);
}
async function inspectFirmware() {
  if (busy || blocked || !engineReady || step !== 2 || !deviceReport?.supported) return;
  busy = true; clearPackage(); source = null; inspection = null; lastSuccess = false; persistent = false; validationFailed = false;
  file = $('firmware').files[0] ?? null; $('orientation').value = preference.value;
  showPreference();
  $('filename').textContent = file?.name ?? 'Choose APP HEX';
  $('filehint').textContent = file ? bytes(file.size) : '.hex · up to 32 MiB';
  $('inspection-status').className = 'inline-status'; resetProgress(); showRecommendation(); applyState();
  try {
    await invoke('Invalidate', true);
    if (!file) {
      $('inspection-status').textContent = 'Choose a HEX to check and prepare it automatically.';
      status('Choose your firmware', 'File checks run automatically on this computer.'); return;
    }
    if (!/\.hex$/i.test(file.name) || !file.size || file.size > 32 * 1024 * 1024) throw new Error('Select an APP .hex file of 1..32 MiB.');
    await journal.begin(file.name); uiEvents = []; eventCount = 0;
    log('MODE=RESET; DEVICE_ACTIONS=NOT_STARTED; BOOT setting retained: ' + orientationName($('orientation').value));
    $('inspection-status').textContent = 'Inspecting HEX and media metadata…';
    status('Inspecting firmware', 'Checking HEX checksums, vectors and bound media metadata locally.');
    await new Promise(requestAnimationFrame);
    const data = new Uint8Array(await file.arrayBuffer());
    const info = await invoke('Inspect', data);
    await persistStatus('INSPECTED_NOT_SENT', { inspection:info });
    source = data; inspection = info; showRecommendation();
    await prepareFirmware();
  } catch (error) {
    log(String(error)); source = null; inspection = null;
    $('inspection-status').className = 'inline-status error';
    $('inspection-status').textContent = cleanError(error);
    await persistStatus('INSPECTION_FAILED', { error:String(error) }).catch(() => {});
    status('HEX inspection failed', cleanError(error), 'error');
  } finally { busy = false; applyState(); }
}
async function chooseOrientation() {
  if (busy || blocked || step !== 2) return;
  busy = true; clearPackage(); applyState();
  try {
    await invoke('Invalidate', false);
    preference.remember($('orientation').value); showPreference();
    if (source && inspection) await prepareFirmware();
    else status('Choose your firmware', 'BOOT update screen: ' + orientationName(preference.value) + '. Choosing a HEX starts automatic checks.');
  } catch (error) { blocked = true; status('Unable to clear preparation', cleanError(error), 'error'); }
  finally { busy = false; applyState(); }
}
async function persistStatus(value, extra = {}) {
  if (journal?.current) { Object.assign(journal.current, extra, { status: value, updated: new Date().toISOString() }); await journal.flush(); }
}
// Called inside a single busy operation: inspection, a setting change or Back.
// No idle gap may enable device selection between inspection and verification.
async function prepareFirmware() {
  clearPackage(); validationFailed = false; persistent = false; applyState();
  try {
    await journal.begin(file.name);
    log('BOOT_SCREEN_ONLY; chosen=' + orientationName($('orientation').value) + '; recommendation=' + (inspection.recommendedOrientation ?? 'NONE'));
    $('inspection-status').className = 'inline-status';
    $('inspection-status').textContent = 'HEX checked. Preparing and verifying the update package…';
    status('Preparing your update', 'Checking the update package automatically. Keep this page open; the serial port is closed.');
    await new Promise(requestAnimationFrame);
    const result = await invoke('Prepare', source, Number($('orientation').value), inspection.id);
    await persistStatus('VALIDATED_NOT_SENT', { firmware:result, inspection, bootCompatibility:deviceReport, selectedAction:'app-reset' });
    prepared = result;
    $('app-size').textContent = bytes(result.appBytes); $('app-crc').textContent = result.appCrc32;
    $('package-size').textContent = bytes(result.packageBytes);
    $('hashes').textContent = `HEX SHA-256\n${result.sourceSha256}\n\nAPP SHA-256\n${result.appSha256}\n\nPACKAGE SHA-256\n${result.packageSha256}\n\nBOOT ONLY: ${result.orientation}\nHEX gaps filled with 00: ${result.gapBytes}`;
    $('metadata').hidden = false;
    $('review-file').textContent = file.name;
    $('review-orientation').textContent = orientationName($('orientation').value);
    log('VALIDATED_NOT_SENT; no serial port opened.');
    $('inspection-status').textContent = 'HEX and update package verified. Ready to review the identified device.';
    status('Firmware verified', 'Automatic checks passed. Continue to the live device checks and final confirmation.');
  } catch (error) {
    clearPackage(); validationFailed = true; log(String(error));
    try { await invoke('Invalidate', false); }
    catch (cleanupError) { blocked = true; log('PREPARATION_CLEAR_FAILED: ' + cleanupError); }
    await persistStatus('VALIDATION_FAILED', { error:String(error) }).catch(() => {});
    $('inspection-status').className = 'inline-status error';
    $('inspection-status').textContent = 'Update package checks failed. Retry the checks or choose another HEX.';
    status('Validation failed', cleanError(error), 'error');
  }
}
function cleanError(error) { return String(error?.message ?? error).replace(/^Error: /,'').split('\n')[0]; }
async function selectPort() {
  if (busy || blocked || !engineReady || step !== 1) return;
  clearPort(); clearPackage(); busy = true; stopping = false; applyState();
  try {
    selectedPort = await navigator.serial.requestPort();
    const info = selectedPort.getInfo();
    $('port-name').textContent = info.usbVendorId ? `USB ${info.usbVendorId.toString(16).toUpperCase().padStart(4,'0')}:${(info.usbProductId ?? 0).toString(16).toUpperCase().padStart(4,'0')}` : 'Serial device selected';
    await exclusive(async () => {
      const unresolved = (await journal.list()).find(r => r.persistent && ['RUNNING','RECOVERY_STATE_UNKNOWN'].includes(r.status));
      if (unresolved) { blocked = true; throw new Error('An earlier update needs a device check. Discovery cannot clear its recovery lock.'); }
      await invoke('Invalidate', false); await invoke('ForgetDevice');
      await journal.begin('Device identification'); uiEvents = []; eventCount = 0;
      await persistStatus('IDENTIFYING', { deviceActions:'READ_ONLY_QUERY', port:info });
      status('Identifying device', 'Reading APP / BOOT versions. No update entry, reset or firmware payload is sent.');
      try {
        const result = await identifyWithRetry({
          createChannel: () => { channel = new WebSerialChannel(selectedPort, () => journal.flush()); applyState(); return channel; },
          identify: () => invoke('IdentifyDevice'),
          canceled: () => stopping,
          onAttempt: async attempt => {
            log(`IDENTIFICATION_ATTEMPT ${attempt}/2; initial synchronization; 921600 8N1`);
            await persistStatus('IDENTIFYING', { identificationAttempt:attempt });
          },
          onRetry: async result => {
            log(`IDENTIFICATION_RETRY: ${result.message}`);
            status('Reconnecting device', 'The connection did not settle. Retrying identification once; no update has started.');
            await journal.flush();
          }
        });
        deviceReport = result.device; actionStatuses = result.actions; showCompatibility();
        await persistStatus('IDENTIFIED_NOT_SENT', { bootCompatibility:deviceReport, actions:actionStatuses });
      } finally { channel = null; }
    });
    $('port-detail').textContent = 'Identified · port closed · 921600 baud'; $('port-dot').classList.add('ready');
    $('connect').textContent = 'Identify again';
    status(deviceReport.supported ? 'Device identified' : 'Update unavailable', deviceReport.message, deviceReport.supported ? '' : 'error');
  } catch (error) {
    clearPort();
    await invoke('ForgetDevice').catch(() => {});
    await persistStatus('IDENTIFICATION_FAILED', { error:cleanError(error) }).catch(() => {});
    if (error.name === 'NotFoundError') status('No device selected', 'The chooser was cancelled. No connection was opened.');
    else status('Device identification failed', cleanError(error), 'error');
  } finally { busy = false; stopping = false; applyState(); }
}
async function exclusive(action) {
  if (!navigator.locks) throw new Error('This Chrome version does not support the updater session lock.');
  return navigator.locks.request('pe0400c0-hex-update', { ifAvailable:true }, async lock => {
    if (!lock) throw new Error('Another updater tab is active. Close it before updating.');
    return await action();
  });
}
async function update() {
  if (!prepared || !selectedPort || !deviceReport?.supported || busy || blocked || step !== 2) return;
  const candidate = prepared; busy = true; persistent = false; stopping = false; lastSuccess = false; resetProgress(); showStep(3);
  $('transfer').value = $('device').value = 0; $('transfer-label').textContent = $('device-label').textContent = '0%';
  try {
    await exclusive(async () => {
      let executionStarted = false;
      try {
      const unresolved = (await journal.list()).find(r => r.id !== journal.current.id && r.persistent && ['RUNNING','RECOVERY_STATE_UNKNOWN'].includes(r.status));
      if (unresolved) { blocked = true; throw new Error('An earlier update has an unknown outcome. Export its record and inspect the device before any further update.'); }
      log(`UPDATE_REQUEST package=${candidate.packageSha256}`);
      await persistStatus('RUNNING', { port:selectedPort.getInfo(), deviceActions:'CONNECTING' });
      try { if (navigator.wakeLock) wakeLock = await navigator.wakeLock.request('screen'); }
      catch { log('Keep the computer awake; an automatic screen wake lock was unavailable.'); }
      status('Checking device', 'The APP may enter the update waiting screen. No APP payload is sent before confirmation.');
      channel = new WebSerialChannel(selectedPort, () => journal.flush());
      await channel.open(); applyState();
      executionStarted = true;
      const result = await invoke('Execute', candidate.id);
      blocked = result.recoveryRequired; lastSuccess = result.success;
      log(`${result.code}: ${result.message}`);
      await persistStatus(result.recoveryRequired ? 'RECOVERY_STATE_UNKNOWN' : result.success ? 'PASS' : result.code,
        { result, completed:new Date().toISOString() });
      status(result.success ? 'Update complete' : result.recoveryRequired ? 'Device state unknown' : 'Update not completed',
        result.success ? 'MCU verification and commit passed. BOOT performs its automatic restart.' : result.recoveryRequired ? 'Stopped without retrying. Export the session and query the device with the diagnostic tools before recovery.' : result.message,
        result.success ? 'success' : 'error');
      if (result.success) { $('device').value = 100; $('device-label').textContent = 'PASS'; }
      } catch (error) {
        blocked ||= persistent || executionStarted;
        log(String(error));
        await persistStatus(blocked ? 'RECOVERY_STATE_UNKNOWN' : 'HOST_FAILURE', { error:String(error) }).catch(() => {});
        status(blocked ? 'Device state unknown' : 'Update stopped', cleanError(error), 'error');
      } finally {
        // The cross-tab lock covers opening, protocol, journal and port teardown.
        if (channel) {
          try { await channel.close(); log('Serial port closed.'); }
          catch (error) { blocked = true; log('PORT_RELEASE_FAILED: ' + error); $('detail').textContent += ' Port release failed; close Chrome before using another tool.'; }
        }
        channel = null;
        try { await wakeLock?.release(); } catch {} wakeLock = null;
        await journal?.flush().catch(() => { blocked = true; $('detail').textContent += ' Log storage failed; export the available record.'; });
      }
    });
  } catch (error) {
    log(String(error));
    status('Update not started', cleanError(error), 'error');
  } finally {
    prepared = null; clearPort();
    if (!blocked) {
      try { await invoke('Invalidate', false); }
      catch (error) { blocked = true; log('PREPARATION_CLEAR_FAILED: ' + error); }
    }
    if (blocked) {
      $('outcome-guide').textContent = 'Export the log and have the device checked. Returning, reloading and retrying cannot clear an unknown update result.';
    } else if (lastSuccess) {
      $('outcome-guide').textContent = 'Export the log. For another update, start again and select the HEX and device afresh.';
    } else {
      $('outcome-guide').textContent = 'This session ended. Return to Device for fresh identification and automatic firmware checks. A previous confirmation is never reused.';
    }
    busy = false; applyState();
  }
}
async function exportLog() {
  try {
    const record = await journal.export();
    const blob = new Blob([JSON.stringify(record,null,2)], { type:'application/json' });
    const url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = `HexUpdater-${record.run.started.replace(/[:.]/g,'-')}.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch (error) { status('Log export failed', cleanError(error), 'error'); }
}
let signalEngineInitialized;
const engineInitialized = new Promise(resolve => { signalEngineInitialized = resolve; });
window.hexWeb = {
  engineInitialized() { signalEngineInitialized(); },
  log,
  compatibility(report) { deviceReport = report; showCompatibility(); if (journal?.current) journal.current.bootCompatibility = report; },
  progress(stage, percent) {
    if (stage === 'PERSISTENT_BOUNDARY') {
      persistent = true; journal.current.persistent = true; journal.current.deviceActions = 'PAYLOAD_MAY_BE_SENT';
      $('stop').disabled = true; applyState(); status('Updating device', 'Writing may have started. Keep the device connected and wait for the final result.'); return;
    }
    const value = Math.max(0, Math.min(100, percent));
    if (stage.includes('YMODEM') || stage.includes('RECEIVING')) { $('transfer').value = value; $('transfer-label').textContent = value + '%'; }
    else if (stage.startsWith('MCU_') || stage === 'COMPLETE') {
      $('device').value = value; $('device-label').textContent = value + '%'; $('device-stage').textContent = stageNames[stage] ?? stage;
    }
  },
  readByte(timeout) { if (!channel) throw new Error('No active serial channel.'); return channel.readByte(timeout); },
  write(data) { if (!channel) throw new Error('No active serial channel.'); return channel.write(data); },
  confirm(summary) {
    $('confirm-summary').textContent = `APP HEX: ${journal.current.filename}\nBOOT screen only: ${orientationName($('orientation').value)}\n${summary}`;
    $('confirmation').returnValue = 'cancel';
    return new Promise(resolve => { resolveConfirmation = resolve; $('confirmation').showModal(); $('confirmation').querySelector('[value="cancel"]').focus(); });
  }
};
$('confirmation').addEventListener('close', () => { const resolve = resolveConfirmation; resolveConfirmation = null; resolve?.($('confirmation').returnValue === 'update'); });
$('confirmation').addEventListener('cancel', e => { e.preventDefault(); $('confirmation').close('cancel'); });
$('confirmation').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('confirmation').close('cancel'); } });
$('firmware').addEventListener('change', inspectFirmware); $('orientation').addEventListener('change', chooseOrientation);
$('use-recommended').addEventListener('click', () => { if (!busy && !blocked && step === 2 && inspection?.recommendedOrientation) { $('orientation').value = String(inspection.recommendedOrientation); chooseOrientation(); } });
$('back-firmware').addEventListener('click', () => goBack(1));
$('retry-prepare').addEventListener('click', () => goBack(1));
for (let n = 1; n <= 2; n++) $('step-' + n).addEventListener('click', () => goBack(n));
$('new-update').addEventListener('click', async () => {
  if (busy || blocked || !lastSuccess) return;
  busy = true; applyState();
  try {
    await invoke('Invalidate', true);
    clearPackage(); clearPort(); await invoke('ForgetDevice'); source = null; inspection = null; file = null; lastSuccess = false; persistent = false; validationFailed = false;
   
    $('firmware').value = ''; $('orientation').value = preference.value; $('filename').textContent = 'Choose APP HEX'; $('filehint').textContent = '.hex · up to 32 MiB';
    $('inspection-status').textContent = 'Choose a HEX to check and prepare it automatically.';
    resetProgress(); showRecommendation(); showPreference(); showStep(1); status('Identify your device', 'Connect and identify the device for a new update.');
  } catch (error) { blocked = true; status('Unable to start again', cleanError(error), 'error'); }
  finally { busy = false; applyState(); }
});
$('choose-action-reset').addEventListener('click', chooseAppAction);
$('cancel-identify').addEventListener('click', () => { if (busy && channel && step === 1) { stopping = true; applyState(); invoke('Cancel').catch(error => log(String(error))); } });
$('retry-validation').addEventListener('click', inspectFirmware); $('connect').addEventListener('click', selectPort);
$('update').addEventListener('click', update); $('export').addEventListener('click', exportLog);
$('stop').addEventListener('click', () => {
  if (!busy || persistent || stopping || !channel) return;
  stopping = true; applyState();
  if ($('confirmation').open) $('confirmation').close('cancel');
  invoke('Cancel').catch(error => log(String(error)));
});
navigator.serial?.addEventListener('disconnect', event => {
  if ((event.port ?? event.target) !== selectedPort) return;
  if (busy) {
    log('Selected serial device disconnected.');
    if (step === 1) stopping = true;
    if ($('confirmation').open) $('confirmation').close('cancel');
    if (!persistent) invoke('Cancel').catch(error => log(String(error)));
  } else {
    clearPort(); clearPackage(); invoke('ForgetDevice').catch(error => log(String(error))); showStep(1); status('Device disconnected', 'Reconnect and identify the device again before updating.', 'error'); applyState();
  }
});
window.addEventListener('beforeunload', e => { if (busy) { e.preventDefault(); e.returnValue = ''; } });
document.addEventListener('visibilitychange', () => { if (busy && document.hidden) log('Page hidden. Keep Chrome and the computer running until the final result.'); });

try {
  if (!isSecureContext) throw new Error('Open this tool through localhost or HTTPS in Chrome.');
  journal = await JournalStore.open();
  const runs = await journal.list();
  const unresolved = runs.find(r => r.persistent && ['RUNNING','RECOVERY_STATE_UNKNOWN'].includes(r.status));
  if (unresolved) {
    blocked = true; journal.current = unresolved;
    $('environment').className = 'notice error'; $('environment').textContent = 'A previous update has an unknown outcome. Export its record and inspect the device with the diagnostic tools before another update.';
  }
  let bootFailure = null;
  const loadBootResource = createBootResourceLoader({
    onProgress: count => {
      if (!blocked && !bootFailure) $('environment').textContent = 'Loading the validation engine… ' + count + ' files checked.';
    },
    onRetry: (name, attempt) => {
      log('ENGINE_DOWNLOAD_RETRY ' + attempt + ': ' + name);
      if (!blocked && !bootFailure) $('environment').textContent = 'Retrying a validation engine download…';
    },
    onFailure: error => {
      bootFailure = error;
      $('environment').className = 'notice error';
      $('environment').textContent = 'Unable to load the validation engine. Reload this page to try again.';
      status('Unable to start', cleanError(error), 'error');
      log(cleanError(error)); applyState();
    }
  });
  await startValidationEngine(async () => {
    await Blazor.start({ loadBootResource });
    await engineInitialized;
  });
  if (bootFailure) throw bootFailure;
  if (!blocked) {
    const policy = await invoke('GetCompatibility'); actionStatuses = policy.actions; showCompatibility();
    const serial = 'serial' in navigator;
    $('environment').textContent = serial ? 'Ready in Chrome. Connect & identify performs a read-only version query. Updates require firmware checks and final confirmation.' : 'Web Serial is unavailable. Open this page in a current desktop Chrome browser to identify the device and continue.';
    if (!serial) $('environment').className = 'notice error';
    status('Identify your device', 'Connect the device to read its BOOT version and see the available update actions.');
  } else status('Device check required', 'The earlier session may have written device memory. Automatic retry is blocked.', 'error');
  engineReady = true;
  applyState();
  if (new URLSearchParams(location.search).get('qa') === '1') await import('./qa.js').then(m => m.runQa(invoke, journal));
} catch (error) {
  engineReady = false;
  $('environment').className = 'notice error'; $('environment').textContent = 'Startup failed: ' + cleanError(error);
  status('Unable to start', 'Use the official HTTPS site or supplied local launcher in a current Chrome browser. ' + cleanError(error), 'error');
  applyState();
}
