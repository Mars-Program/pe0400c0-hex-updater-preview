import { fieldPreflight, FirstWire } from './first-install.js';

const hardwareId = s => typeof s === 'string' && /^[0-9A-F]{16}$/.test(s);
const refuse = message => ({kind:'pending', message});
const minimalSha = '248BB8B72C2C8F9E5C7AF75F5BCD4B3E4A8DB0AF0F7D1F3B2A279EB41BA8D864';

function writtenTarget(run) {
  const target=run.recoveryCommit;
  if (!run.persistent || !target || !hardwareId(target.board)) return null;
  if (run.selectedAction === 'usb-first') {
    if (run.backup?.board !== target.board || target.version !== '0.1.4' || target.generation !== 1 ||
        target.crc !== '4891E8BA' || target.imageBytes !== 4016 || target.packageSha256 !== minimalSha ||
        !/^@UPD,RESULT,RESET,V1,PASS,PORTRAIT_NATIVE,APP,00000FB0,4891E8BA,VLY4,A,00000001,[0-9A-F]{8},ABR1,00000001,[0-9A-F]{8},314F4145,OK$/.test(target.terminal)) return null;
  } else {
    if (run.selectedAction !== 'app-preserve' || run.recoverySource?.board !== target.board ||
        run.recoverySource?.boot !== target.boot || run.firmware?.appCrc32 !== target.crc ||
        run.firmware?.appBytes !== target.imageBytes || run.firmware?.packageSha256 !== target.packageSha256 ||
        !/^@UPD,RESULT,APP,V5,[0-9A-F]{8},PASS,PRESERVE,[0-9A-F]{8},[0-9A-F]{8},[0-9A-F]{8},[0-9A-F]{8},NEW_AUTHORITY$/.test(target.terminal) ||
        parseInt(target.terminal.split(',')[7],16) !== target.generation) return null;
  }
  return target;
}

function unchangedSource(record) {
  const {run,events}=record, source=run.recoverySource;
  if (!hardwareId(source?.board) || run.persistent !== false || run.boardCode !== 'EAO-R02' ||
      !source.version || !events.every((e,i)=>e.id===run.id && e.seq===i) ||
      events.some(e=>/PERSISTENT_BOUNDARY|PAYLOAD_MAY_BE_SENT|,EXECUTE,|,CONFIRM,|NEW_AUTHORITY/.test(e.text))) return null;
  const refused=run.selectedAction === 'app-preserve' && run.result?.code === 'DEVICE_CHECK_REQUIRED' &&
    events.some(e=>e.text === 'RX @UPD,RESULT,APP,V5,00000000,FAIL,PREPARE,SNAPSHOT,SAFE_NO_MUTATION');
  const readOnlyBoot=run.deviceActions==='BOOT_IDENTITY_ROUND_TRIP';
  return refused || readOnlyBoot ? {...source,imageBytes:0x800000} : null;
}

export async function assessRecovery(records, live, wire) {
  if (!records.length || records.some(r=>r.journalError)) return refuse('待查紀錄讀取不完整，請保留原紀錄。');
  const record=records.find(r=>r.run.selectedAction==='usb-first' && r.run.priorPreflightId) ?? records[0];
  const {run}=record;
  if (records.length!==1) {
    const predecessor=records.find(r=>r.run.id===run.priorPreflightId);
    if (records.length!==2 || !predecessor || !fieldPreflight(predecessor) || !writtenTarget(run))
      return refuse('工作站有多筆尚待確認的更新，無法將它們歸到同一次操作。');
  }
  if (live.board!=='EAO-R02') return refuse('已讀取裝置。這筆待查更新缺少可與本板核對的交易與板卡證據。');
  if (live.mode==='boot') {
    if (records.length!==1 || !fieldPreflight(record))
      return refuse('已辨識 BOOT。待查操作缺少可供首裝的寫入前拒絕證據；請查驗原交易與已提交的 APP。');
    const identity=await wire.capability(live.boot);
    if (run.recoverySource && run.recoverySource.board!==identity.board)
      return refuse('目前板卡識別碼與原操作不同。');
    if (!await wire.matchesFirstInstallMedia()) return refuse('板上更新紀錄與已知首裝狀態不同，請查驗 FRAM／NOR。');
    return {kind:'first',board:identity.board,message:'已核對 BOOT、啟用狀態及首裝紀錄。請確認同一塊板，繼續備份與安裝最小 APP 0.1.4。'};
  }
  const target=writtenTarget(run) ?? unchangedSource(record);
  if (!target) return refuse('APP 已回應。原交易缺少可核對的板卡識別碼、MCU 提交證明或寫入前查驗證據。');
  if (live.mode!=='app' || target.crc!==live.crc || target.generation!==live.generation ||
      (target.version && target.version!==live.version) || live.maxPc < 0x90000000 ||
      live.maxPc-0x90000000>=target.imageBytes) return refuse('目前 APP 的版本、generation、CRC 或執行位址與原交易不符。');
  return {kind:'verify',target,message:'兩次 APP 自測與原交易相符。按「核對板號並繼續」會讓 APP 暫時進入 BOOT 讀取板號，隨後返回並再次查驗 APP。'};
}

export { FirstWire };
