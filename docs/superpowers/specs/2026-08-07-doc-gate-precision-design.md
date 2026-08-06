# doc-gate-precision — doc-coverage 게이트 정밀화 (ui-claude-md-curation 연기 ③④⑤⑥ 회수)

- **유형**: internal-polish (production 0-diff — `scripts/`·`Justfile`·`docs/`만)
- **날짜**: 2026-08-07
- **출처**: `docs/build-log.md` §ui-claude-md-curation 연기 목록 ③④⑤⑥ (①②는 이 슬라이스 비목표 — 사용자 스코프 결정 2026-08-07)

## 사용자 스토리 (US)

- **US1**: 개발자-도구가 문서 압축 슬라이스에서 `just doc-coverage`를 돌릴 때 유령 토큰 없이 진짜 식별자 소실만 판정받는다 — 성공하면 아티팩트 allowlist 5행을 삭제한 상태에서 게이트가 OK를 낸다(현행은 삭제 시 FAIL 5건 — C2 실측).
- **US2**: 개발자-도구가 이동 검증의 OK를 "옮긴 지식이 목적지에 살아있다"로 신뢰하려 한다 — 성공하면 소스 파일에만 존재하는 토큰의 backtick을 해제하는 합성 실험에서 게이트가 FAIL을 낸다(현행은 소스 자기-매치로 조용히 통과 = 은폐), 원복 시 다시 OK.
- **US3**: 개발자-도구가 `docs/dev/root-doc-maintenance.md`·Justfile 주석·FAIL 문구를 따라 게이트를 운영·디버깅한다 — 성공하면 줄번호 인용 대신 grep 1회로 도달하는 검사명 인용을 보고, FAIL 문구가 "root"가 아닌 검사 대상 소스를 가리키며, narratives의 R10 "byte-identical 유지"가 당시-제약임을 명시해 현행 상시 제약으로 오독되지 않는다.

(US 승인: 2026-08-07 사용자, brainstorming 종료 게이트.)

## 1. 배경 — 무엇이 왜 문제인가

`scripts/check-doc-coverage.py`의 토큰 차분(3차 방어선)은 base 문서에서 사라진 토큰이 corpus 어딘가에 살아있는지 검사한다. ui-claude-md-curation(머지 `cc8114ea`)에서 두 결함이 드러나 연기됐다:

- **③ 짝-밀림 아티팩트**: `tokens()`의 backtick 정규식이 2–80자 스팬만 *매치*하므로, 1글자 인라인코드(`` `×` ``·`` `?` `` 등)·80자 초과 스팬을 건너뛴다. 건너뛴 스팬의 닫는 backtick이 다음 스팬의 여는 backtick과 짝지어져 **두 코드 스팬 사이의 산문**이 토큰으로 오인된다. 직전 슬라이스에서 이 유령 토큰 5건이 거짓 FAIL을 냈고(T3 BLOCKED), 근거 주석을 단 allowlist 5행으로 우회했다.
- **④ corpus 소스-자기포함**: corpus에 검사 대상 소스 파일 자신이 들어 있어, 토큰이 토큰 집합에서는 사라졌지만 산문 substring으로 소스에 남아 있으면 "찾았다"로 통과한다. 유령 5건이 추가로 이 경로에 가려졌고(build-log "실개수 10건"의 나머지 5), 구조적으로는 진짜 소실도 소스의 우연 substring이 가릴 수 있다.
- **⑤ 안내 stale**: `root-doc-maintenance.md`의 스크립트 줄번호 인용 3곳이 전부 밀렸고(C5), Justfile 주석·`[move]` FAIL 문구가 소스 파라미터화 이전의 "root" 서술로 남아 있다.
- **⑥ R10 서술 경계**: `docs/dev/ui-gotcha-narratives.md` §`LoadShapePreview` 조각화(R10)의 "판정 로직 byte-identical 유지"가 그 리팩터 task 당시의 제약인지 현행 상시 제약인지 경계가 없다 (record-only).

## 2. 설계 (A안 — 원인 제거; 사용자 채택 2026-08-07)

### 2.1 `scripts/check-doc-coverage.py`

1. **`tokens()` 짝-보존**: backtick 규칙을 backtick-run 구분자 정규식으로 교체 — 스팬을 길이 무관하게 짝으로 소비하고, **토큰 채택만 2–80자 유지**(실식별자 탐지 범위 불변):

   ```python
   def tokens(t):
       s = {m[1] for m in re.findall(r"(`+)([^`\n]*?)\1", t) if 2 <= len(m[1]) <= 80}
       s |= set(re.findall(r"docs/[A-Za-z0-9/_.-]+\.md", t))
       s |= set(re.findall(r"ADR-\d{4}", t))
       return s
   ```

   run 구분자라 이중 backtick 인라인(````…````)도 올바로 소비한다(현행 사용 0건 — C3). 내용에 backtick을 *포함*하는 이중 스팬(``` ``a ` b`` ```)의 완전 마크다운 파싱은 **비목표** — 그 구문에선 국소 오추출이 이론상 가능하나 현행 0건(C3의 `` grep '``' ``가 감시 명령)이고, 문장 단위 산문이 토큰이 되는 기존 급의 아티팩트는 어느 경우에도 재발하지 않는다. base/현행 양쪽에 동일 적용되므로 차분 일관.
2. **corpus 소스 자기-제외**: `main()`의 corpus 조립에서 검사 대상 소스를 제외 — `if pathlib.Path(p).resolve() != pathlib.Path(src).resolve()`. 소실 증명은 목적지에서만 성립한다. root `CLAUDE.md`는 원래 corpus 리터럴에 없으므로 root 소스 실행 거동 불변.
3. **`[move]` FAIL 문구 소스-중립화** (2곳만): `base root에 anchor 없음` → `base 소스에 anchor 없음`, `root에 anchor 잔존(미제거)` → `소스에 anchor 잔존(미제거)`. 내부 변수 `base_root`/`cur_root` → `base_src`/`cur_src`. **다른 FAIL 문구(manifest·R17·R18·토큰)는 불변** — 문서가 verbatim 인용 중(변경 시 sweep 비용만 늘고 이득 없음).

### 2.2 `scripts/doc-coverage-allowlist.txt`

- 아티팩트 5행(현행 16–20행, "ui-curation 토큰 아티팩트" 근거 행 전부) **삭제** — 2.1-1 이후 차분에서 전소멸(C2)이라 죽은 행이다.
- 실식별자 4행(12–15행)은 **유지** — root 소스 수동 실행 이력용(현행 기본 실행에선 inert — C6).
- 헤더의 "후행 공백 load-bearing" 경고는 **유지하되 근거를 일반화**: 짝-밀림 산문 조각 서사를 지우고 "토큰 필드는 탭 앞까지 byte-exact(후행 공백 포함 — backtick 스팬은 공백으로 끝날 수 있다)"로. 트리머 금지 경고 자체는 여전히 참.

### 2.3 문서 3곳 현행화

1. **`docs/dev/root-doc-maintenance.md`**:
   - 줄번호 인용 3곳(`check-doc-coverage.py:87`·`:114`·`:126`)을 **검사명 인용**으로 교체(사용자 채택): `rows()` 함수 · `[move]`의 "base 소스에 anchor" 검사 · `[move]`의 marker 신규성(⑤) 검사. 줄번호 rot 재발 원인 제거.
   - "토큰 차분 함정 2종" 중 **②({2,80} 짝-밀림)를 해소됨으로 갱신**(doc-gate-precision에서 짝-보존 정규식 — 아티팩트는 더 이상 생기지 않는다; corpus 소스-자기포함 은폐도 함께 해소). ①(후행 공백 byte-exact)은 잔존 — 근거만 2.2와 동일하게 일반화.
   - `base:CLAUDE.md` 고정 표기는 소스 파라미터화에 맞춰 `base:<소스>`로.
2. **`Justfile`** doc-coverage 주석: "root CLAUDE.md 재분배 이동 검증" → 소스 파라미터화(`<base> [source]`)를 반영한 일반 서술(coverage 검사 명명은 유지).
3. **`docs/dev/ui-gotcha-narratives.md`** §`LoadShapePreview` 조각화(R10): "판정 로직 byte-identical 유지"가 **그 리팩터 task 당시의 no-behavior-change 제약**이었음을 명시하는 경계 한 문장 추가 — 현행 상시 제약이 아니며, 이후 판정 로직 변경은 자유(record-only, 다른 서술 불변).

### 2.4 sweep 의무 (패턴 재발 방지 규율)

2.1-3의 문구 개명·2.3-1의 함정 ② 갱신 후, 옛 서술 잔존을 **경계 없는 전수 grep**으로 확인:

```bash
grep -rn "base root에 anchor\|root에 anchor 잔존" docs/ scripts/ Justfile .claude/ CLAUDE.md ui/CLAUDE.md
grep -rn "check-doc-coverage.py:[0-9]" docs/ .claude/ CLAUDE.md
```

기대: 0건(단, `docs/build-log.md`·메모리 등 **이력 기록은 당시 사실이므로 수정 금지** — 매치가 이력 파일뿐이면 통과). root CLAUDE.md 상태줄·roadmap-status의 연기 언급은 finish-slice가 교체하므로 이 슬라이스 sweep 대상 아님.

## 3. 비목표

- 연기 ①(ui/CLAUDE.md L108 ② 앵커 절 복원)·②(섹션 포인터 키워드 보강) — 사용자 스코프 결정으로 제외.
- `scripts/check-doc-budget.py`·`BASELINES`·R18 — 무접촉.
- ADR 신선화 pass — 별개 후보.
- 게이트 스크립트 상설 테스트 도입 — 이 레포 규약은 수동 RED/GREEN 이빨 실증(§4)이며 이번에 바꾸지 않는다.

## 4. 검증 (이빨 재실증 — 두 상태 규율)

게이트 판정은 전부 파이프 없이 `…; echo exit=$?`로 종료코드 명시 캡처.

| # | 실증 | baseline(변경 전) 기대 | 변경 후 기대 |
|---|---|---|---|
| V1 (US1) | allowlist 아티팩트 5행 삭제 상태에서 `just doc-coverage` | **FAIL 5건**(유령 토큰 소실) | **OK** |
| V2 (US2) | 소스-유일 토큰 하나의 backtick을 현행 ui/CLAUDE.md에서 임시 해제 → `just doc-coverage` → 원복. 토큰 선정 절차: C4 후보(437건) 중 **현행 소스에서 backtick 스팬으로 정확히 1회 등장**하는 것을 plan이 grep으로 고정(2회 이상이면 한 곳 해제해도 토큰 집합에 잔존해 차분에 안 뜬다) | **OK**(소스 자기-매치 은폐 — 이것이 결함) | **FAIL 1건** → 원복 후 **OK** |
| V3 (③ 단위) | 1글자 인라인코드가 낀 합성 텍스트로 `tokens()` 직접 호출(python -c) | 산문 조각이 토큰으로 추출됨 | 산문 조각 미추출 + 인접 실토큰 정상 추출 |
| V4 (회귀) | 변경+allowlist 정리 후 `just doc-coverage` (기본 f870cfd9/ui) | — | **OK** (C2에서 사전 실측 완료) |

V1·V2는 같은 조작을 변경 전/후 **두 상태 모두**에서 돌려 "결함이 실재했고, 수정이 그 결함을 제거했다"를 쌍으로 실증한다(고의 회귀→RED→원복→GREEN의 게이트판).

## 5. Claims ledger (사실 주장 ↔ 생성 명령 — plan 디스패치 전 일괄 재실행)

| # | 주장 | 명령 |
|---|---|---|
| C1 | 현재 게이트 GREEN (manifest 61행·R17 8섹션) | `just doc-coverage; echo exit=$?` → `OK … exit=0` |
| C2 | 짝-보존+소스-제외 적용 시 base f870cfd9 대비 아티팩트 스팬 18건 전소멸(allowlist 5건 포함)·잔존 FAIL 후보 0 → allowlist 5행 삭제 가능 | 재현 스크립트(아래 §5.1) 실행 — `=== fixed tokens() + corpus(소스 제외) 기준 FAIL 후보` 출력 0건 |
| C3 | 이중 backtick 인라인 사용 0건(cur·base ui/CLAUDE.md), root 4건은 전부 ``` 펜스 줄 | `grep -c '\`\`' ui/CLAUDE.md CLAUDE.md; git show f870cfd9:ui/CLAUDE.md \| grep -c '\`\`'` → 0·4·0 + 펜스 여부 육안 |
| C4 | US2 이빨용 소스-유일 토큰 실존(437건) | §5.1 동형 로직으로 `toks(base)∩toks(cur)` 중 corpus(소스 제외) 무매치 나열 → 437 |
| C5 | 문서 줄번호 인용 3곳 stale (`:87/:114/:126` → 실제 88/125/137) | `grep -n "def rows\|if anchor not in base_root\|elif int(gain) > 0 and m in base_dest" scripts/check-doc-coverage.py` |
| C6 | allowlist 실식별자 4행은 현행 기본 실행(ui 소스)의 차분에 미등장(inert) | §5.1 출력에서 해당 4 토큰 부재 확인 |

### 5.1 C2/C4 재현 로직 (plan이 검증 스크립트로 옮겨 쓸 정본)

base=`f870cfd9`, src=`ui/CLAUDE.md`. ① 현행 `tokens()`와 짝-보존판(`(`+)([^`\n]*?)\1` 후 2–80 채택)을 각각 base/cur에 적용해 차분 계산 ② 각 차분 토큰을 allowlist·corpus(소스 포함)·corpus(소스 제외)에 대조 분류 ③ 짝-보존판 차분 중 corpus(소스 제외) 무매치 = FAIL 후보. 2026-08-07 실측: 현행 차분 163건 → 짝-보존판 153건(아티팩트 18건 소멸·정상 포획 신규 8건 — 전부 corpus 매치), FAIL 후보 0건.

## 6. 파이프라인 메모

- production 0-diff → **라이브 검증 생략 근거 성립**(US 증명은 §4 게이트 실측이 대신 — ui-claude-md-curation 선례). 보안 게이트는 finish-slice §0 grep이 결정(스크립트·docs만이라 무매치 예상이나 grep이 지배).
- pre-commit: cargo-영향·`ui/`(non-.md) staged 없음 → fast-pass. tdd-guard: `crates/*/src`·`ui/src` 무접촉.
- plan task 구성 제안: T1 스크립트+allowlist+이빨 V1~V4, T2 문서 3곳+sweep(2.4). 각 독립 green 커밋.
