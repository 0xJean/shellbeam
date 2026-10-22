"""Tests use synthetic observations and disposable child processes; no host changes."""
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import time
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True

SOURCE = Path(__file__).resolve().parents[1] / "src-tauri/src/mcp/readonly_ops.py"
spec = importlib.util.spec_from_file_location("collector", SOURCE)
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)


class Observations(unittest.TestCase):
    def collect(self, query, output=""):
        with patch.object(collector, "run", return_value=output) as run:
            result = collector.collect(query, time.monotonic()+5)
            return result, run.call_args_list

    def test_service_and_process_pages_do_not_return_arguments_or_environment(self):
        result, calls = self.collect({"kind":"services", "limit":1}, "a.service loaded active running A\nb.service loaded failed failed B\n")
        self.assertEqual(result["entries"][0]["active"], "active")
        self.assertEqual(result["nextOffset"], 1)
        result, calls = self.collect({"kind":"processes", "offset":1}, "1 0.0 0.1 S init\n20 12.2 1.0 R worker\n")
        self.assertEqual(result["entries"][0]["pid"], 20)
        self.assertEqual(result["entries"][0]["cpuPercent"], 12.2)
        self.assertNotIn("args", calls[0].args[0])
        self.assertNotIn("command", result["entries"][0])

    def test_container_output_drops_unrequested_fields(self):
        result, _ = self.collect({"kind":"containers"}, json.dumps({"ID":"c", "Names":"demo", "Command":"synthetic-secret", "Labels":"synthetic-secret", "State":"running"}))
        self.assertEqual(result["entries"][0]["state"], "running")
        self.assertNotIn("synthetic-secret", json.dumps(result))

    def test_logs_accept_only_fixed_ranges_and_literal_unit_names(self):
        for query in [{"kind":"logs", "unit":"x; touch /tmp/x"}, {"kind":"logs", "unit":"--help"}, {"kind":"logs", "since":"$(id)"}, {"kind":"services", "unit":"a.service"}]:
            with self.assertRaises(collector.Unavailable): self.collect(query)
        result, calls = self.collect({"kind":"logs", "unit":"worker@1.service", "since":"5m"}, json.dumps({"MESSAGE":"entry", "__REALTIME_TIMESTAMP":"12", "SECRET":"hidden"}))
        self.assertEqual(calls[0].args[0][-2:], ["--unit", "worker@1.service"])
        self.assertEqual(result["entries"][0]["message"], "entry")
        self.assertNotIn("SECRET", json.dumps(result))

    def test_sites_scan_is_partial_and_never_returns_config_contents(self):
        with patch.object(collector.glob, "glob", side_effect=lambda pattern: ["/etc/nginx/conf.d/demo.conf"] if pattern.endswith("*.conf") else []), patch("builtins.open", return_value=io.StringIO("server_name demo.example;\nproxy_set_header Authorization hidden;")):
            result, _ = self.collect({"kind":"sites"})
        self.assertEqual(result["completeness"], "partial")
        self.assertEqual(result["entries"][0]["domains"], ["demo.example"])
        self.assertNotIn("hidden", json.dumps(result))

    def test_certificate_observation_retains_scope_and_unknown_dates(self):
        with patch.object(collector.glob, "glob", return_value=["/etc/letsencrypt/live/demo/fullchain.pem"]):
            result, calls = self.collect({"kind":"certificates"}, "subject=CN=demo\nnotAfter=invalid\n")
        self.assertEqual(result["completeness"], "partial")
        self.assertEqual(result["entries"][0]["status"], "unknown")
        self.assertIn("-noout", calls[0].args[0])

    def test_missing_tools_and_permissions_are_failures(self):
        for command in [["/nonexistent-shellbeam-read-only-test"], [sys.executable,"-c","import sys;sys.exit(2)"]]:
            with self.assertRaises(collector.Unavailable): collector.run(command,time.monotonic()+3)

    def test_output_and_time_are_bounded_with_children_reaped(self):
        with self.assertRaisesRegex(collector.Unavailable, "output-limit"):
            collector.run([sys.executable,"-c","print('x'*300000)"],time.monotonic()+3)
        with self.assertRaisesRegex(collector.Unavailable, "timeout"):
            collector.run([sys.executable,"-c","import time;time.sleep(5)"],time.monotonic()+0.1)

    def test_invalid_input_returns_failure_json_not_empty_success(self):
        for query in [{"kind":"restart"}, {"kind":"services","limit":201}, {"kind":"logs","unit":"$(id).service"}]:
            result=subprocess.run([sys.executable,str(SOURCE),json.dumps(query)],capture_output=True,text=True,timeout=3,check=True)
            data=json.loads(result.stdout)
            self.assertEqual(data["status"],"failed")
            self.assertNotIn("entries",data)
            self.assertEqual(result.stderr,"")


if __name__ == "__main__":
    unittest.main()
