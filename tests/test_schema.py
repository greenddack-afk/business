"""schema.py 유닛 테스트. 실행: python -m unittest discover -s tests -v  (API 키·네트워크 불필요)"""
import copy
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import schema  # noqa: E402


def N(value, unit, url="https://example.com/a", conf="sourced"):
    return {"value": value, "unit": unit, "source_url": url, "confidence": conf}


def score(s=6, ref="market:5-6"):
    return {"score": s, "rubric_ref": ref, "rationale": "근거 문장"}


ASSUMPTION = {"key": "초기자본", "value": "3,000만원", "reason": "업종 표준"}

NORMALIZER = {
    "product": "발열 폼롤러",
    "target": "홈트 인구",
    "differentiator": "온열+압박",
    "industry_code": "manufacturing",
    "industry_confidence": 0.7,
    "interpretation": "oem_import",
    "alternative_interpretation": "자체 제조로 볼 경우 초기투자 약 3배",
    "assumptions": [ASSUMPTION] * 3,
    "queries": [f"쿼리 {i}" for i in range(7)],
}

MARKET = {
    "scores": {"market": score(7, "market:7-8"), "competition": score(3, "competition:3-4")},
    "summary": "시장은 있으나 경쟁이 강하다.",
    "size": N(3200, "억원"),
    "growth": N(9, "%"),
    "competition_level": "상",
    "competitors": [{"name": "A사", "positioning": "저가", "url": "https://a.com", "note": ""}],
    "trends": ["트렌드1", "트렌드2", "트렌드3"],
}

_SC = {"monthly_units": N(200, "개", "", "estimated"), "cumulative_profit_12m": N(400, "만원", "", "estimated"), "note": "n"}
FINANCE = {
    "scores": {"profitability": score(6, "profitability:5-6")},
    "summary": "손익분기는 월 88개이다.",
    "initial_investment": [{"item": "금형", "amount": N(1200, "만원", "", "estimated")}],
    "total_initial_investment": N(3000, "만원", "", "estimated"),
    "fixed_cost_monthly": N(300, "만원", "", "estimated"),
    "unit_economics": {
        "price": N(69000, "원"),
        "unit_cost": N(23000, "원", "", "estimated"),
        "variable_cost": N(12000, "원", "", "estimated"),
        "contribution_margin": N(34000, "원", "", "estimated"),
    },
    "break_even": {"units_per_month": N(88, "개", "", "estimated"), "payback_months": N(9, "개월", "", "estimated")},
    "scenarios": {"conservative": _SC, "base": _SC, "optimistic": _SC},
}

_LB = {"level": "중", "summary": "요약", "detail": "상세"}
EXECUTION = {
    "scores": {"execution": score(5, "execution:5-6"), "risk": score(4, "risk:3-4")},
    "summary": "KC 인증이 최대 변수다.",
    "tech": _LB,
    "capital": _LB,
    "people": _LB,
    "regulation": {**_LB, "lead_time_weeks": N(8, "주")},
}

CRITIC = {
    "objections": [
        {"angle": a, "claim": "주장", "evidence": "근거", "evidence_url": "https://x.com"}
        for a in schema.OBJECTION_ANGLES
    ],
    "adjustments": [{"axis": "market", "delta": -1, "reason": "사유", "evidence_url": "https://x.com"}],
}

_SCORE_ADJ = {**score(), "adjusted_from": None}
REPORT = {
    "idea_raw": "따뜻한 폼롤러",
    "normalized": {k: NORMALIZER[k] for k in (
        "product", "target", "differentiator", "industry_code", "industry_confidence",
        "interpretation", "alternative_interpretation")},
    "verdict": {"grade": "B-", "decision": "조건부 진행", "one_liner": "판정"},
    "assumptions": [ASSUMPTION],
    "scores": {a: copy.deepcopy(_SCORE_ADJ) for a in schema.AXES},
    "market": {k: v for k, v in MARKET.items() if k != "scores"},
    "roi": {k: v for k, v in FINANCE.items() if k != "scores"},
    "feasibility": {k: v for k, v in EXECUTION.items() if k != "scores"},
    "critique": CRITIC,
    "roadmap": [
        {"stage": f"{i}단계", "period": "0~4주", "actions": ["할 일"], "cost": N(100, "만원", "", "estimated"), "gate_condition": "조건"}
        for i in range(3)
    ],
    "sources": [{"title": "t", "url": "https://a.com", "used_for": "시장"}],
    "degraded_sections": [],
}

VALID = {
    "normalizer": NORMALIZER,
    "market": MARKET,
    "finance": FINANCE,
    "execution": EXECUTION,
    "critic": CRITIC,
    "synthesizer": REPORT,
}


class ValidSamples(unittest.TestCase):
    def test_each_agent_valid_sample_passes(self):
        for agent_id, sample in VALID.items():
            with self.subTest(agent=agent_id):
                self.assertEqual(schema.validate(agent_id, sample), [])

    def test_all_agents_have_schema(self):
        self.assertEqual(set(schema.SCHEMAS), set(schema.AGENT_IDS))


class InvalidSamples(unittest.TestCase):
    def test_missing_field_fails(self):
        bad = copy.deepcopy(MARKET)
        del bad["size"]
        self.assertTrue(any("size" in e for e in schema.validate("market", bad)))

    def test_score_out_of_range_fails(self):
        bad = copy.deepcopy(MARKET)
        bad["scores"]["market"]["score"] = 11
        self.assertTrue(schema.validate("market", bad))

    def test_critic_delta_below_minus_two_fails(self):
        bad = copy.deepcopy(CRITIC)
        bad["adjustments"][0]["delta"] = -3
        self.assertTrue(schema.validate("critic", bad))

    def test_critic_positive_delta_fails(self):
        bad = copy.deepcopy(CRITIC)
        bad["adjustments"][0]["delta"] = 1
        self.assertTrue(schema.validate("critic", bad))

    def test_critic_needs_three_distinct_angles(self):
        bad = copy.deepcopy(CRITIC)
        bad["objections"][1]["angle"] = bad["objections"][0]["angle"]
        self.assertTrue(schema.validate("critic", bad))

    def test_null_section_requires_degraded_entry(self):
        bad = copy.deepcopy(REPORT)
        bad["roi"] = None
        self.assertTrue(schema.validate("synthesizer", bad))
        bad["degraded_sections"] = ["roi"]
        self.assertEqual(schema.validate("synthesizer", bad), [])

    def test_non_object_fails(self):
        self.assertTrue(schema.validate("market", ["x"]))


class NumberNormalization(unittest.TestCase):
    def test_empty_source_forces_estimated(self):
        out = schema.normalize_numbers({"a": N(1, "억원", "", "sourced")})
        self.assertEqual(out["a"]["confidence"], "estimated")

    def test_none_source_becomes_empty_and_estimated(self):
        out = schema.normalize_numbers({"a": {"value": 1, "unit": "개", "source_url": None, "confidence": "sourced"}})
        self.assertEqual(out["a"]["source_url"], "")
        self.assertEqual(out["a"]["confidence"], "estimated")

    def test_url_not_in_search_pool_is_demoted(self):
        out = schema.normalize_numbers({"a": N(1, "개", "https://fake.example/x")}, allowed_urls=["https://real.com/1"])
        self.assertEqual(out["a"]["source_url"], "")
        self.assertEqual(out["a"]["confidence"], "estimated")

    def test_url_in_pool_is_kept_even_with_trailing_slash(self):
        out = schema.normalize_numbers({"a": N(1, "개", "https://real.com/1/")}, allowed_urls=["https://real.com/1"])
        self.assertEqual(out["a"]["confidence"], "sourced")

    def test_string_number_is_coerced(self):
        out = schema.normalize_numbers({"a": {"value": "3,200", "unit": "억원", "source_url": "", "confidence": "estimated"}})
        self.assertEqual(out["a"]["value"], 3200.0)

    def test_assumption_dict_is_not_treated_as_number(self):
        out = schema.normalize_numbers({"assumptions": [ASSUMPTION]})
        self.assertNotIn("confidence", out["assumptions"][0])

    def test_original_not_mutated(self):
        original = {"a": N(1, "개", "", "sourced")}
        schema.normalize_numbers(original)
        self.assertEqual(original["a"]["confidence"], "sourced")


class ExtractJson(unittest.TestCase):
    def test_plain(self):
        self.assertEqual(schema.extract_json('{"a": 1}'), {"a": 1})

    def test_markdown_fence(self):
        self.assertEqual(schema.extract_json('```json\n{"a": 1}\n```'), {"a": 1})

    def test_chatter_around_json(self):
        self.assertEqual(schema.extract_json('결과입니다:\n{"a": {"b": 2}}\n끝'), {"a": {"b": 2}})

    def test_garbage_raises(self):
        with self.assertRaises(ValueError):
            schema.extract_json("JSON 없음")


class RetryLogic(unittest.TestCase):
    def test_first_try_success(self):
        calls = []
        res = schema.run_with_retry("critic", lambda fb: calls.append(fb) or json.dumps(CRITIC))
        self.assertTrue(res.ok)
        self.assertEqual(res.attempts, 1)
        self.assertEqual(calls, [None])

    def test_retry_once_then_success_and_feedback_passed(self):
        outputs = ["깨진 응답", "```json\n" + json.dumps(CRITIC) + "\n```"]
        feedbacks = []

        def call(fb):
            feedbacks.append(fb)
            return outputs.pop(0)

        res = schema.run_with_retry("critic", call)
        self.assertTrue(res.ok)
        self.assertEqual(res.attempts, 2)
        self.assertIsNone(feedbacks[0])
        self.assertIn("거부", feedbacks[1])

    def test_two_failures_degrade_without_raising(self):
        def call(fb):
            raise RuntimeError("API 다운")

        res = schema.run_with_retry("finance", call)
        self.assertFalse(res.ok)
        self.assertEqual(res.attempts, 2)
        self.assertIsNone(res.data)
        self.assertIn("RuntimeError", res.errors[0])

    def test_schema_violation_twice_fails(self):
        bad = json.dumps({"objections": [], "adjustments": []})
        res = schema.run_with_retry("critic", lambda fb: bad)
        self.assertFalse(res.ok)
        self.assertEqual(res.attempts, 2)

    def test_normalization_applied_before_validation(self):
        sample = copy.deepcopy(MARKET)
        sample["size"] = N(3200, "억원", "https://made-up.example/x")  # 풀에 없는 URL
        res = schema.run_with_retry("market", lambda fb: json.dumps(sample), allowed_urls=["https://real.com"])
        self.assertTrue(res.ok)
        self.assertEqual(res.data["size"]["confidence"], "estimated")


class ProjectFiles(unittest.TestCase):
    def test_industry_params_has_eight_industries_matching_schema(self):
        params = json.loads((ROOT / "data" / "industry_params.json").read_text(encoding="utf-8"))
        self.assertEqual(set(params["industries"]), set(schema.INDUSTRY_CODES))
        refined = [k for k, v in params["industries"].items() if v.get("refined")]
        self.assertEqual(sorted(refined), ["commerce", "manufacturing"])
        self.assertEqual(len(params["scenario_model"]["ramp"]), 12)

    def test_default_interpretation_exists_for_refined_industries(self):
        params = json.loads((ROOT / "data" / "industry_params.json").read_text(encoding="utf-8"))
        for code in ("manufacturing", "commerce"):
            ind = params["industries"][code]
            self.assertIn(ind["default_interpretation"], ind["interpretations"])

    def test_rubric_mentions_all_five_axes(self):
        text = (ROOT / "skills" / "viability_rubric.md").read_text(encoding="utf-8")
        for axis in schema.AXES:
            self.assertIn(f"### {axis} ", text)

    def test_roi_simulator_skill_exists(self):
        self.assertTrue((ROOT / "skills" / "roi_simulator.md").read_text(encoding="utf-8").strip())


if __name__ == "__main__":
    unittest.main()
