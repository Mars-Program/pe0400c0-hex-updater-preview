import { WebSerialChannel } from './channel.js';
import { JournalStore, requiresDeviceInspection } from './journal.js';

const MIN_SHA = '248BB8B72C2C8F9E5C7AF75F5BCD4B3E4A8DB0AF0F7D1F3B2A279EB41BA8D864';
const SCHEMA = 'EAO-R02-first-backup-v1';
const encoder = new TextEncoder();
const hex = a => Array.from(a, n => n.toString(16).padStart(2, '0')).join('').toUpperCase();
const field = n => n.toString(16).toUpperCase().padStart(8, '0');
function requireThat(ok, message) { if (!ok) throw new Error(message); }
function bytes(s, count) {
  requireThat(typeof s === 'string' && s.length === count * 2 && /^[0-9A-F]+$/.test(s), 'Invalid backup data or size.');
  return Uint8Array.from(s.match(/../g), v => parseInt(v, 16));
}
const sha = async data => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', data)));
const beginLine = b => `@FIRST,V1,BEGIN,${b.session},${b.board},${b.boot},8192,65536,ACT_GCM32`;
async function backupHash(b) {
  requireThat(b.schema === SCHEMA && b.norOffset === 0 && b.framBytes === 8192 && b.norBytes === 65536 &&
    /^[A-F0-9]{16}$/.test(b.board) && /^[A-F0-9]{8}$/.test(b.session) && b.session !== '00000000' &&
    /^0\.1\.(0|[1-9][0-9]{0,2})$/.test(b.boot) && Number(b.boot.split('.')[2]) <= 255, 'Invalid backup identity.');
  const header = encoder.encode(beginLine(b) + '\r\n');
  const payload = new Uint8Array(header.length + 32 + 8188 + 65536);
  payload.set(header); payload.set(bytes(b.activationCapsule, 32), header.length);
  payload.set(bytes(b.framFrom4, 8188), header.length + 32);
  payload.set(bytes(b.nor, 65536), header.length + 32 + 8188);
  return sha(payload);
}
export async function verifySaved(file, reference) {
  requireThat(file.size > 0 && file.size < 170000, 'Saved backup file size is invalid.');
  const disk = JSON.parse(await file.text());
  requireThat(disk.board === reference.board && disk.session === reference.session && disk.boot === reference.boot &&
    disk.sha256 === reference.sha256 && await backupHash(disk) === reference.sha256, 'Saved backup differs from the board snapshot.');
  return disk.sha256;
}
export async function checkPackage(file) {
  requireThat(file?.size === 3351 && /\.dataimgRESET$/i.test(file.name), 'Select the minimal APP 0.1.4 .dataimgRESET file.');
  const p = new Uint8Array(await file.arrayBuffer());
  requireThat(await sha(p) === MIN_SHA, 'The selected file does not match the released minimal APP 0.1.4.');
  return p;
}

export class FirstWire {
  constructor(channel) { this.channel = channel; }
  async command(text) { await this.channel.write(encoder.encode(text + '\r')); }
  async line(timeout = 8000) {
    const end = Date.now() + timeout;
    let s = '';
    while (Date.now() < end) {
      const c = await this.channel.readByte(Math.max(1, Math.min(250, end-Date.now())));
      if (c < 0 || c === 13) continue;
      if (c === 10) { if (s) return s; continue; }
      if (!s && (c === 67 || c === 0)) continue;
      requireThat(c >= 32 && c <= 126 && s.length < 1024, 'Invalid USB response.');
      s += String.fromCharCode(c);
    }
    throw new Error('BOOT did not reply in time. The command was not repeated.');
  }
  async expect(expected) {
    const line = await this.line();
    requireThat(line === expected, line.startsWith('@FIRST,V1,FAIL,') ? line : 'Unexpected BOOT reply.');
  }
  async receiverReady() {
    const deadline=Date.now()+3500;
    while (Date.now()<deadline) {
      const v=await this.channel.readByte(Math.max(1,Math.min(250,deadline-Date.now())));
      if (v===67) return;
      requireThat(v===-1,'Expected the idle BOOT receiver boundary.');
    }
    throw new Error('BOOT receiver readiness was not confirmed.');
  }
  async identify() {
    await this.receiverReady();
    await this.command('*,MAINT,QUERY,IDENTITY,V1');
    const end = Date.now()+6000;
    let first;
    for (let i=0; i<80 && Date.now()<end; ++i) {
      const s=await this.line(end-Date.now());
      if (s.startsWith('@EAO,BOARD,')) { first=s; break; }
    }
    const id = /^@EAO,BOARD,V1,EAO_MLD_R02,BOOT,(0\.1\.(0|[1-9][0-9]{0,2})),BASE,PE0400C0_4\.0\.16,DISPLAY,HEADLESS$/.exec(first);
    requireThat(id && Number(id[2]) <= 255, 'Select an activated EAO-R02 in BOOT mode.');
    const version = id[1];
    for (const s of ['@EAO,STORAGE,V1,READY,1,FAULT,NONE,NOR,EF4019,33554432,FRAM,8192,CONTRACT_WINDOW,512,WP,PC13',
      '@BOOT_v'+version.replaceAll('.','_'), '@FLASH,JEDEC,EF4019,33554432,4,1','@BOOT,PACKAGE,V1,EXT4,314F4145',
      '@BOOT,RESET,V1,DIMGRESET1,STREAM32K,DISPLAY1_2,314F4145','@BOOT,IDENTITY,V1,OK']) await this.expect(s);
    await this.receiverReady();
    return this.capability(version);
  }
  async capability(version) {
    await this.command('*,FIRST,V1,CAP');
    let cap;
    try { cap = await this.line(3500); } catch { throw new Error('BOOT '+version+' did not advertise USB first install. BOOT 0.1.2 needs the one-time SWD upgrade.'); }
    const prefix = '@FIRST,V1,CAP,EAO_MLD_R02,'+version+',314F4145,EF4019,8192,65536,MIN_0.1.4,';
    requireThat(cap.startsWith(prefix) && /^[0-9A-F]{16},MATCH$/.test(cap.slice(prefix.length)), 'USB first-install capability or activation mismatch.');
    return { boot:version, board:cap.slice(prefix.length,-6) };
  }
  async matchesFirstInstallMedia() {
    await this.command('*,UPD,QUERY,MEDIA,V1');
    const lines = [];
    for (let i = 0; i < 16; i++) {
      const line = await this.line(4000);
      if (!line.startsWith('@UPD,MEDIA,')) return false;
      lines.push(line);
      if (line.startsWith('@UPD,MEDIA,END,')) break;
    }
    // Entire reviewed transcript, including geometry, six records, four catalogs
    // and the MCU's CRC32. The provisioning page repeats admission from its backup.
    return await sha(encoder.encode(lines.join('\r\n') + '\r\n')) ===
      '38957B46C6CDCEF5F666BE24555B84A4485802ED86FAB3EB41F03DB668ED4D22';
  }
  async backup(id, onProgress) {
    await this.command('*,FIRST,V1,BACKUP');
    const first = await this.line();
    requireThat(!first.startsWith('@FIRST,V1,FAIL,'), 'BOOT refused the backup. Check for an installed APP, pending update, or storage error.');
    const session = first.split(',')[3];
    const b = { schema:SCHEMA, ...id, session, framBytes:8192, norOffset:0, norBytes:65536 };
    requireThat(/^[0-9A-F]{8}$/.test(session) && session !== '00000000' && first === beginLine(b), 'Backup session or storage ranges differ.');
    for (const [region, start, end, key] of [['A',0,32,'activationCapsule'], ['F',4,8192,'framFrom4'], ['N',0,65536,'nor']]) {
      const chunks = [];
      for (let at=start; at<end; at+=128) {
        const line = await this.line();
        const prefix = '@FIRST,V1,DATA,'+region+','+field(at)+',';
        requireThat(line.startsWith(prefix), 'Missing, duplicate or out-of-order backup frame.');
        const data = line.slice(prefix.length);
        bytes(data, Math.min(128, end-at)); chunks.push(data);
        if (region==='N' && at%4096===0) onProgress?.('Reading NOR '+at+' / 65536');
      }
      b[key]=chunks.join('');
    }
    b.sha256 = await backupHash(b);
    await this.expect('@FIRST,V1,END,'+session+','+b.sha256);
    return b;
  }
  async stage(b, packageBytes) {
    requireThat(packageBytes.length===3351 && await sha(packageBytes)===MIN_SHA, 'Minimal APP bytes changed.');
    for (let at=0; at<packageBytes.length; at+=128) {
      const part=packageBytes.subarray(at,at+128);
      await this.command('*,FIRST,V1,LOAD,'+b.session+','+field(at)+','+hex(part));
      await this.expect('@FIRST,V1,LOADED,'+b.session+','+field(at+part.length));
    }
  }
  async install(b, markPersistent, onProgress, recordCommit) {
    await markPersistent();
    await this.command('*,FIRST,V1,INSTALL,'+b.session+','+b.sha256);
    await this.expect('@FIRST,V1,INSTALLING,'+b.session+',MIN_0.1.4');
    const limits={ERASE:1,PROGRAM:4016,VERIFY:1,COMMIT:3}, seen={};
    // BREAK recovery is armed by the verified preservation frame at the end of the wire transaction.
    this.channel.expectResetAfter('@FIRST,V1,DONE,00000001,4891E8BA,PROTECTED_MATCH');
    let result;
    for (let count=0; count<80; ++count) {
      const line=await this.line(20000);
      if (line.startsWith('@UPD,RESULT,RESET,')) { result=line; break; }
      const m=/^@UPD,MCU,RESET,V1,(ERASE|PROGRAM|VERIFY|COMMIT),(0|[1-9][0-9]*),(0|[1-9][0-9]*)$/.exec(line);
      requireThat(m && +m[3]===limits[m[1]] && +m[2]<=+m[3] && +m[2]>=(seen[m[1]]??0), 'Invalid MCU progress.');
      seen[m[1]]=+m[2]; onProgress?.(m[1]+' '+m[2]+' / '+m[3]);
    }
    requireThat(Object.keys(limits).every(k=>seen[k]===limits[k]) &&
      /^@UPD,RESULT,RESET,V1,PASS,PORTRAIT_NATIVE,APP,00000FB0,4891E8BA,VLY4,A,00000001,[0-9A-F]{8},ABR1,00000001,[0-9A-F]{8},314F4145,OK$/.test(result),
      'BOOT verification or commit was incomplete.');
    await this.expect('@FIRST,V1,DONE,00000001,4891E8BA,PROTECTED_MATCH');
    if (recordCommit) await recordCommit({board:b.board, boot:b.boot, generation:1, crc:'4891E8BA', imageBytes:4016,
      packageSha256:MIN_SHA, version:'0.1.4', terminal:result});
    const firstTick=await this.runningApp();
    this.channel.expectReset(false);
    await this.command('*,EAO,APP,INFO,V1');
    requireThat(await this.runningApp()>firstTick, 'Minimal APP did not confirm a later running tick.');
  }
  async runningApp() {
    const end=Date.now()+20000;
    for (let i=0; i<150 && Date.now()<end; ++i) {
      const line=await this.line(end-Date.now());
      if (!line.startsWith('@EAO,APP,INFO,')) continue;
      const m=/^@EAO,APP,INFO,V1,EAO_MLD_R02,VERSION,0\.1\.4,PC,(9[0-9A-F]{7}),VTOR,90000000,MSP,([0-9A-F]{8}),TICK,([0-9]+),BHO,1,GEN,1,CRC,4891E8BA,SELFTEST,PASS,RX_ERRORS,0$/.exec(line);
      requireThat(m && parseInt(m[1],16)<0x90000fb0 && parseInt(m[2],16)>0x20000000 &&
        parseInt(m[2],16)<=0x20020000 && !(parseInt(m[2],16)&7), 'Restarted APP identity or XIP self-test failed.');
      return Number(m[3]);
    }
    throw new Error('Minimal APP startup confirmation was not received.');
  }
}

const REFUSED='@UPD,RESULT,APP,V5,00000000,FAIL,PREPARE,SNAPSHOT,SAFE_NO_MUTATION';
export function fieldPreflight({run,events,journalError}) {
  if (journalError || !/^0\.1\.(0|[1-9]\d{0,2})$/.test(run.version) || Number(run.version.split('.')[2])>255 ||
      run.boardCode!=='EAO-R02' || run.selectedAction!=='app-preserve' ||
      run.status!=='RECOVERY_STATE_UNKNOWN' || run.persistent!==false || run.requiresDeviceCheck!==true ||
      run.deviceActions!=='CONNECTING' || run.result?.code!=='DEVICE_CHECK_REQUIRED' ||
      run.port?.usbVendorId!==0x403 || run.port?.usbProductId!==0x6015 || !run.result?.message?.includes(REFUSED)) return false;
  if (!events.every((e,i)=>e.id===run.id && e.seq===i)) return false;
  const lines=events.map(e=>e.text), tx=lines.filter(s=>s.startsWith('TX '));
  const prepare=tx.at(-1), boot=lines.filter(s=>/^RX @BOOT_v0_1_(0|[1-9]\d{0,2})$/.test(s));
  const withBinding=tx.length===5 && tx[2]==='TX *,FIRST,V1,CAP' && tx[3]===tx[0];
  return (tx.length===3 || withBinding) && tx[0]==='TX *,MAINT,QUERY,IDENTITY,V1' && tx[1]===tx[0] &&
    prepare.startsWith('TX *,UPD,PREPARE,APP,V5,') && boot.length>0 && Number(boot[0].split('_').at(-1))<=255 &&
    boot.every(s=>s===boot[0]) && lines.indexOf('RX '+REFUSED)>lines.indexOf(prepare) &&
    !lines.some(s=>/PERSISTENT_BOUNDARY|PAYLOAD_MAY_BE_SENT|,EXECUTE,|,CONFIRM,|NEW_AUTHORITY/.test(s));
}

async function matchesFieldRecords(b) {
  const f=bytes(b.framFrom4,8188), n=bytes(b.nor,65536), records=new Uint8Array(540);
  let at=0;
  for (const p of [f.slice(0xdc-4,0x100-4),f.slice(0x100-4,0x180-4),f.slice(0x24-4,0x80-4),
    f.slice(0x80-4,0xdc-4),n.slice(0x400,0x420),n.slice(0x420,0x4c0)]) { records.set(p,at); at+=p.length; }
  return await sha(records)==='56EE87E7ABB08C4FFC2A057D1D6C398E8BE144AAD94F291444706E5E58D94C40';
}

async function startPage() {
  const el=id=>document.getElementById(id), say=s=>{el('state').textContent=s;};
  let port, pkg, busy=false, locked=false, journal;
  const refresh=()=>{
    el('start').disabled=busy || locked || !pkg || !port;
    el('package').disabled=el('port').disabled=busy || locked;
    el('log').disabled=!journal?.current || busy;
    el('next').hidden=busy;
  };
  try {
    requireThat(isSecureContext && navigator.serial && navigator.locks && window.showSaveFilePicker,
      '請在桌面版 Chrome 的 HTTPS 網頁或本機啟動器開啟此頁。');
    journal=await JournalStore.open();
  } catch(e) { say(e.message); locked=true; refresh(); return; }
  el('port').onclick=async()=>{
    try { port=await navigator.serial.requestPort({}); el('port-state').textContent='已選擇序列埠'; }
    catch(e) { port=null; say(e.message); } refresh();
  };
  let selection=0;
  el('package').onchange=async()=>{
    const id=++selection; pkg=null; refresh();
    try { const f=el('package').files[0], checked=await checkPackage(f);
      if (selection===id) {pkg=checked; el('file-state').textContent=f.name+' · SHA-256 已驗證';}
    } catch(e) { if (selection===id) say(e.message); } refresh();
  };
  el('log').onclick=async()=>{
    const blob=new Blob([JSON.stringify(await journal.export(),null,2)],{type:'application/json'});
    const url=URL.createObjectURL(blob), a=document.createElement('a');
    a.href=url; a.download='EAO-R02-first-install-'+journal.current.id+'.json'; a.click(); setTimeout(()=>URL.revokeObjectURL(url),2000);
  };
  el('start').onclick=async()=>{
    if (!pkg || !port || busy || locked) return;
    busy=true; refresh();
    let marked=false, active=false, success=false;
    try {
      const handle=await showSaveFilePicker({suggestedName:'EAO-R02-backup-'+crypto.randomUUID()+'.json',
        types:[{description:'EAO-R02 board backup',accept:{'application/json':['.json']}}]});
      requireThat((await handle.getFile()).size===0,'請使用新檔名，以保留先前的備份。');
      await navigator.locks.request('pe0400c0-hex-update',{ifAvailable:true},async lock=>{
        requireThat(lock,'另一個更新視窗正在使用裝置。');
        const history=await journal.list(), unresolved=history.filter(requiresDeviceInspection);
        const inspectedId=new URL(location.href).searchParams.get('inspection');
        const inspected=inspectedId ? history.find(r=>r.id===inspectedId) : null;
        if (inspectedId) requireThat(inspected?.status==='FIRST_INSTALL_AVAILABLE' && unresolved.length===1 &&
          inspected.inspects?.[0]===unresolved[0].id, '先前查驗已變更，請返回更新頁重新查驗。');
        const info=port.getInfo();
        if (unresolved.length) {
          requireThat(unresolved.length===1 && fieldPreflight(await journal.export(unresolved[0])) &&
            info.usbVendorId===0x403 && info.usbProductId===0x6015,
            '先前操作的寫入結果尚未確認，請保留紀錄並查驗板卡。');
        }
        await journal.begin('EAO-R02 USB first install');
        active=true;
        journal.current.status='BACKUP_READ_ONLY'; journal.current.port=info;
        journal.current.boardCode='EAO-R02'; journal.current.selectedAction='usb-first';
        if (unresolved.length) journal.current.priorPreflightId=unresolved[0].id;
        await journal.flush();
        const channel=new WebSerialChannel(port,async()=>{}, {dataTerminalReady:false,requestToSend:false});
        try {
          await channel.open(); const wire=new FirstWire(channel);
          say('正在核對 BOOT、啟用狀態及儲存裝置。');
          const id=await wire.identify();
          if (inspected) requireThat(inspected.hardwareId===id.board && inspected.live?.boot===id.boot,
            '選取的板卡或 BOOT 與剛才的查驗不符。');
          journal.log('BOOT '+id.boot+' / board '+id.board+' / FIRST V1 / activation MATCH');
          const b=await wire.backup(id,say);
          if (unresolved.length) requireThat(await matchesFieldRecords(b),'新備份與先前 COM13 讀回的紀錄不同。');
          const writable=await handle.createWritable();
          try { await writable.write(JSON.stringify(b)+'\n'); await writable.close(); }
          catch(e) { await writable.abort().catch(()=>{}); throw e; }
          await verifySaved(await handle.getFile(),b);
          journal.current.backup={board:b.board,session:b.session,sha256:b.sha256,framBytes:8192,norBytes:65536};
          journal.log('Saved local backup verified. SHA-256 '+b.sha256); await journal.flush();
          el('details').textContent=handle.name+' · SHA-256 '+b.sha256;
          await wire.stage(b,pkg);
          const dlg=el('review');
          el('review-data').textContent='EAO-R02 '+id.board+' · BOOT '+id.boot+' · '+handle.name;
          el('prior').hidden=!unresolved.length;
          say('已驗證本機備份，最小 APP 已暫存在板卡 RAM。');
          const approved=await new Promise(resolve=>{
            dlg.returnValue='cancel';
            dlg.addEventListener('close',()=>resolve(dlg.returnValue==='install'),{once:true});
            dlg.showModal();
          });
          requireThat(approved,'已取消，備份已保存。');
          await wire.install(b,async()=>{
            journal.current.status='RUNNING'; journal.current.persistent=true;
            journal.current.deviceActions='FIRST_INSTALL_REQUEST';
            await journal.flush(); marked=true;
          },say,async receipt=>{
            journal.current.recoveryCommit=receipt;
            await journal.flush();
          });
          success=true;
          journal.log('RESET PASS / protected FRAM MATCH / two running minimal APP 0.1.4 reports / CRC 4891E8BA');
          for (const old of unresolved) await journal.resolveReadOnlyPreflight(old,journal.current.id,b.board);
          journal.current.status='PASS'; journal.current.completed=new Date().toISOString();
          await journal.flush();
          say('首裝完成。APP 0.1.4 已重新啟動並通過自測，CRC 為 4891E8BA。前往一般 APP 更新，選取 LCM 0.2.1 的 .dataimgAPP。');
        } finally { await channel.close(); }
      });
    } catch(e) {
      if (active) {
        locked=marked;
        if (!success || marked) journal.current.status=marked?'RECOVERY_STATE_UNKNOWN':'STOPPED_BEFORE_WRITE';
        journal.log(e.message); await journal.flush().catch(()=>{locked=true;});
      }
      say((marked?'請查驗裝置並保留備份與操作紀錄。 ':'')+e.message);
    } finally { busy=false; refresh(); }
  };
  refresh();
}
if (typeof document!=='undefined' && document.getElementById('review')) startPage();
