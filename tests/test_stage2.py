"""2단계 단위 테스트: 입력 검증·쿼리 중복 제거·검색 풀 재검색 금지 (API 호출 없음)."""
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import search_pool  # noqa: E402
from agents import normalizer  # noqa: E402


class InputValidation(unittest.TestCase):
    def test_rejects_empty_and_whitespace(self):
        for t in ("", "   ", None):
            self.assertFalse(normalizer.validate_idea(t)[0], t)

    def test_rejects_jamo_gibberish(self):
        for t in ("ㅁㄴㅇㄹ", "ㅋㅋㅋㅋ", "!!!???", "12345", "ㅁㄴㅇㄹ ㅂㅈㄷㄱ"):
            self.assertFalse(normalizer.validate_idea(t)[0], t)

    def test_rejects_repeated_char(self):
        self.assertFalse(normalizer.validate_idea("아아아아아아")[0])

    def test_rejects_too_long(self):
        self.assertFalse(normalizer.validate_idea("가나다라" * 30)[0])

    def test_accepts_real_ideas(self):
        for t in ("따뜻한 폼롤러", "AI 필라테스 코치 앱", "반려견 수제간식 정기배송"):
            self.assertTrue(normalizer.validate_idea(t)[0], t)

    def test_three_example_ideas_are_valid(self):
        self.assertEqual(len(normalizer.EXAMPLE_IDEAS), 3)
        for t in normalizer.EXAMPLE_IDEAS:
            self.assertTrue(normalizer.validate_idea(t)[0], t)


class QueryDedupe(unittest.TestCase):
    def test_removes_reordered_and_punctuation_duplicates(self):
        qs = ["폼롤러 시장 규모", "폼롤러  시장 규모!", "시장 규모 폼롤러", "KC 인증 비용"]
        self.assertEqual(search_pool.dedupe_queries(qs), ["폼롤러 시장 규모", "KC 인증 비용"])

    def test_caps_at_max_queries(self):
        qs = [f"완전히 다른 검색어{chr(0xAC00 + i * 50)}{i}" for i in range(15)]
        self.assertEqual(len(search_pool.dedupe_queries(qs)), search_pool.MAX_QUERIES)
        self.assertLessEqual(search_pool.MAX_QUERIES, 9)  # 기획서 상한

    def test_normalizer_dedupe(self):
        self.assertEqual(normalizer._dedupe_queries(["A 검색", "a검색", "B 검색"]), ["A 검색", "B 검색"])


class PoolNoRepeat(unittest.TestCase):
    def test_same_query_is_not_searched_twice(self):
        pool = search_pool.SearchPool()
        calls = []
        with mock.patch.object(pool, "_search_one", side_effect=lambda q: calls.append(q)):
            pool.collect(["폼롤러 시장", "KC 인증 비용"])
            pool.collect(["폼롤러 시장", "새 검색어 추가"])
        self.assertEqual(sorted(calls), ["KC 인증 비용", "새 검색어 추가", "폼롤러 시장"])

    def test_failed_query_is_recorded_and_others_continue(self):
        pool = search_pool.SearchPool()

        def fake(q):
            if "실패" in q:
                raise RuntimeError("boom")

        with mock.patch.object(pool, "_search_one", side_effect=fake):
            pool.collect(["실패할 검색", "정상 검색어"])
        self.assertEqual([f["query"] for f in pool.failed_queries], ["실패할 검색"])


if __name__ == "__main__":
    unittest.main()
