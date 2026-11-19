"""Stage immutable Chrome trials from verified private ZIPs; never deploy production."""
import argparse
from datetime import datetime
import gzip
import hashlib
import html
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import zipfile

SITE = 'https://mars-program.github.io/pe0400c0-hex-updater-preview/'
SOURCE = 'Mars-Program/pe0400c0-hex-updater-source'
VERSION = r'(?:0|[1-9][0-9]{0,2})\.(?:0|[1-9][0-9]{0,2})\.(?:0|[1-9][0-9]{0,2})'
ROOT_ASSETS = {'index.html', 'first-install.html', 'first-install.js', 'app.js', 'engine-loader.js', 'channel.js', 'journal.js', 'preferences.js', 'site-context.js', 'style.css'}
NOTICES = {'DotNet-LICENSE.TXT', 'DotNet-THIRD-PARTY-NOTICES.TXT'}
GATES = ['BUILD', 'OFFLINE', 'TRANSPORT', 'HARDWARE', 'HMI', 'POWER_LOSS', 'macOSExecution']


def require(ok, message):
    if not ok:
        raise ValueError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest().upper()


def json_bytes(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode('utf-8')


def safe_path(name):
    p = PurePosixPath(name)
    require(isinstance(name, str) and not p.is_absolute() and '\\' not in name
            and ':' not in name and '..' not in p.parts and str(p) == name,
            'Unsafe path: ' + str(name))
    return p


def version_ok(version):
    return bool(re.fullmatch(VERSION, version)) and all(int(x) <= 255 for x in version.split('.'))


def candidate_ok(candidate, version):
    require(version_ok(version) and re.fullmatch(re.escape(version) + r'-[0-9]{8}-[0-9]{3}', candidate),
            'Invalid candidate identity')
    datetime.strptime(candidate.split('-')[1], '%Y%m%d')
    require(candidate.split('-')[2] != '000', 'Candidate sequence must be positive')


def asset_allowed(name):
    safe_path(name)
    if name in {'notices/' + n for n in NOTICES}:
        return True
    if not name.startswith('app/'):
        return False
    plain = name[4:]
    if plain.endswith(('.gz', '.br')):
        plain = plain.rsplit('.', 1)[0]
    parts = PurePosixPath(plain).parts
    return plain in ROOT_ASSETS or (
        len(parts) == 2 and parts[0] == '_framework'
        and PurePosixPath(plain).suffix in {'.js', '.json', '.wasm'})


def private_scan(name, data):
    if name.endswith(('.gz', '.br')):
        return
    for marker in [b'C:\\TouchGFXProjects', b'C:/TouchGFXProjects', b'C:\\Users\\user',
                   b'-----BEGIN PRIVATE KEY-----']:
        require(marker not in data, 'Private build metadata: ' + name)
    require(not re.search(rb'(?:ghp_|github_pat_)[A-Za-z0-9_]{30,}', data),
            'Credential-like data: ' + name)


def record_entries(record):
    require(record['schema'] == 1 and record['channel'] == 'preview', 'Invalid preview schema')
    candidate_ok(record['candidateId'], record['version'])
    require(record['sourceRepository'] == SOURCE, 'Unexpected source repository')
    for field in ['sourceCommit', 'sourceTree']:
        require(bool(re.fullmatch('[0-9a-f]{40}', record[field])), 'Invalid ' + field)
    require(bool(re.fullmatch('[0-9A-Fa-f]{64}', record['localZipSha256'])), 'Invalid ZIP identity')
    require(bool(re.fullmatch(r'https://github\.com/' + SOURCE
                             + r'/(?:actions/runs/[0-9]+|releases/tag/[A-Za-z0-9_.-]+)',
                             record['evidenceUrl'])), 'Invalid evidence URL')
    require(bool(re.fullmatch(r'[A-Za-z0-9_.-]+\.zip', record['localZipName'])), 'Invalid ZIP filename')
    require(isinstance(record['summary'], str) and 0 < len(record['summary']) <= 1000, 'Invalid summary')
    for gate in GATES:
        require(record['validation'].get(gate) in ['PASS', 'FAIL', 'PARTIAL', 'NOT_RUN'], 'Invalid evidence gate')
    require(all(record['validation'][g] == 'PASS' for g in ['BUILD', 'OFFLINE']), 'Build and offline checks required')
    entries = {}
    folded = set()
    for item in record['files']:
        name = item['path']
        require(asset_allowed(name), 'Unexpected public asset: ' + name)
        require(name.casefold() not in folded, 'Duplicate public asset')
        require(type(item['bytes']) is int and 0 <= item['bytes'] <= 64 * 1024 * 1024, 'Invalid asset size')
        require(bool(re.fullmatch('[0-9A-Fa-f]{64}', item['sha256'])), 'Invalid asset hash')
        entries[name] = item
        folded.add(name.casefold())
    require({'app/index.html', 'app/app.js', 'app/_framework/dotnet.js'} | {
        'notices/' + n for n in NOTICES} <= set(entries), 'Required runtime/notices absent')
    return entries


def wrapper(record):
    version, candidate, summary = (html.escape(record[k], quote=True)
                                   for k in ['version', 'candidateId', 'summary'])
    return f'''<!doctype html>
<html lang="zh-Hant"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>[TEST] HEX Updater {version} · {candidate}</title>
<style>
:root{{color-scheme:light;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}}
*{{box-sizing:border-box}}body{{margin:0;background:#f5f7fb;color:#172334;height:100dvh;display:flex;flex-direction:column}}
header{{background:#fff6df;border-bottom:2px solid #d19a27;padding:12px 22px;flex:none}}
.line{{display:flex;gap:14px;align-items:center;flex-wrap:wrap}}
.tag{{background:#805300;color:white;border-radius:6px;padding:5px 10px;font-size:13px;font-weight:750;letter-spacing:.05em}}
strong{{font-size:17px}}.candidate{{font-size:13px;color:#57451e}}a{{color:#345474}}
.production{{margin-left:auto;font-size:13px}}p{{margin:7px 0 0;font-size:13px;line-height:1.5}}
details{{font-size:12px;color:#5f604f;margin-top:5px}}summary{{cursor:pointer}}
iframe{{display:block;border:0;width:100%;flex:1;min-height:420px;background:#f5f7fb}}
@media(max-width:640px){{header{{padding:10px 12px}}.production{{margin-left:0}}.line{{gap:8px}}}}
</style></head><body>
<header aria-label="測試版本資訊">
<div class="line"><span class="tag">PREVIEW · 線上測試站</span>
<strong>HEX Updater {version}</strong><span class="candidate">候選版 {candidate}</span>
<a class="production" href="https://mars-program.github.io/pe0400c0-hex-updater/" target="_blank" rel="noopener">正式網站 ↗</a></div>
<p>{summary}</p>
<details><summary>試用與版本紀錄</summary>
<p>確認這個候選版後才會更新正式站。此工具仍會實際寫入設備，請只使用一個更新工具。</p>
<p>與正式站共用本瀏覽器的設定與更新安全紀錄；本機版紀錄另存。<a href="./candidate.json" target="_blank" rel="noopener">查看版本識別</a></p>
</details></header>
<iframe title="HEX Updater 試用版" src="./app/index.html" allow="serial 'self'"></iframe>
</body></html>
'''.encode('utf-8')


def refresh_site(root, candidate):
    raw = (root / 'candidates' / candidate / 'candidate.json').read_bytes()
    record = json.loads(raw)
    (root / '.nojekyll').write_bytes(b'')
    (root / 'preview.json').write_bytes(json_bytes({
        'schema': 1, 'candidateId': candidate, 'version': record['version'],
        'candidateManifestSha256': sha(raw)}))
    (root / 'index.html').write_text(
        '<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">'
        '<meta name="robots" content="noindex,nofollow">'
        f'<meta http-equiv="refresh" content="0;url=./candidates/{candidate}/">'
        '<title>HEX Updater Preview</title></head><body>'
        f'<a href="./candidates/{candidate}/">開啟試用版 {candidate}</a></body></html>\n', encoding='utf-8')
    files = [root / n for n in ['.nojekyll', 'index.html', 'preview.json']]
    files += [p for p in (root / 'candidates').rglob('*') if p.is_file()]
    entries = [{'path': p.relative_to(root).as_posix(), 'bytes': p.stat().st_size,
                'sha256': sha(p.read_bytes())} for p in sorted(files)]
    (root / 'SHA256SUMS.json').write_bytes(json_bytes({'schema': 1, 'channel': 'preview', 'files': entries}))


def stage(root, archive, identity_path, candidate, summary):
    root, archive = Path(root).resolve(), Path(archive).resolve()
    if (root / 'SHA256SUMS.json').exists():
        validate(root)
    identity = json.loads(Path(identity_path).read_text(encoding='utf-8-sig'))
    require(sha(archive.read_bytes()) == identity['localZipSha256'].upper(), 'ZIP hash differs from build identity')
    version = identity['version']
    candidate_ok(candidate, version)
    destination = root / 'candidates' / candidate
    require(not destination.exists(), 'Candidate is immutable; choose a new ID')
    payload = {}
    with zipfile.ZipFile(archive) as z:
        infos = z.infolist()
        require(len(infos) <= 10000 and sum(i.file_size for i in infos) <= 512 * 1024 * 1024, 'ZIP exceeds size limit')
        names = [i.filename for i in infos]
        require(len({n.casefold() for n in names}) == len(names), 'Duplicate ZIP entries')
        for i in infos:
            safe_path(i.filename)
            require(not i.is_dir() and not stat.S_ISLNK(i.external_attr >> 16), 'Unsafe ZIP entry')
        manifests = [n for n in names if n.endswith('/SHA256SUMS.json') and len(PurePosixPath(n).parts) == 2]
        require(len(manifests) == 1, 'Expected one delivery manifest')
        prefix = manifests[0].rsplit('/', 1)[0] + '/'
        require(all(n.startswith(prefix) for n in names), 'Mixed ZIP roots')
        manifest = json.loads(z.read(manifests[0]))
        require(manifest['version'] == version, 'ZIP version differs from build identity')
        expected = {manifests[0]}
        folded = set()
        for item in manifest['files']:
            name = item['path']
            safe_path(name)
            require(name.casefold() not in folded, 'Duplicate delivery manifest entry')
            folded.add(name.casefold())
            data = z.read(prefix + name)
            require(len(data) == item['bytes'] and sha(data) == item['sha256'].upper(), 'ZIP manifest mismatch: ' + name)
            expected.add(prefix + name)
            target = 'app/' + name[8:] if name.startswith('wwwroot/') else (
                'notices/' + name if name in NOTICES else None)
            if target:
                require(asset_allowed(target), 'Unexpected public asset: ' + target)
                private_scan(target, data)
                payload[target] = data
        require(set(names) == expected, 'Unmanifested ZIP files')
    record = {k: identity[k] for k in ['version', 'sourceRepository', 'sourceCommit', 'sourceTree',
                                      'localZipName', 'localZipSha256', 'evidenceUrl', 'validation']}
    record.update({'schema': 1, 'channel': 'preview', 'candidateId': candidate, 'summary': summary,
                   'files': [{'path': n, 'bytes': len(b), 'sha256': sha(b)} for n, b in sorted(payload.items())]})
    record_entries(record)
    private_scan('candidate.json', json_bytes(record))
    for name, data in payload.items():
        if name.endswith('.gz'):
            require(gzip.decompress(data) == payload[name[:-3]], 'Compressed asset differs')
    destination.mkdir(parents=True)
    for name, data in payload.items():
        output = destination / name
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(data)
    (destination / 'candidate.json').write_bytes(json_bytes(record))
    (destination / 'index.html').write_bytes(wrapper(record))
    refresh_site(root, candidate)
    return record


def validate(root, base_ref=None, out=None):
    root = Path(root).resolve()
    selected = json.loads((root / 'preview.json').read_bytes())
    manifest = json.loads((root / 'SHA256SUMS.json').read_bytes())
    require(manifest['schema'] == 1 and manifest['channel'] == 'preview', 'Invalid site manifest')
    expected = {'.nojekyll', 'index.html', 'preview.json'}
    candidates = {}
    require((root / 'candidates').is_dir(), 'No preview candidates')
    for folder in (root / 'candidates').iterdir():
        require(folder.is_dir() and not folder.is_symlink(), 'Unsafe candidate directory')
        raw = (folder / 'candidate.json').read_bytes()
        record = json.loads(raw)
        private_scan('candidate.json', raw)
        require(record['candidateId'] == folder.name, 'Candidate folder mismatch')
        entries = record_entries(record)
        require((folder / 'index.html').read_bytes() == wrapper(record), 'Preview wrapper differs')
        for name, item in entries.items():
            path = folder / name
            require(path.is_file() and not path.is_symlink() and path.resolve().is_relative_to(folder.resolve()), 'Unsafe asset')
            data = path.read_bytes()
            require(len(data) == item['bytes'] and sha(data) == item['sha256'].upper(), 'Candidate asset hash mismatch: ' + name)
            private_scan(name, data)
            if name.endswith('.gz'):
                require(gzip.decompress(data) == (folder / name[:-3]).read_bytes(), 'Compressed asset differs')
        expected |= {'candidates/' + folder.name + '/' + n for n in [*entries, 'candidate.json', 'index.html']}
        candidates[folder.name] = record
        if folder.name == selected['candidateId']:
            require(sha(raw) == selected['candidateManifestSha256'] and record['version'] == selected['version'], 'Selected candidate identity differs')
    require(selected['candidateId'] in candidates, 'Selected candidate absent')
    require(f'url=./candidates/{selected["candidateId"]}/' in (root / 'index.html').read_text(encoding='utf-8'), 'Stable route differs')
    actual = {'candidates/' + p.relative_to(root / 'candidates').as_posix()
              for p in (root / 'candidates').rglob('*') if p.is_file()}
    require(actual == {n for n in expected if n.startswith('candidates/')}, 'Unlisted preview file')
    listed = {}
    for item in manifest['files']:
        name = item['path']
        safe_path(name)
        require(name in expected and name not in listed, 'Unexpected or duplicate site file')
        path = root / name
        require(not path.is_symlink() and path.resolve().is_relative_to(root), 'Unsafe site path')
        data = path.read_bytes()
        require(len(data) == item['bytes'] and sha(data) == item['sha256'].upper(), 'Site manifest mismatch')
        listed[name] = item
    require(set(listed) == expected, 'Site manifest incomplete')
    require(sum(v['bytes'] for v in listed.values()) <= 950 * 1024 * 1024, 'Preview publication exceeds Pages size budget')
    if base_ref and set(base_ref) != {'0'}:
        require(bool(re.fullmatch('[0-9a-f]{40}', base_ref)), 'Base must be an exact commit')
        tree = subprocess.check_output(['git', '-C', str(root), 'ls-tree', '-r', '-z', base_ref, '--', 'candidates'])
        old = {}
        for line in tree.split(b'\0'):
            if line:
                info, name = line.split(b'\t', 1)
                mode, kind, identity = info.split()
                require(mode == b'100644' and kind == b'blob', 'Unsafe previous candidate')
                old[name.decode()] = identity.decode()
        old_ids = {n.split('/')[1] for n in old}
        for name, identity in old.items():
            require(name in expected, 'Previous candidate removed')
            data = (root / name).read_bytes()
            require(hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest() == identity, 'Previous candidate mutated')
        require(all(n in old or n.split('/')[1] not in old_ids for n in expected if n.startswith('candidates/')), 'File added to old candidate')
    if out:
        destination = Path(out).resolve()
        require(not destination.exists(), 'Output already exists')
        for name in [*expected, 'SHA256SUMS.json']:
            target = destination / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(root / name, target)
    return {'result': 'PASS', 'candidateId': selected['candidateId'], 'candidates': len(candidates),
            'files': len(expected) + 1, 'candidateManifestSha256': selected['candidateManifestSha256'],
            'url': SITE + 'candidates/' + selected['candidateId'] + '/'}


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest='command', required=True)
    p = sub.add_parser('stage')
    p.add_argument('--root', default='.')
    p.add_argument('--zip', required=True)
    p.add_argument('--identity', required=True)
    p.add_argument('--candidate', required=True)
    p.add_argument('--summary', required=True)
    p = sub.add_parser('validate')
    p.add_argument('--root', default='.')
    p.add_argument('--base-ref')
    p.add_argument('--out')
    args = parser.parse_args()
    if args.command == 'stage':
        stage(args.root, args.zip, args.identity, args.candidate, args.summary)
        report = validate(args.root)
    else:
        report = validate(args.root, args.base_ref, args.out)
    print(json.dumps(report))


if __name__ == '__main__':
    main()
