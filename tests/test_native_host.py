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


if __name__ == "__main__":
    unittest.main()
