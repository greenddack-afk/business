"""초대 코드·사용량 제한 테스트 (API 호출 없음)."""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import app as appmod  # noqa: E402
import invite  # noqa: E402
import pipeline  # noqa: E402

IDEA = "따뜻한 폼롤러"


class InviteBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        d = Path(self.tmp.name)
        self.env = mock.patch.dict(os.environ, {
            "INVITE_CODES_FILE": str(d / "codes.txt"),
            "USAGE_FILE": str(d / "usage.json"),
            "LIFETIME_FILE": str(d / "lifetime.json"),
            "LIFETIME_LIMIT_PER_CODE": "5",
            "INVITE_CODES": "",
            "REQUIRE_INVITE": "",
            "DAILY_LIMIT_PER_CODE": "2",
            "DAILY_LIMIT_TOTAL": "3",
        })
        self.env.start()
        invite.reset_state()
        appmod.JOBS.clear()
        self.client = appmod.app.test_client()
        # 백그라운드 스레드가 실제 API를 부르지 않게 파이프라인을 막는다.
        self.thread = mock.patch.object(appmod.threading, "Thread")
        self.thread.start()

    def tearDown(self):
        self.thread.stop()
        self.env.stop()
        self.tmp.cleanup()

    def post(self, code=None, idea=IDEA, ip="1.1.1.1"):
        body = {"idea": idea}
        if code is not None:
            body["invite_code"] = code
        return self.client.post("/api/analyze", json=body, headers={"X-Forwarded-For": ip})


class CodeStorage(InviteBase):
    def test_generated_codes_have_expected_shape_and_are_unique(self):
        codes = invite.generate(20, "시범")
        self.assertEqual(len(set(codes)), 20)
        for c in codes:
            self.assertRegex(c, r"^[A-HJ-KM-NP-Z2-9]{4}-[A-HJ-KM-NP-Z2-9]{4}-[A-HJ-KM-NP-Z2-9]{4}$")  # 0 O 1 I L 없음
        self.assertEqual(len(invite.load_codes()), 20)

    def test_labels_are_numbered(self):
        invite.generate(2, "지인")
        labels = sorted(v["label"] for v in invite.load_codes().values())
        self.assertEqual(labels, ["지인1", "지인2"])

    def test_env_codes_are_loaded(self):
        with mock.patch.dict(os.environ, {"INVITE_CODES": "ABCD-EFGH-JKMN:지인A,WXYZ-2345-6789"}):
            self.assertEqual(len(invite.load_codes()), 2)

    def test_code_matching_ignores_case_hyphen_and_space(self):
        (code,) = invite.generate(1)
        variants = [code.lower(), code.replace("-", ""), f"  {code}  ", code.lower().replace("-", " ")]
        for v in variants:
            self.assertIsNotNone(invite.authorize(v), v)

    def test_revoke(self):
        (code,) = invite.generate(1)
        self.assertTrue(invite.revoke(code))
        self.assertIsNone(invite.authorize(code))
        self.assertFalse(invite.revoke(code))


class Gating(InviteBase):
    def test_open_when_no_codes_configured(self):
        self.assertFalse(invite.required())
        self.assertEqual(self.post().status_code, 200)

    def test_config_reports_requirement(self):
        self.assertFalse(self.client.get("/api/config").get_json()["invite_required"])
        invite.generate(1)
        self.assertTrue(self.client.get("/api/config").get_json()["invite_required"])

    def test_missing_code_is_rejected_when_required(self):
        invite.generate(1)
        r = self.post()
        self.assertEqual(r.status_code, 401)
        self.assertIn("입력", r.get_json()["error"])

    def test_wrong_code_is_rejected(self):
        invite.generate(1)
        r = self.post("AAAA-BBBB-CCCC")
        self.assertEqual(r.status_code, 401)
        self.assertIn("올바르지", r.get_json()["error"])

    def test_valid_code_starts_a_job(self):
        (code,) = invite.generate(1)
        r = self.post(code)
        self.assertEqual(r.status_code, 200)
        self.assertIn("job_id", r.get_json())

    def test_fail_closed_when_required_but_no_codes(self):
        with mock.patch.dict(os.environ, {"REQUIRE_INVITE": "1"}):
            self.assertTrue(invite.required())
            self.assertEqual(self.post("ANYTHING-1234").status_code, 401)

    def test_invalid_idea_does_not_consume_a_use(self):
        (code,) = invite.generate(1)
        self.assertEqual(self.post(code, idea="ㅁㄴㅇㄹ").status_code, 400)
        self.assertEqual(invite.remaining(invite.canon(code)), 2)


class Limits(InviteBase):
    def test_per_code_daily_limit(self):
        (code,) = invite.generate(1)
        self.assertEqual(self.post(code).status_code, 200)
        self.assertEqual(self.post(code).status_code, 200)
        r = self.post(code)
        self.assertEqual(r.status_code, 429)
        self.assertIn("2회", r.get_json()["error"])

    def test_total_daily_cap_protects_budget(self):
        a, b = invite.generate(2)
        self.assertEqual(self.post(a).status_code, 200)
        self.assertEqual(self.post(a).status_code, 200)
        self.assertEqual(self.post(b).status_code, 200)   # 전체 3회째
        r = self.post(b)
        self.assertEqual(r.status_code, 429)
        self.assertIn("전체", r.get_json()["error"])

    def test_refund_restores_use(self):
        (code,) = invite.generate(1)
        c = invite.canon(code)
        invite.consume(c)
        self.assertEqual(invite.remaining(c), 1)
        invite.refund(c)
        self.assertEqual(invite.remaining(c), 2)

    def test_refund_never_goes_below_zero(self):
        (code,) = invite.generate(1)
        invite.refund(invite.canon(code))
        self.assertEqual(invite.usage_report()["total"], 0)

    def test_service_failure_refunds_the_use(self):
        (code,) = invite.generate(1)
        c = invite.canon(code)
        invite.consume(c)
        appmod.JOBS["j1"] = appmod._new_job(IDEA)
        with mock.patch.object(appmod, "run_pipeline", side_effect=pipeline.PipelineAbort(pipeline.USER_FACING_ERROR)):
            appmod._run("j1", IDEA, [], c)
        self.assertEqual(appmod.JOBS["j1"]["state"], "error")
        self.assertEqual(invite.remaining(c), 2)  # 돌려받음

    def test_success_does_not_refund(self):
        (code,) = invite.generate(1)
        c = invite.canon(code)
        invite.consume(c)
        appmod.JOBS["j2"] = appmod._new_job(IDEA)
        fake = {"report": {"meta": {}}, "results": {}, "pool": None, "draft": {}, "schema_errors": []}
        with mock.patch.object(appmod, "run_pipeline", return_value=fake), \
             mock.patch.object(appmod, "save_report", return_value=Path("x.json")):
            appmod._run("j2", IDEA, [], c)
        self.assertEqual(appmod.JOBS["j2"]["state"], "done")
        self.assertEqual(invite.remaining(c), 1)

    def test_usage_resets_on_new_day(self):
        (code,) = invite.generate(1)
        c = invite.canon(code)
        invite.consume(c)
        path = Path(os.environ["USAGE_FILE"])
        data = json.loads(path.read_text(encoding="utf-8"))
        data["date"] = "2000-01-01"
        path.write_text(json.dumps(data), encoding="utf-8")
        self.assertEqual(invite.remaining(c), 2)


class LifetimeLimit(InviteBase):
    """코드당 평생 총 N번. 날짜가 바뀌어도, 하루 한도가 꺼져 있어도 누적된다."""

    def setUp(self):
        super().setUp()
        self.env2 = mock.patch.dict(os.environ, {"DAILY_LIMIT_PER_CODE": "0", "DAILY_LIMIT_TOTAL": "100"})
        self.env2.start()

    def tearDown(self):
        self.env2.stop()
        super().tearDown()

    def _next_day(self):
        path = Path(os.environ["USAGE_FILE"])
        data = json.loads(path.read_text(encoding="utf-8"))
        data["date"] = "2000-01-01"
        path.write_text(json.dumps(data), encoding="utf-8")

    def test_default_lifetime_limit_is_five(self):
        with mock.patch.dict(os.environ):
            os.environ.pop("LIFETIME_LIMIT_PER_CODE")
            self.assertEqual(invite.limits()[2], 5)

    def test_code_works_exactly_five_times_then_is_blocked(self):
        (code,) = invite.generate(1)
        for i in range(5):
            self.assertEqual(self.post(code).status_code, 200, f"{i + 1}번째")
        r = self.post(code)
        self.assertEqual(r.status_code, 429)
        self.assertIn("5회", r.get_json()["error"])
        self.assertIn("모두 썼어요", r.get_json()["error"])

    def test_limit_survives_a_new_day(self):
        (code,) = invite.generate(1)
        for _ in range(5):
            self.assertEqual(self.post(code).status_code, 200)
        self._next_day()   # 하루가 지나도 평생 횟수는 돌아오지 않는다
        self.assertEqual(self.post(code).status_code, 429)

    def test_uses_across_several_days_still_add_up(self):
        (code,) = invite.generate(1)
        for _ in range(3):
            self.assertEqual(self.post(code).status_code, 200)
        self._next_day()
        self.assertEqual(self.post(code).status_code, 200)   # 4번째
        self.assertEqual(self.post(code).status_code, 200)   # 5번째
        self.assertEqual(self.post(code).status_code, 429)

    def test_each_code_has_its_own_five(self):
        a, b = invite.generate(2)
        for _ in range(5):
            self.post(a)
        self.assertEqual(self.post(a).status_code, 429)
        self.assertEqual(self.post(b).status_code, 200)

    def test_refund_gives_back_a_lifetime_use(self):
        (code,) = invite.generate(1)
        c = invite.canon(code)
        for _ in range(5):
            invite.consume(c)
        self.assertEqual(invite.lifetime_left(c), 0)
        invite.refund(c)
        self.assertEqual(invite.lifetime_left(c), 1)
        self.assertEqual(self.post(code).status_code, 200)

    def test_failed_service_call_does_not_burn_lifetime_use(self):
        (code,) = invite.generate(1)
        c = invite.canon(code)
        invite.consume(c)
        appmod.JOBS["j9"] = appmod._new_job(IDEA)
        with mock.patch.object(appmod, "run_pipeline", side_effect=pipeline.PipelineAbort(pipeline.USER_FACING_ERROR)):
            appmod._run("j9", IDEA, [], c)
        self.assertEqual(invite.lifetime_left(c), 5)

    def test_invalid_idea_does_not_burn_lifetime_use(self):
        (code,) = invite.generate(1)
        self.post(code, idea="ㅁㄴㅇㄹ")
        self.assertEqual(invite.lifetime_left(invite.canon(code)), 5)

    def test_reset_lets_a_code_be_used_again(self):
        (code,) = invite.generate(1)
        for _ in range(5):
            self.post(code)
        self.assertEqual(self.post(code).status_code, 429)
        self.assertTrue(invite.reset_lifetime(code))
        self.assertEqual(self.post(code).status_code, 200)
        self.assertFalse(invite.reset_lifetime("NEVER-USED-CODE"))

    def test_lifetime_limit_can_be_turned_off_with_zero(self):
        (code,) = invite.generate(1)
        with mock.patch.dict(os.environ, {"LIFETIME_LIMIT_PER_CODE": "0"}):
            for _ in range(8):
                self.assertEqual(self.post(code).status_code, 200)
            self.assertIsNone(invite.lifetime_left(invite.canon(code)))

    def test_check_endpoint_shows_remaining_and_blocks_display_at_zero(self):
        (code,) = invite.generate(1)
        for _ in range(5):
            self.post(code)
        r = self.client.post("/api/invite/check", json={"code": code}, headers={"X-Forwarded-For": "4.4.4.4"})
        self.assertEqual(r.get_json()["remaining"], 0)
        self.assertEqual(r.get_json()["lifetime_left"], 0)

    def test_total_daily_cap_still_applies_on_top(self):
        a, b = invite.generate(2)
        with mock.patch.dict(os.environ, {"DAILY_LIMIT_TOTAL": "2"}):
            self.assertEqual(self.post(a).status_code, 200)
            self.assertEqual(self.post(b).status_code, 200)
            r = self.post(a)
            self.assertEqual(r.status_code, 429)
            self.assertIn("전체", r.get_json()["error"])
            self.assertEqual(invite.lifetime_left(invite.canon(a)), 4)  # 거부된 요청은 횟수를 쓰지 않음


class BruteForce(InviteBase):
    def test_lockout_after_repeated_wrong_codes(self):
        invite.generate(1)
        for _ in range(invite.LOCK_AFTER):
            self.assertEqual(self.post("WRONG-CODE-0000").status_code, 401)
        r = self.post("WRONG-CODE-0000")
        self.assertEqual(r.status_code, 429)
        self.assertIn("10분", r.get_json()["error"])

    def test_locked_ip_cannot_use_a_valid_code(self):
        (code,) = invite.generate(1)
        for _ in range(invite.LOCK_AFTER):
            self.post("WRONG-CODE-0000")
        self.assertEqual(self.post(code).status_code, 429)

    def test_lockout_is_per_ip(self):
        (code,) = invite.generate(1)
        for _ in range(invite.LOCK_AFTER):
            self.post("WRONG-CODE-0000", ip="9.9.9.9")
        self.assertEqual(self.post(code, ip="2.2.2.2").status_code, 200)

    def test_spoofed_left_xff_entry_does_not_dodge_lockout(self):
        invite.generate(1)
        for i in range(invite.LOCK_AFTER):
            self.client.post("/api/analyze", json={"idea": IDEA, "invite_code": "WRONG-CODE-0000"},
                             headers={"X-Forwarded-For": f"6.6.6.{i}, 5.5.5.5"})  # 왼쪽은 위조, 오른쪽이 실제
        r = self.client.post("/api/analyze", json={"idea": IDEA, "invite_code": "WRONG-CODE-0000"},
                             headers={"X-Forwarded-For": "7.7.7.7, 5.5.5.5"})
        self.assertEqual(r.status_code, 429)

    def test_check_endpoint(self):
        (code,) = invite.generate(1)
        ok = self.client.post("/api/invite/check", json={"code": code}, headers={"X-Forwarded-For": "3.3.3.3"})
        self.assertEqual(ok.get_json(), {"ok": True, "remaining": 2, "limit": 5, "lifetime_left": 5})
        bad = self.client.post("/api/invite/check", json={"code": "NOPE-NOPE-NOPE"}, headers={"X-Forwarded-For": "3.3.3.3"})
        self.assertEqual(bad.status_code, 401)


if __name__ == "__main__":
    unittest.main()
