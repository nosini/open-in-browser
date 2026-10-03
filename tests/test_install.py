import json
import os
import shutil
import struct
import subprocess
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

REPOSITORY = Path(__file__).resolve().parent.parent
EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop"

# Refs the fake raw-file server knows about; everything else is a 404.
KNOWN_REFS = {("tags", "v1.3"), ("heads", "main")}


class RawFiles(BaseHTTPRequestHandler):
    """Serves this checkout under GitHub's /refs/<kind>/<ref>/<path> raw-file layout."""

    requests = []

    def log_message(self, *arguments):
        pass

    def do_GET(self):
        RawFiles.requests.append(self.path)
        parts = self.path.split("/", 4)  # "", "refs", kind, ref, path
        if len(parts) == 5 and parts[1] == "refs" and (parts[2], parts[3]) in KNOWN_REFS:
            file = REPOSITORY / parts[4]
            if file.is_file():
                data = file.read_bytes()
                self.send_response(200)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return
        self.send_response(404)
        self.end_headers()


@unittest.skipUnless(shutil.which("curl"), "bootstrap.sh downloads with curl")
class BootstrapTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), RawFiles)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.url = f"http://127.0.0.1:{cls.server.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        RawFiles.requests = []
        workspace = tempfile.TemporaryDirectory()
        self.addCleanup(workspace.cleanup)
        self.home = Path(workspace.name) / "home"
        profile = self.home / ".config" / "chromium"
        (profile / "Default").mkdir(parents=True)
        (profile / "Local State").write_text("{}")
        self.manifest = profile / "NativeMessagingHosts" / "open_in_browser.json"
        self.host = self.home / ".local" / "bin" / "open-in-browser-host"
        self.config = self.home / ".config" / "open-in-browser" / "domains.txt"
        # A private TMPDIR shows whether the download directory is cleaned up.
        self.tmp = Path(workspace.name) / "tmp"
        self.tmp.mkdir()

    def environment(self):
        return {
            "PATH": os.environ["PATH"],
            "HOME": str(self.home),
            "TMPDIR": str(self.tmp),
            "OPEN_IN_BROWSER_REPOSITORY": self.url,
        }

    def bootstrap(self, *arguments, piped=False):
        script = REPOSITORY / "bootstrap.sh"
        if piped:
            # Exactly how the setup page's command runs it: curl ... | bash -s --
            command = ["bash", "-s", "--", *arguments]
            stdin = script.read_text()
        else:
            command = ["bash", str(script), *arguments]
            stdin = None
        return subprocess.run(
            command, input=stdin, env=self.environment(),
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=60,
        )

    def assert_installed(self, result):
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(os.access(self.host, os.X_OK))
        self.assertEqual(self.host.read_bytes(), (REPOSITORY / "native_host.py").read_bytes())
        self.assertEqual(json.loads(self.manifest.read_text()), {
            "name": "open_in_browser",
            "description": "Opens configured domains in another browser",
            "path": str(self.host),
            "type": "stdio",
            "allowed_origins": [f"chrome-extension://{EXTENSION_ID}/"],
        })
        self.assertEqual(self.config.read_text(), (REPOSITORY / "domains.txt.example").read_text())
        # The extension is already installed, so no "drag the .crx" steps
        # pointing into a download directory that no longer exists.
        self.assertIn("Return to the extension's setup page", result.stdout)
        self.assertNotIn("Drag", result.stdout)
        self.assertEqual(list(self.tmp.iterdir()), [], "download directory left behind")

    def test_the_setup_page_command_installs_a_working_host(self):
        result = self.bootstrap("--ref", "v1.3", "--id", EXTENSION_ID, piped=True)
        self.assert_installed(result)
        self.assertEqual(sorted(RawFiles.requests), [
            "/refs/tags/v1.3/domains.txt.example",
            "/refs/tags/v1.3/install.sh",
            "/refs/tags/v1.3/native_host.py",
        ])

        # The installed host answers the way the extension will ask it.
        message = json.dumps({"action": "get_domains"}).encode()
        reply = subprocess.run(
            [str(self.host)], input=struct.pack("@I", len(message)) + message,
            env={"PATH": os.environ["PATH"], "HOME": str(self.home)},
            stdout=subprocess.PIPE, timeout=30,
        ).stdout
        self.assertEqual(json.loads(reply[4:]), {"domains": [], "browsers": {}})

    def test_run_from_a_file_and_branch_refs(self):
        self.assert_installed(self.bootstrap("--id", EXTENSION_ID, "--ref", "main"))
        self.assertTrue(all(path.startswith("/refs/heads/main/") for path in RawFiles.requests))

    def test_a_missing_release_installs_nothing(self):
        result = self.bootstrap("--ref", "v9.9", "--id", EXTENSION_ID)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("could not download", result.stderr)
        self.assertFalse(self.host.exists())
        self.assertFalse(self.manifest.exists())
        self.assertEqual(list(self.tmp.iterdir()), [])

    def test_a_bad_or_missing_id_fails_before_downloading(self):
        for arguments in (["--id", "NOTVALID"], ["--ref", "v1.3"], ["--id"]):
            with self.subTest(arguments=arguments):
                result = self.bootstrap(*arguments)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("Error:", result.stderr)
        self.assertEqual(RawFiles.requests, [])
        self.assertFalse(self.host.exists())

    def test_a_truncated_download_runs_nothing(self):
        # A dropped connection must never execute part of the script: without
        # the final `main "$@"` line, bash only defines functions.
        script = (REPOSITORY / "bootstrap.sh").read_text()
        truncated = script[:script.rindex('main "$@"')]
        result = subprocess.run(
            ["bash", "-s", "--", "--ref", "v1.3", "--id", EXTENSION_ID],
            input=truncated, env=self.environment(),
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=60,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(RawFiles.requests, [])
        self.assertFalse(self.host.exists())


if __name__ == "__main__":
    unittest.main()
