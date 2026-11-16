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
                self.assertEqual(payload["protocol"], native_host.PROTOCOL_VERSION)
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
                        launch.return_value.wait.return_value = 0
                        native_host.open_in_browser("https://example.com/", browser)
                    self.assertEqual(launch.call_args.args[0], arguments + ["https://example.com/"])
                    self.assertEqual(launch.call_args.kwargs["stdin"], native_host.subprocess.DEVNULL)
                    self.assertEqual(launch.call_args.kwargs["stdout"], native_host.subprocess.DEVNULL)
                    self.assertTrue(launch.call_args.kwargs["start_new_session"])


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


class MatchDomainTests(unittest.TestCase):
    def test_the_most_specific_matching_domain_wins(self):
        entries = [
            {"domain": "example.com", "browser": "firefox"},
            {"domain": "work.example.com", "browser": "librewolf"},
        ]
        self.assertEqual(
            native_host.match_domain("work.example.com", entries)["browser"], "librewolf")
        self.assertEqual(
            native_host.match_domain("deep.work.example.com", entries)["browser"], "librewolf")
        self.assertEqual(
            native_host.match_domain("other.example.com", entries)["browser"], "firefox")
        self.assertIsNone(native_host.match_domain("example.net", entries))


class ResolveBrowserTests(unittest.TestCase):
    def test_an_alias_keeps_extra_arguments(self):
        aliases = {"librewolf": "flatpak run io.gitlab.librewolf-community"}
        self.assertEqual(
            native_host.resolve_browser("librewolf --private-window", aliases),
            "flatpak run io.gitlab.librewolf-community --private-window",
        )

    def test_a_plain_command_is_used_as_written(self):
        aliases = {"librewolf": "flatpak run io.gitlab.librewolf-community"}
        self.assertEqual(
            native_host.resolve_browser("firefox --new-window", aliases),
            "firefox --new-window",
        )


class OpenMessageTests(unittest.TestCase):
    aliases = {
        "firefox": "firefox --new-window",
        "librewolf": "flatpak run io.gitlab.librewolf-community",
    }
    entries = [
        {"domain": "example.com", "browser": "firefox"},
        {"domain": "work.example.com", "browser": "librewolf --private-window"},
    ]

    def run_open(self, message):
        with patch.object(
            native_host, "parse_domains_file", return_value=(self.aliases, self.entries, None)
        ), patch.object(native_host, "open_in_browser") as launch, \
             patch.object(native_host, "send_message") as send:
            native_host.handle_open(message)
        return send.call_args.args[0], launch

    def test_an_empty_or_non_http_url_is_rejected(self):
        for message in (
            {"url": "", "browser": "firefox"},
            {"url": "   "},
            {"url": "javascript:alert(1)", "browser": "firefox"},
            {"url": "file:///etc/passwd", "browser": "firefox"},
        ):
            with self.subTest(message=message):
                payload, launch = self.run_open(message)
                self.assertEqual(payload["status"], "error")
                launch.assert_not_called()

    def test_an_unknown_alias_is_never_executed_as_a_command(self):
        payload, launch = self.run_open({
            "url": "https://example.com/",
            "browser": "sh -c 'touch /tmp/pwned'",
        })
        self.assertEqual(payload["status"], "error")
        self.assertIn("Unknown browser alias", payload["error"])
        launch.assert_not_called()

    def test_a_known_alias_is_resolved_by_the_host(self):
        payload, launch = self.run_open({
            "url": "https://example.com/",
            "browser": "firefox",
        })
        self.assertEqual(payload, {"status": "ok"})
        launch.assert_called_once_with("https://example.com/", self.aliases["firefox"])

    def test_the_caller_cannot_add_arguments_to_an_alias(self):
        payload, launch = self.run_open({
            "url": "https://example.com/",
            "browser": "librewolf --private-window",
        })
        self.assertEqual(payload["status"], "error")
        launch.assert_not_called()

    def test_a_url_is_resolved_by_the_most_specific_domain(self):
        payload, launch = self.run_open({"url": "https://deep.work.example.com/page"})
        self.assertEqual(payload, {"status": "ok"})
        launch.assert_called_once_with(
            "https://deep.work.example.com/page",
            "flatpak run io.gitlab.librewolf-community --private-window",
        )

    def test_a_launch_error_is_reported(self):
        with patch.object(
            native_host, "parse_domains_file", return_value=(self.aliases, self.entries, None)
        ), patch.object(
            native_host, "open_in_browser", side_effect=RuntimeError("browser command exited with status 1")
        ), patch.object(native_host, "send_message") as send:
            native_host.handle_open({"url": "https://example.com/"})
        self.assertEqual(send.call_args.args[0], {
            "protocol": native_host.PROTOCOL_VERSION,
            "status": "error",
            "error": "browser command exited with status 1",
        })


class LaunchTests(unittest.TestCase):
    def test_the_child_does_not_inherit_the_native_messaging_pipe(self):
        with patch.object(native_host.subprocess, "Popen") as launch:
            launch.return_value.wait.return_value = 0
            native_host.open_in_browser("https://example.com/", "firefox")
        kwargs = launch.call_args.kwargs
        self.assertEqual(kwargs["stdin"], native_host.subprocess.DEVNULL)
        self.assertEqual(kwargs["stdout"], native_host.subprocess.DEVNULL)
        self.assertEqual(kwargs["stderr"], native_host.subprocess.DEVNULL)
        self.assertTrue(kwargs["start_new_session"])
        launch.return_value.wait.assert_called_once_with(timeout=2)

    def test_a_command_that_exits_nonzero_is_an_error(self):
        with patch.object(native_host.subprocess, "Popen") as launch:
            launch.return_value.wait.return_value = 1
            with self.assertRaises(RuntimeError):
                native_host.open_in_browser("https://example.com/", "firefox")

    def test_a_command_still_running_after_the_wait_is_successful(self):
        with patch.object(native_host.subprocess, "Popen") as launch:
            launch.return_value.wait.side_effect = native_host.subprocess.TimeoutExpired("firefox", 2)
            self.assertIsNone(native_host.open_in_browser("https://example.com/", "firefox"))

    def test_an_empty_command_is_an_error(self):
        with self.assertRaises(ValueError):
            native_host.open_in_browser("https://example.com/", "")

    def test_an_empty_or_non_http_url_is_an_error_at_launch(self):
        for url in ("", "javascript:alert(1)", "file:///etc/passwd"):
            with self.subTest(url=url), patch.object(native_host.subprocess, "Popen") as launch:
                with self.assertRaises(ValueError):
                    native_host.open_in_browser(url, "firefox")
                launch.assert_not_called()


class HostErrorTests(unittest.TestCase):
    def test_a_config_read_error_is_reported_instead_of_crashing(self):
        with patch.object(native_host, "read_message", return_value={"action": "get_domains"}), \
             patch.object(native_host, "parse_domains_file", side_effect=OSError("permission denied")), \
             patch.object(native_host, "send_message") as send:
            native_host.main()
        self.assertEqual(send.call_args.args[0], {
            "protocol": native_host.PROTOCOL_VERSION,
            "status": "error",
            "error": "permission denied",
        })

    def test_a_parse_error_is_reported(self):
        with patch.object(native_host, "read_message", return_value={"action": "get_domains"}), \
             patch.object(
                 native_host, "parse_domains_file", return_value=({}, [], "domains.txt not found")
             ), \
             patch.object(native_host, "send_message") as send:
            native_host.main()
        self.assertEqual(send.call_args.args[0], {
            "protocol": native_host.PROTOCOL_VERSION,
            "status": "error",
            "error": "domains.txt not found",
        })


class ProtocolTests(unittest.TestCase):
    def test_get_domains_success_and_error_replies_include_the_protocol(self):
        for error in (None, "domains.txt not found"):
            with self.subTest(error=error), \
                 patch.object(native_host, "parse_domains_file", return_value=({}, [], error)), \
                 patch.object(native_host, "send_message") as send:
                native_host.handle_message({"action": "get_domains"})
            payload = send.call_args.args[0]
            self.assertEqual(payload["protocol"], native_host.PROTOCOL_VERSION)
            if error:
                self.assertEqual(payload["status"], "error")


if __name__ == "__main__":
    unittest.main()
