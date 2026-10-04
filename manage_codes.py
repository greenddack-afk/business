"""초대 코드 관리 도구.

  python manage_codes.py new 5 시범     # '시범1'~'시범5' 메모가 붙은 코드 5개 발급
  python manage_codes.py list           # 등록된 코드와 누적·오늘 사용량
  python manage_codes.py reset ABCD-EFGH-JKMN   # 그 코드의 누적 사용 횟수를 0으로
  python manage_codes.py revoke ABCD-EFGH-JKMN   # 코드 폐기
  python manage_codes.py env            # 배포 서비스(Render 등) 환경변수 INVITE_CODES에 붙여 넣을 한 줄
"""
import sys

import invite


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    args = sys.argv[1:]
    cmd = args[0] if args else "list"

    if cmd == "new":
        n = int(args[1]) if len(args) > 1 else 5
        label = args[2] if len(args) > 2 else ""
        for code in invite.generate(n, label):
            print(code)
        per, total, life = invite.limits()
        print(f"\n{n}개 발급했어요. 코드당 총 {life}회까지, 서비스 전체는 하루 {total}회까지 쓸 수 있어요.")
    elif cmd == "list":
        codes, u = invite.load_codes(), invite.usage_report()
        per, total, life = invite.limits()
        print(f"등록된 코드 {len(codes)}개 · 오늘 서비스 전체 {u['total']}/{total}회 사용")
        for c, info in codes.items():
            used = u["lifetime"].get(c, 0)
            print(f"  {info['code']:<16} 누적 {used}/{life or '무제한'}회 (오늘 {u['codes'].get(c, 0)}회)  {info['label']}")
    elif cmd == "reset" and len(args) > 1:
        print("누적 횟수를 0으로 되돌렸어요." if invite.reset_lifetime(args[1]) else "사용 기록이 없는 코드예요.")
    elif cmd == "revoke" and len(args) > 1:
        print("폐기했어요." if invite.revoke(args[1]) else "그런 코드를 찾지 못했어요.")
    elif cmd == "env":
        print(",".join(f"{i['code']}:{i['label']}" if i["label"] else i["code"] for i in invite.load_codes().values()))
    else:
        print(__doc__)


if __name__ == "__main__":
    main()
