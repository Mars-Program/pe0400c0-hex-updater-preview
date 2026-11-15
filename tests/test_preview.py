import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location('preview', Path(__file__).parents[1] / 'scripts/manage_preview.py')
preview = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preview)


class PreviewChecks(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / 'site'
        self.root.mkdir()
        self.archive = Path(self.tmp.name) / 'fixture.zip'
        self.identity = Path(self.tmp.name) / 'BUILD_IDENTITY.json'
        self.candidate = '0.1.6-20261116-001'
        self.payload = {
            'wwwroot/index.html': b'<title>fixture</title>',
            'wwwroot/app.js': b'// fixture runtime',
            'wwwroot/_framework/dotnet.js': b'// fixture loader',
            'DotNet-LICENSE.TXT': b'fixture notice',
            'DotNet-THIRD-PARTY-NOTICES.TXT': b'fixture third-party notice',
            'VALIDATION.md': b'private build path intentionally excluded',
        }
        self.package()

    def package(self, extra=None):
        entries = [{'path': n, 'bytes': len(b), 'sha256': preview.sha(b)}
                   for n, b in self.payload.items()]
        with zipfile.ZipFile(self.archive, 'w') as z:
            for n, b in self.payload.items():
                z.writestr('fixture/' + n, b)
            z.writestr('fixture/SHA256SUMS.json', json.dumps({'version': '0.1.6', 'files': entries}))
            if extra:
                z.writestr(*extra)
        identity = {
            'schema': 1, 'version': '0.1.6', 'sourceRepository': preview.SOURCE,
            'sourceCommit': 'a' * 40, 'sourceTree': 'b' * 40,
            'localZipName': self.archive.name, 'localZipSha256': preview.sha(self.archive.read_bytes()),
            'evidenceUrl': 'https://github.com/' + preview.SOURCE + '/actions/runs/123',
            'validation': dict.fromkeys(preview.GATES, 'NOT_RUN') | {'BUILD': 'PASS', 'OFFLINE': 'PASS'},
        }
        self.identity.write_text(json.dumps(identity))

    def stage(self):
        return preview.stage(self.root, self.archive, self.identity, self.candidate, 'Trial <review>')

    def test_exact_candidate_and_private_file_exclusion(self):
        self.stage()
        report = preview.validate(self.root, out=Path(self.tmp.name) / 'artifact')
        self.assertEqual(report['result'], 'PASS')
        folder = self.root / 'candidates' / self.candidate
        self.assertEqual((folder / 'app/app.js').read_bytes(), self.payload['wwwroot/app.js'])
        self.assertFalse((folder / 'VALIDATION.md').exists())
        self.assertIn(b'Trial &lt;review&gt;', (folder / 'index.html').read_bytes())
        self.assertIn(b'allow="serial', (folder / 'index.html').read_bytes())

    def test_zip_identity_mismatch(self):
        self.archive.write_bytes(self.archive.read_bytes() + b'changed')
        with self.assertRaisesRegex(ValueError, 'ZIP hash'):
            self.stage()

    def test_zip_traversal(self):
        self.package(('../outside', b'secret'))
        with self.assertRaisesRegex(ValueError, 'Unsafe path'):
            self.stage()

    def test_zip_symlink(self):
        info = zipfile.ZipInfo('fixture/link')
        info.create_system = 3
        info.external_attr = 0o120777 << 16
        self.package((info, b'elsewhere'))
        with self.assertRaisesRegex(ValueError, 'Unsafe ZIP entry'):
            self.stage()

    def test_unmanifested_zip_entry(self):
        self.package(('fixture/unlisted', b'unlisted'))
        with self.assertRaisesRegex(ValueError, 'Unmanifested ZIP'):
            self.stage()

    def test_developer_qa_not_publishable(self):
        self.payload['wwwroot/qa.js'] = b'QA'
        self.package()
        with self.assertRaisesRegex(ValueError, 'Unexpected public asset'):
            self.stage()

    def test_private_metadata_rejected(self):
        self.payload['wwwroot/app.js'] = b'C:\\TouchGFXProjects\\private'
        self.package()
        with self.assertRaisesRegex(ValueError, 'Private build metadata'):
            self.stage()

    def test_existing_candidate_not_overwritten(self):
        self.stage()
        with self.assertRaisesRegex(ValueError, 'immutable'):
            self.stage()

    def test_tampered_payload_rejected(self):
        self.stage()
        (self.root / 'candidates' / self.candidate / 'app/app.js').write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError, 'asset hash mismatch'):
            preview.validate(self.root)

    def test_unlisted_public_file_rejected(self):
        self.stage()
        (self.root / 'candidates' / self.candidate / 'app/qa.js').write_bytes(b'QA')
        with self.assertRaisesRegex(ValueError, 'Unlisted preview'):
            preview.validate(self.root)

    def test_rehashed_old_candidate_cannot_be_changed(self):
        self.stage()
        def git(*args):
            return subprocess.check_output(['git', '-C', str(self.root), *args],
                                           stderr=subprocess.DEVNULL, text=True).strip()
        git('init', '-b', 'main')
        git('config', 'core.autocrlf', 'false')
        git('config', 'user.name', 'Offline test')
        git('config', 'user.email', 'test@example.invalid')
        git('add', '.')
        git('commit', '-m', 'fixture')
        base = git('rev-parse', 'HEAD')
        folder = self.root / 'candidates' / self.candidate
        record = json.loads((folder / 'candidate.json').read_bytes())
        record['summary'] = 'Replaced trial'
        (folder / 'candidate.json').write_bytes(preview.json_bytes(record))
        (folder / 'index.html').write_bytes(preview.wrapper(record))
        preview.refresh_site(self.root, self.candidate)
        with self.assertRaisesRegex(ValueError, 'Previous candidate mutated'):
            preview.validate(self.root, base)


if __name__ == '__main__':
    unittest.main()
