#!/usr/bin/env python3
import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SCRIPT = Path(__file__).parents[1] / "scripts" / "dexmaint_remote.py"
spec = importlib.util.spec_from_file_location("dexmaint_remote", SCRIPT)
dm = importlib.util.module_from_spec(spec)
assert spec.loader is not None
import sys
sys.modules[spec.name] = dm
spec.loader.exec_module(dm)


class DexMaintPolicyTests(unittest.TestCase):
    def test_bigmac_requires_explicit_ack(self):
        with self.assertRaises(dm.DexMaintError):
            dm.require_bigmac_ack("bigmac", None)
        dm.require_bigmac_ack("bigmac", dm.BIGMAC_ACK)
        dm.require_bigmac_ack("macbook", None)

    def test_mode_authority_never_escalates(self):
        self.assertTrue(dm.disposition_allowed("clean", dm.AUTO_SAFE))
        self.assertFalse(dm.disposition_allowed("clean", dm.SAFE_COSTLY))
        self.assertFalse(dm.disposition_allowed("clean", dm.LEASED_EPHEMERAL))
        self.assertTrue(dm.disposition_allowed("deep-clean", dm.AUTO_SAFE))
        self.assertTrue(dm.disposition_allowed("deep-clean", dm.SAFE_COSTLY))
        self.assertFalse(dm.disposition_allowed("deep-clean", dm.LEASED_EPHEMERAL))
        self.assertTrue(dm.disposition_allowed("performance", dm.LEASED_EPHEMERAL))
        self.assertFalse(dm.disposition_allowed("performance", dm.AUTO_SAFE))

    def test_manifest_hash_ignores_stored_hash_field(self):
        m = {"run_id": "x", "target": "macbook", "eligible": []}
        h = dm.manifest_hash(m)
        m["manifest_sha256"] = h
        self.assertEqual(h, dm.manifest_hash(m))

    def test_automatic_policy_does_not_include_user_content(self):
        rels = {v["relative"] for v in dm.CATEGORY_SPECS.values()}
        forbidden = {
            "Desktop", "Documents", "Downloads", "Pictures", "Movies", "Music",
            "Library/Application Support", ".ssh", ".gnupg", "DEX-REACH",
        }
        self.assertTrue(rels.isdisjoint(forbidden))

    def test_cleaner_skips_symlinks_inside_allowed_cache(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "cache"
            outside = Path(td) / "outside"
            root.mkdir(); outside.mkdir()
            (outside / "keep.txt").write_text("keep", encoding="utf-8")
            (root / "trash.txt").write_text("trash", encoding="utf-8")
            os.symlink(outside, root / "link")
            result = dm.remove_tree_contents(root)
            self.assertFalse((root / "trash.txt").exists())
            self.assertTrue((outside / "keep.txt").exists())
            self.assertTrue((root / "link").is_symlink())
            self.assertEqual(len(result["skipped_symlinks"]), 1)

    def test_tree_digest_rejects_symlink_anywhere(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "durable"
            root.mkdir()
            (root / "file.txt").write_text("ok", encoding="utf-8")
            os.symlink(root / "file.txt", root / "alias.txt")
            with self.assertRaises(dm.DexMaintError):
                dm.tree_digest(root)

    def test_git_content_is_protected_from_durable_lane(self):
        with tempfile.TemporaryDirectory() as td:
            home = Path(td)
            repo = home / "Project"
            (repo / ".git").mkdir(parents=True)
            f = repo / "data.bin"
            f.write_bytes(b"x")
            with mock.patch.object(dm, "home_dir", return_value=home):
                protected, reason = dm.path_in_protected_area(f)
                self.assertTrue(protected)
                self.assertIn("Git repository", reason)

    def test_library_namespace_is_protected_from_durable_lane(self):
        with tempfile.TemporaryDirectory() as td:
            home = Path(td)
            f = home / "Library" / "Application Support" / "thing.db"
            f.parent.mkdir(parents=True)
            f.write_bytes(b"x")
            with mock.patch.object(dm, "home_dir", return_value=home):
                protected, reason = dm.path_in_protected_area(f)
                self.assertTrue(protected)
                self.assertIn("protected home namespace", reason)

    def test_drive_archive_destination_is_fixed_and_hash_suffixed(self):
        ticket = {
            "path": "/Users/andrew/Documents/report.pdf",
            "kind": "file",
            "sha256": "abcdef0123456789",
        }
        dest = dm.archive_destination(ticket)
        self.assertTrue(dest.startswith(dm.DRIVE_PREFIX + "/"))
        self.assertIn("report__abcdef01.pdf", dest)

    def test_rclone_remote_filter_only_returns_drive_backends(self):
        with tempfile.TemporaryDirectory() as td:
            cfg = Path(td) / "rclone.conf"
            cfg.write_text("[gdrive]\ntype = drive\ntoken = SECRET\n\n[s3]\ntype = s3\n", encoding="utf-8")
            with mock.patch.object(dm, "rclone_config_path", return_value=cfg):
                self.assertEqual(dm.google_drive_rclone_remotes(), ["gdrive:"])

    def test_plan_clean_stops_at_target_without_safe_costly(self):
        run = {
            "run_id": "maint-macbook-20260918T000000Z-aaaaaaaa",
            "target": "macbook",
            "before": {
                "candidates": [
                    {"id": "a", "category": "npm-cache", "path": "/x", "bytes": 100, "disposition": dm.AUTO_SAFE, "regeneration": "network", "active": False, "reason": "", "kind": "cache", "lease_id": None},
                    {"id": "b", "category": "playwright-browsers", "path": "/y", "bytes": 1000, "disposition": dm.SAFE_COSTLY, "regeneration": "network", "active": False, "reason": "", "kind": "cache", "lease_id": None},
                ],
                "lease_candidates": [],
            },
        }
        with mock.patch.object(dm, "self_sha256", return_value="k"):
            m = dm.plan_from_run(run, "clean", target_bytes=50)
        self.assertEqual([c["id"] for c in m["eligible"]], ["a"])
        self.assertTrue(all(c["id"] != "b" for c in m["eligible"]))


    def test_review_storage_finds_large_files_without_auto_authority(self):
        with tempfile.TemporaryDirectory() as td:
            home = Path(td)
            downloads = home / "Downloads"
            downloads.mkdir()
            big = downloads / "huge-video.mp4"
            big.write_bytes(b"x" * 1024)
            with mock.patch.object(dm, "home_dir", return_value=home):
                result = dm.review_user_storage(large_file_min_bytes=512, max_candidates=10, file_limit=100, seconds_limit=2)
            self.assertEqual(len(result["candidates"]), 1)
            item = result["candidates"][0]
            self.assertEqual(item["display_path"], "~/Downloads/huge-video.mp4")
            self.assertEqual(item["disposition"], dm.DURABLE_USER_DECISION)
            self.assertTrue(item["archive_eligible"])

    def test_review_storage_finds_old_installer_below_large_file_threshold(self):
        with tempfile.TemporaryDirectory() as td:
            home = Path(td)
            downloads = home / "Downloads"
            downloads.mkdir()
            dmg = downloads / "old-installer.dmg"
            dmg.write_bytes(b"x" * 1024)
            old = 20 * 86400
            os.utime(dmg, (os.path.getatime(dmg) - old, os.path.getmtime(dmg) - old))
            with mock.patch.object(dm, "home_dir", return_value=home),                  mock.patch.object(dm, "DEFAULT_INSTALLER_MIN_BYTES", 512):
                result = dm.review_user_storage(large_file_min_bytes=4096, max_candidates=10, file_limit=100, seconds_limit=2)
            self.assertEqual(result["candidates"][0]["kind"], "old-installer-archive")

    def test_optional_menu_numbers_are_stable_and_hashed(self):
        run = {
            "run_id": "maint-macbook-20260918T000000Z-aaaaaaaa",
            "target": "macbook",
            "before": {
                "candidates": [{"id":"cat-004","category":"playwright-browsers","path":"/Users/andrew/Library/Caches/ms-playwright","bytes":2 * 1024 * 1024,"disposition":dm.SAFE_COSTLY,"active":False}],
                "review_candidates": [{"id":"review-001","kind":"large-user-file","path":"/Users/andrew/Downloads/movie.mov","display_path":"~/Downloads/movie.mov","bytes":2000,"mtime_ns":1,"age_days":9.0,"reason":"large durable file"}],
                "review_scan": {"partial": False},
                "library_hotspots": [],
            },
        }
        with mock.patch.object(dm, "self_sha256", return_value="kernel"):
            menu = dm.build_optional_menu(run)
        self.assertEqual([i["number"] for i in menu["items"]], [1, 2])
        self.assertEqual(menu["items"][0]["bare_number_action"], "clear")
        self.assertEqual(menu["items"][1]["bare_number_action"], "choose-remove-or-drive")
        self.assertEqual(menu["menu_sha256"], dm.optional_menu_hash(menu))

    def test_optional_menu_omits_negligible_maintenance_entries(self):
        run = {
            "run_id": "maint-macbook-20260918T000000Z-aaaaaaaa",
            "target": "macbook",
            "before": {
                "candidates": [
                    {"id":"cat-small","category":"tiny-derived-data","path":"/H/tiny","bytes":1024,"disposition":dm.SAFE_COSTLY,"active":False},
                    {"id":"cat-useful","category":"useful-cache","path":"/H/useful","bytes":2 * 1024 * 1024,"disposition":dm.SAFE_COSTLY,"active":False},
                ],
                "review_candidates": [],
                "review_scan": {"partial": False},
                "library_hotspots": [],
            },
        }
        with mock.patch.object(dm, "self_sha256", return_value="kernel"):
            menu = dm.build_optional_menu(run)
        self.assertEqual([i["category"] for i in menu["items"]], ["useful-cache"])

    def test_menu_hash_tamper_is_blocked(self):
        run = {"optional_menu": {"run_id":"x","target":"macbook","kernel_sha256":"k","policy_version":dm.POLICY_VERSION,"items":[]}}
        run["optional_menu"]["menu_sha256"] = dm.optional_menu_hash(run["optional_menu"])
        with mock.patch.object(dm, "self_sha256", return_value="k"):
            dm.require_menu(run, run["optional_menu"]["menu_sha256"])
            run["optional_menu"]["items"].append({"number":1})
            with self.assertRaises(dm.DexMaintError):
                dm.require_menu(run, "bad")

    def test_bare_number_selected_manifest_rejects_durable_files(self):
        menu = {
            "run_id":"maint-macbook-20260918T000000Z-aaaaaaaa", "target":"macbook", "created_at":"x",
            "kernel_sha256":"k", "policy_version":dm.POLICY_VERSION,
            "items":[{"number":1,"type":"durable-file","candidate_id":"review-001","category":"large-user-file","display":"~/Downloads/a.mov","path":"/Users/andrew/Downloads/a.mov","bytes":1000,"mtime_ns":1,"disposition":dm.DURABLE_USER_DECISION}],
            "review_scan":None,"library_hotspots":[],"selection_contract":{}
        }
        menu["menu_sha256"] = dm.optional_menu_hash(menu)
        run = {"run_id":menu["run_id"],"target":"macbook","before":{},"optional_menu":menu}
        with mock.patch.object(dm, "self_sha256", return_value="k"):
            with self.assertRaises(dm.DexMaintError):
                dm.selected_manifest(run, menu["menu_sha256"], "1")

    def test_selected_manifest_only_contains_exact_numbered_maintenance_items(self):
        menu = {
            "run_id":"maint-macbook-20260918T000000Z-aaaaaaaa", "target":"macbook", "created_at":"x",
            "kernel_sha256":"k", "policy_version":dm.POLICY_VERSION,
            "items":[
                {"number":1,"type":"maintenance-category","candidate_id":"cat-004","category":"playwright-browsers","display":"playwright-browsers","path":"/H/Library/Caches/ms-playwright","bytes":1000,"disposition":dm.SAFE_COSTLY},
                {"number":2,"type":"maintenance-category","candidate_id":"cat-005","category":"xcode-derived-data","display":"xcode-derived-data","path":"/H/Library/Developer/Xcode/DerivedData","bytes":2000,"disposition":dm.SAFE_COSTLY},
            ],
            "review_scan":None,"library_hotspots":[],"selection_contract":{}
        }
        menu["menu_sha256"] = dm.optional_menu_hash(menu)
        run = {"run_id":menu["run_id"],"target":"macbook","before":{},"optional_menu":menu}
        candidates = [
            dm.Candidate("cat-004","playwright-browsers","/H/Library/Caches/ms-playwright",1000,dm.SAFE_COSTLY,"network",False,"ok"),
            dm.Candidate("cat-005","xcode-derived-data","/H/Library/Developer/Xcode/DerivedData",2000,dm.SAFE_COSTLY,"rebuild",False,"ok"),
        ]
        with mock.patch.object(dm, "self_sha256", return_value="k"), mock.patch.object(dm, "category_candidates", return_value=candidates), mock.patch.object(dm, "process_rows", return_value=[]):
            m = dm.selected_manifest(run, menu["menu_sha256"], "2")
        self.assertEqual(m["selected_numbers"], [2])
        self.assertEqual([x["category"] for x in m["eligible"]], ["xcode-derived-data"])
        self.assertEqual(m["mode"], "selected")
    def test_drive_archive_is_never_default_for_cache_policy(self):
        for spec in dm.CATEGORY_SPECS.values():
            self.assertIn(spec["disposition"], {dm.AUTO_SAFE, dm.SAFE_COSTLY})
        self.assertFalse(any("drive" in json.dumps(spec).lower() for spec in dm.CATEGORY_SPECS.values()))

    def test_available_for_work_goal_uses_fresh_metric_and_can_stop_immediately(self):
        run = {
            "run_id": "maint-macbook-20260921T000000Z-aaaaaaaa",
            "target": "macbook",
            "before": {
                "storage": {
                    "immediately_free_bytes": 10,
                    "available_for_work_bytes": 1000,
                },
                "candidates": [
                    {"id": "a", "category": "npm-cache", "path": "/x", "bytes": 100,
                     "disposition": dm.AUTO_SAFE, "regeneration": "network", "active": False,
                     "reason": "", "kind": "cache", "lease_id": None},
                ],
                "lease_candidates": [],
            },
        }
        with mock.patch.object(dm, "self_sha256", return_value="k"):
            m = dm.plan_from_run(run, "clean", goal_available_bytes=900, goal_metric="available-for-work")
        self.assertTrue(m["goal_already_satisfied"])
        self.assertEqual(m["eligible"], [])

    def test_available_for_work_goal_blocks_without_fresh_metric(self):
        run = {
            "run_id": "maint-macbook-20260921T000000Z-aaaaaaaa",
            "target": "macbook",
            "before": {"storage": {"immediately_free_bytes": 10, "available_for_work_bytes": None}, "candidates": [], "lease_candidates": []},
        }
        with self.assertRaises(dm.DexMaintError):
            dm.plan_from_run(run, "clean", goal_available_bytes=900, goal_metric="available-for-work")

    def test_codex_config_reference_protects_staging_candidate(self):
        with tempfile.TemporaryDirectory() as td:
            home = Path(td)
            target = home / ".codex/.tmp/marketplaces/.staging"
            target.mkdir(parents=True)
            (target / "x").write_bytes(b"x")
            config = home / ".codex/config.toml"
            config.parent.mkdir(parents=True, exist_ok=True)
            config.write_text(f'source = "{target}"\n', encoding="utf-8")
            with mock.patch.object(dm, "home_dir", return_value=home),                  mock.patch.object(dm, "exact_open_handle_state", return_value=False):
                candidates = {c.category: c for c in dm.category_candidates([])}
            self.assertEqual(candidates["codex-marketplace-staging"].disposition, dm.PROTECTED)

    def test_matching_marketplace_backup_cleanup_preserves_neighbors(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "marketplaces"
            backup = root / "marketplace-backup-abc"
            current = root / "awesome-codex-plugins"
            backup.mkdir(parents=True)
            current.mkdir(parents=True)
            (backup / "old").write_bytes(b"old")
            (current / "keep").write_bytes(b"keep")
            result = dm.remove_matching_children(root, "marketplace-backup-")
            self.assertEqual(result["removed_entries"], 1)
            self.assertFalse(backup.exists())
            self.assertTrue((current / "keep").exists())

    def test_remote_existing_matching_md5_skips_upload(self):
        with tempfile.TemporaryDirectory() as td:
            home = Path(td)
            f = home / "Documents/report.bin"
            f.parent.mkdir(parents=True)
            f.write_bytes(b"hello")
            ident = dm.Identity("macbook", "MacBook-Air.local", "andrew", "darwin", "arm64", str(home))
            with mock.patch.object(dm, "home_dir", return_value=home):
                ticket = dm.prepare_durable(str(f), ident)
                expected = dm.md5_file(f)
                with mock.patch.object(dm, "google_drive_rclone_remotes", return_value=["gdrive:"]),                      mock.patch.object(dm, "remote_md5_probe", return_value={"state":"matching","hashes":[expected],"count":1,"stderr":""}),                      mock.patch.object(dm, "run_readonly") as rr:
                    receipt = dm.archive_to_rclone(ticket, "gdrive:")
            self.assertTrue(receipt["verified"])
            rr.assert_not_called()

    def test_archive_timeout_then_remote_match_is_verified(self):
        with tempfile.TemporaryDirectory() as td:
            home = Path(td)
            f = home / "Documents/report.bin"
            f.parent.mkdir(parents=True)
            f.write_bytes(b"hello")
            ident = dm.Identity("macbook", "MacBook-Air.local", "andrew", "darwin", "arm64", str(home))
            with mock.patch.object(dm, "home_dir", return_value=home):
                ticket = dm.prepare_durable(str(f), ident)
                expected = dm.md5_file(f)
                probes = [
                    {"state":"absent","hashes":[],"count":0,"stderr":"not found"},
                    {"state":"matching","hashes":[expected],"count":1,"stderr":""},
                ]
                with mock.patch.object(dm, "google_drive_rclone_remotes", return_value=["gdrive:"]),                      mock.patch.object(dm, "remote_md5_probe", side_effect=probes),                      mock.patch.object(dm, "run_readonly", return_value=(127,"","TimeoutExpired")):
                    receipt = dm.archive_to_rclone(ticket, "gdrive:", copy_timeout=30)
            self.assertEqual(receipt["verification"], "post-timeout remote MD5 match")

    def test_archive_mismatched_existing_destination_blocks(self):
        with tempfile.TemporaryDirectory() as td:
            home = Path(td)
            f = home / "Documents/report.bin"
            f.parent.mkdir(parents=True)
            f.write_bytes(b"hello")
            ident = dm.Identity("macbook", "MacBook-Air.local", "andrew", "darwin", "arm64", str(home))
            with mock.patch.object(dm, "home_dir", return_value=home):
                ticket = dm.prepare_durable(str(f), ident)
                with mock.patch.object(dm, "google_drive_rclone_remotes", return_value=["gdrive:"]),                      mock.patch.object(dm, "remote_md5_probe", return_value={"state":"mismatch","hashes":["0"*32],"count":1,"stderr":""}):
                    with self.assertRaises(dm.DexMaintError):
                        dm.archive_to_rclone(ticket, "gdrive:")

    def test_duplicate_matching_remote_objects_are_verified_without_reupload(self):
        with tempfile.TemporaryDirectory() as td:
            home = Path(td)
            f = home / "Documents/report.bin"
            f.parent.mkdir(parents=True)
            f.write_bytes(b"hello")
            ident = dm.Identity("macbook", "MacBook-Air.local", "andrew", "darwin", "arm64", str(home))
            with mock.patch.object(dm, "home_dir", return_value=home):
                ticket = dm.prepare_durable(str(f), ident)
                expected = dm.md5_file(f)
                with mock.patch.object(dm, "google_drive_rclone_remotes", return_value=["gdrive:"]),                      mock.patch.object(dm, "remote_md5_probe", return_value={"state":"matching","hashes":[expected, expected],"count":2,"stderr":""}),                      mock.patch.object(dm, "run_readonly") as rr:
                    receipt = dm.archive_to_rclone(ticket, "gdrive:")
            self.assertEqual(receipt["remote_match_count"], 2)
            self.assertIsNotNone(receipt["warning"])
            rr.assert_not_called()

    def test_hotspot_script_never_follows_symlink(self):
        import importlib.util as _iu
        hs_path = Path(__file__).parents[1] / "scripts" / "storage_hotspot_scan.py"
        hs_spec = _iu.spec_from_file_location("storage_hotspot_scan", hs_path)
        hs = _iu.module_from_spec(hs_spec)
        hs_spec.loader.exec_module(hs)
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "root"; root.mkdir()
            outside = Path(td) / "outside"; outside.mkdir()
            (outside / "large.bin").write_bytes(b"x" * 100)
            os.symlink(outside, root / "link")
            (root / "small.bin").write_bytes(b"x" * 3)
            result = hs.scan(root, max_depth=2, top=10, seconds=2, entry_limit=100)
            self.assertEqual(result["hotspots"], [{"name": "small.bin", "bytes": 3}])


class StorageGuardianTests(unittest.TestCase):
    def test_status_contract_is_read_only_and_summarizes_latest_run(self):
        with tempfile.TemporaryDirectory() as td:
            state = Path(td)
            (state / "runs").mkdir()
            run_id = "maint-macbook-20260930T120000Z-aaaaaaaa"
            run = {
                "run_id": run_id,
                "target": "macbook",
                "created_at": "2026-09-30T12:00:00Z",
                "status": "WATCHED",
                "before": {
                    "storage": {"pressure": "LOW"},
                    "deleted_but_open": {"pinned_bytes": 123, "reboot_recommended": False},
                    "candidates": [
                        {"disposition": dm.PROTECTED},
                        {"disposition": dm.REPORT_ONLY},
                        {"disposition": dm.AUTO_SAFE},
                    ],
                },
            }
            (state / "runs" / f"{run_id}.json").write_text(json.dumps(run), encoding="utf-8")
            dm.governor.append_jsonl(state / dm.governor.RECEIPT_FILE, {
                "run_id": run_id,
                "accounted_size_before_bytes": 1000,
                "measured_reclaim_delta_bytes": 700,
            })
            identity = dm.Identity("macbook", "MacBook-Air.local", "andrew", "darwin", "arm64", str(state))
            with mock.patch.object(dm, "state_dir", return_value=state), \
                 mock.patch.object(dm, "storage_snapshot", return_value={
                     "immediately_free_bytes": 12 * 1024**3,
                     "available_for_work_bytes": 13 * 1024**3,
                     "pressure": "LOW",
                 }), \
                 mock.patch.object(dm, "pid_command") as pid_command:
                payload = dm.status_payload(identity)
            pid_command.assert_not_called()
            self.assertEqual(payload["schema_version"], 1)
            self.assertEqual(payload["pressure"], "LOW")
            self.assertFalse(payload["watcher_running"])
            self.assertEqual(payload["last_run"]["run_id"], run_id)
            self.assertEqual(payload["last_run"]["action_count"], 1)
            self.assertEqual(payload["last_run"]["accounted_candidate_bytes"], 1000)
            self.assertEqual(payload["last_run"]["measured_reclaim_bytes"], 700)
            self.assertEqual(payload["last_run"]["protected_or_blocked_count"], 2)

    def test_status_contract_reports_live_watcher_lock_without_mutating_it(self):
        with tempfile.TemporaryDirectory() as td:
            state = Path(td)
            (state / "runs").mkdir()
            lock = state / dm.governor.LOCK_FILE
            lock.write_text("4321", encoding="utf-8")
            identity = dm.Identity("macbook", "MacBook-Air.local", "andrew", "darwin", "arm64", str(state))
            with mock.patch.object(dm, "state_dir", return_value=state), \
                 mock.patch.object(dm, "storage_snapshot", return_value={
                     "immediately_free_bytes": 31 * 1024**3,
                     "available_for_work_bytes": None,
                     "pressure": "HEALTHY",
                 }), \
                 mock.patch.object(dm, "pid_command", return_value="python dexmaint_remote.py watch --target macbook"):
                payload = dm.status_payload(identity)
            self.assertTrue(payload["watcher_running"])
            self.assertEqual(payload["watcher_pid"], 4321)
            self.assertTrue(lock.exists())

    def test_pressure_transitions_use_immediate_apfs_free_bytes(self):
        self.assertEqual(dm.governor.pressure_state(30 * 1024**3), "HEALTHY")
        self.assertEqual(dm.governor.pressure_state(20 * 1024**3), "WATCH")
        self.assertEqual(dm.governor.pressure_state(10 * 1024**3), "LOW")
        self.assertEqual(dm.governor.pressure_state(5 * 1024**3), "CRITICAL")
        self.assertEqual(dm.governor.pressure_state(5 * 1024**3 - 1), "EMERGENCY")

    def test_reclaim_receipt_never_equates_logical_size_to_apfs_delta(self):
        with tempfile.TemporaryDirectory() as td:
            started = __import__('time').monotonic()
            receipt = dm.governor.receipt(Path(td), "run", {"id":"x", "category":"clone", "path":"/x", "bytes":999}, 100, 103, "remove", "passed", started)
            self.assertEqual(receipt["accounted_size_before_bytes"], 999)
            self.assertEqual(receipt["measured_reclaim_delta_bytes"], 3)

    def test_growth_uses_persisted_24h_and_7d_samples(self):
        now = dm.dt.datetime(2026, 1, 10, tzinfo=dm.dt.timezone.utc)
        rows = [{"category":"cache", "bytes":10, "observed_at":"2026-01-01T00:00:00Z"}, {"category":"cache", "bytes":70, "observed_at":"2026-01-08T00:00:00Z"}]
        value = dm.governor.growth({"cache":100}, rows, now)["cache"]
        self.assertEqual(value["growth_24h_bytes"], 30)
        self.assertEqual(value["growth_7d_bytes"], 90)

    def test_active_or_unknown_open_handle_blocks_hotspot(self):
        with tempfile.TemporaryDirectory() as td:
            home = Path(td); root = home / ".cache/codex-runtimes" / "codex-runtime-install-old"; root.mkdir(parents=True)
            with mock.patch.object(dm.governor, "age_seconds", return_value=90000):
                items = dm.governor.known_hotspots(home, lambda _: None, lambda _: False)
            item = next(x for x in items if x["category"] == "codex-runtime-staging")
            self.assertEqual(item["disposition"], dm.PROTECTED)

    def test_open_handle_inventory_is_bounded_to_one_lsof_call(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            open_path = root / "cache" / "held"
            open_path.parent.mkdir()
            open_path.write_text("x", encoding="utf-8")
            dm.reset_open_handle_inventory()
            with mock.patch.object(dm.shutil, "which", return_value="/usr/sbin/lsof"), \
                 mock.patch.object(dm, "run_readonly", return_value=(0, f"p1\nn{open_path}\n", "")) as run:
                self.assertTrue(dm.exact_open_handle_state(open_path.parent))
                self.assertTrue(dm.exact_open_handle_state(open_path))
            run.assert_called_once()

    def test_primary_codex_runtime_is_never_a_candidate(self):
        with tempfile.TemporaryDirectory() as td:
            home = Path(td); root = home / ".cache/codex-runtimes" / "codex-primary-runtime"; root.mkdir(parents=True)
            with mock.patch.object(dm.governor, "age_seconds", return_value=90000):
                items = dm.governor.known_hotspots(home, lambda _: False, lambda _: False)
            self.assertFalse(any(x["path"] == str(root) for x in items))

    def test_deleted_open_deduplicates_inode(self):
        data = "p12\ncproc\nf1\ns100\ni77\nn/tmp/a (deleted)\nf2\ns100\ni77\nn/tmp/a (deleted)\n"
        report = dm.governor.deleted_open(lambda _cmd, _timeout: (0, data, ""))
        self.assertEqual(report["pinned_bytes"], 100)

    def test_release_retention_keeps_active_plus_two_rollbacks(self):
        with tempfile.TemporaryDirectory() as td:
            home = Path(td)
            releases = home / ".dex-reach/runtime/releases"
            for index in range(4):
                release = releases / f"r{index}"
                (release / "dist").mkdir(parents=True)
                (release / "node_modules").mkdir()
                os.utime(release, (index + 1, index + 1))
            items = dm.governor.known_hotspots(home, lambda _: False,
                                               lambda markers: any(Path(m).name == "r0" for m in markers))
            release_items = [x for x in items if x["category"] == "dex-reach-release-retention"]
            protected = {Path(x["path"]).name for x in release_items if x["disposition"] == dm.PROTECTED}
            self.assertEqual(protected, {"r0", "r2", "r3"})

    def test_watcher_plist_has_no_policy_and_runs_kernel_entry(self):
        plist = dm.governor.watcher_plist("/x/dexmaint_remote.py")
        self.assertIn("watch", plist)
        self.assertNotIn("homebrew-cask", plist)
        self.assertIn("StartInterval", plist)

    def test_stale_watcher_lock_is_reconciled_without_overlapping_live_owner(self):
        with tempfile.TemporaryDirectory() as td:
            state = Path(td)
            (state / dm.governor.LOCK_FILE).write_text("999999", encoding="utf-8")
            identity = dm.Identity("macbook", "MacBook-Air.local", "andrew", "darwin", "arm64", str(state))
            snapshot = {"storage":{"immediately_free_bytes":31 * 1024**3, "pressure":"HEALTHY"}, "candidates":[], "deleted_but_open":{}}
            args = type("Args", (), {"target":"macbook", "bigmac_ack":None, "apply_auto":False})()
            with mock.patch.object(dm, "state_dir", return_value=state), \
                 mock.patch.object(dm, "detect_identity", return_value=identity), \
                 mock.patch.object(dm, "pid_command", return_value=None), \
                 mock.patch.object(dm, "collect_snapshot", return_value=snapshot), \
                 mock.patch.object(dm.governor, "record_observations", return_value={}), \
                 mock.patch.object(dm, "save_run"), mock.patch.object(dm, "print_json"):
                dm.cmd_watch(args)
            self.assertFalse((state / dm.governor.LOCK_FILE).exists())

    def test_watcher_snapshot_does_not_scan_user_aggregate_roots(self):
        source = Path(dm.__file__).read_text(encoding="utf-8")
        self.assertIn('collect_snapshot(identity, include_recon=False, include_user_aggregates=False)', source)


if __name__ == "__main__":
    unittest.main(verbosity=2)

class DexMaintPackagingRegressionTests(unittest.TestCase):
    def test_ui_icon_uses_skill_specific_asset_name(self):
        root = Path(__file__).parents[1]
        metadata = (root / "agents" / "openai.yaml").read_text(encoding="utf-8")
        self.assertIn("assets/dexmaint-icon.svg", metadata)
        self.assertTrue((root / "assets" / "dexmaint-icon.svg").is_file())
        self.assertFalse((root / "assets" / "icon.svg").exists())
