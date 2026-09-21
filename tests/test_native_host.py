import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import native_host


class DomainsFileTests(unittest.TestCase):
    def test_comments_preserve_browser_arguments_for_aliases_and_inline_commands(self):
        cases = [
            ('firefox --profile "/home/user/Profile #2"', ["firefox", "--profile", "/home/user/Profile #2"]),
            ("firefox --profile '/home/user/Profile #2'", ["firefox", "--profile", "/home/user/Profile #2"]),
            (r'firefox --profile "Profile \" #2"', ["firefox", "--profile", 'Profile " #2']),
            (r"firefox --profile 'Profile\ #2'", ["firefox", "--profile", "Profile\\ #2"]),
            (r"firefox --profile Profile\ #2", ["firefox", "--profile", "Profile #2"]),
            (r"firefox --name \#2", ["firefox", "--name", "#2"]),
            ('firefox --name ""', ["firefox", "--name", ""]),
            ("firefox --name Profile#2", ["firefox", "--name", "Profile#2"]),
            ('"/opt/Browser #2/firefox" --name "Profile #2"', ["/opt/Browser #2/firefox", "--name", "Profile #2"]),
        ]
        for command, arguments in cases:
            with self.subTest(command=command), tempfile.TemporaryDirectory() as directory:
                config = Path(directory) / "domains.txt"
                config.write_text(
                    "# Full-line comment\n\n"
                    "[browsers] # aliases\n"
                    f"custom {command}  # trailing alias comment\n"
                    "[domains]\t# routing\n"
                    "Example.COM. custom  # use the alias\n"
                    f"inline.example {command}\t# trailing command comment\n"
                    "default.example  # use the default browser\n"
                )
                with patch.object(native_host, "DOMAINS_FILE", str(config)), \
                     patch.object(native_host, "read_message", return_value={"action": "get_domains"}), \
                     patch.object(native_host, "send_message") as send:
                    native_host.main()

                payload = send.call_args.args[0]
                self.assertNotIn("error", payload)
                self.assertEqual(payload["browsers"], {"custom": command})
                self.assertEqual(payload["domains"], [
                    {"domain": "example.com", "browser": command},
                    {"domain": "inline.example", "browser": command},
                    {"domain": "default.example", "browser": "firefox"},
                ])
                browser_commands = [payload["browsers"]["custom"]]
                browser_commands.extend(entry["browser"] for entry in payload["domains"][:2])
                for browser in browser_commands:
                    with patch.object(native_host.subprocess, "Popen") as launch:
                        native_host.open_in_browser("https://example.com/", browser)
                    self.assertEqual(launch.call_args.args[0], arguments + ["https://example.com/"])


class DomainsFileLocationTests(unittest.TestCase):
    def setUp(self):
        workspace = tempfile.TemporaryDirectory()
        self.addCleanup(workspace.cleanup)
        self.home = Path(workspace.name)
        self.config = self.home / "config" / "open-in-browser" / "domains.txt"
        self.config.parent.mkdir(parents=True)
        self.checkout = self.home / "checkout"
        self.checkout.mkdir()

        environment = {"HOME": str(self.home), "XDG_CONFIG_HOME": str(self.home / "config")}
        patcher = patch.dict(native_host.os.environ, environment, clear=False)
        patcher.start()
        self.addCleanup(patcher.stop)
        native_host.os.environ.pop("OPEN_IN_BROWSER_DOMAINS", None)

        # The installed host lives in ~/.local/bin, away from any checkout.
        file_patcher = patch.object(native_host, "__file__", str(self.checkout / "native_host.py"))
        file_patcher.start()
        self.addCleanup(file_patcher.stop)

    def test_environment_override_wins(self):
        self.config.write_text("")
        native_host.os.environ["OPEN_IN_BROWSER_DOMAINS"] = "/somewhere/else.txt"
        self.assertEqual(native_host.default_domains_file(), "/somewhere/else.txt")

    def test_installed_config_is_preferred_over_the_checkout(self):
        self.config.write_text("")
        (self.checkout / "domains.txt").write_text("")
        self.assertEqual(native_host.default_domains_file(), str(self.config))

    def test_uninstalled_checkout_still_finds_its_own_file(self):
        (self.checkout / "domains.txt").write_text("")
        self.assertEqual(native_host.default_domains_file(), str(self.checkout / "domains.txt"))

    def test_missing_everywhere_reports_the_installed_path(self):
        self.assertEqual(native_host.default_domains_file(), str(self.config))

    def test_config_home_defaults_to_dot_config(self):
        del native_host.os.environ["XDG_CONFIG_HOME"]
        expected = self.home / ".config" / "open-in-browser" / "domains.txt"
        expected.parent.mkdir(parents=True)
        expected.write_text("")
        self.assertEqual(native_host.default_domains_file(), str(expected))


if __name__ == "__main__":
    unittest.main()
