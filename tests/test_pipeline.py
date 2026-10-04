"""파이프라인 오류 처리 테스트 (API 호출 없음): 소비자에게 기술 오류를 노출하지 않고, 전원 실패를 빈 리포트로 위장하지 않는다."""
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pipeline  # noqa: E402
import schema  # noqa: E402


def _fail(agent_id):
    return schema.AgentResult(agent_id, False, None, ["BadRequestError: credit balance is too low"], 2)


class ErrorHandling(unittest.TestCase):
    def test_all_specialists_failing_raises_abort_with_friendly_message(self):
        results = {a: _fail(a) for a in ("market", "finance", "execution")}
        with mock.patch.object(pipeline, "prepare", return_value=({"industry_code": "manufacturing"}, mock.Mock(allowed_urls=set()))), \
             mock.patch.object(pipeline, "run_specialists", return_value=results):
            with self.assertRaises(pipeline.PipelineAbort) as ctx:
                pipeline.run_pipeline("따뜻한 폼롤러")
        msg = str(ctx.exception)
        self.assertEqual(msg, pipeline.USER_FACING_ERROR)
        self.assertNotIn("credit", msg.lower())  # 결제·기술 원인을 소비자에게 노출하지 않는다
        self.assertNotIn("BadRequest", msg)

    def test_normalizer_failure_hides_technical_reason(self):
        with mock.patch.object(pipeline.normalizer, "run", return_value=_fail("normalizer")):
            with self.assertRaises(pipeline.PipelineAbort) as ctx:
                pipeline.prepare("따뜻한 폼롤러")
        self.assertEqual(str(ctx.exception), pipeline.USER_FACING_ERROR)

    def test_invalid_input_message_is_still_specific(self):
        with self.assertRaises(pipeline.PipelineAbort) as ctx:
            pipeline.prepare("ㅁㄴㅇㄹ")
        self.assertNotEqual(str(ctx.exception), pipeline.USER_FACING_ERROR)


if __name__ == "__main__":
    unittest.main()
