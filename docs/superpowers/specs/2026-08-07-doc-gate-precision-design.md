# doc-gate-precision — doc-coverage 게이트 정밀화 (ui-claude-md-curation 연기 ③④⑤⑥ 회수)

- **유형**: internal-polish (production 0-diff — `scripts/`·`Justfile`·`docs/`만)
- **날짜**: 2026-08-07
- **출처**: `docs/build-log.md` §ui-claude-md-curation 연기 목록 ③④⑤⑥ (①②는 이 슬라이스 비목표 — 사용자 스코프 결정 2026-08-07)

## 사용자 스토리 (US)

- **US1**: 개발자-도구가 문서 압축 슬라이스에서 `just doc-coverage`를 돌릴 때 유령 토큰 없이 진짜 식별자 소실만 판정받는다 — 성공하면 아티팩트 allowlist 5행을 삭제한 상태에서 게이트가 OK를 낸다(현행은 삭제 시 FAIL 5건 — C2 실측).
- **US2**: 개발자-도구가 이동 검증의 OK를 "옮긴 지식이 목적지에 살아있다"로 신뢰하려 한다 — 성공하면 소스 파일에만 존재하는 토큰의 backtick을 해제하는 합성 실험에서 게이트가 FAIL을 낸다(현행은 소스 자기-매치로 조용히 통과 = 은폐), 원복 시 다시 OK.
- **US3**: 개발자-도구가 게이트 FAIL을 만나 `docs/dev/root-doc-maintenance.md`·Justfile 주석·FAIL 문구만으로 원인 검사에 도달하려 한다 — 성공하면 인용된 검사명으로 grep 1회에 해당 코드에 도달하고(썩은 줄번호 인용 0건), FAIL 문구·주석·allowlist 헤더가 소스 파라미터화·소스-제외 이후의 실제 동작과 일치하며, narratives R10 **본문**이 당시-제약임을 명시해 현행 상시 제약으로 오독되지 않는다.

(US 승인: 2026-08-07 사용자. US3은 spec 리뷰 C-e finding으로 도달-가능성 오라클로 재작성 — 의도 불변, 사용자 최종 리뷰에서 재확인.)

## 1. 배경 — 무엇이 왜 문제인가

`scripts/check-doc-coverage.py`의 토큰 차분(3차 방어선)은 base 문서에서 사라진 토큰이 corpus 어딘가에 살아있는지 검사한다. ui-claude-md-curation(머지 `cc8114ea`)에서 두 결함이 드러나 연기됐다:

- **③ 짝-밀림 아티팩트**: `tokens()`의 backtick 정규식이 2–80자 스팬만 *매치*하므로, 1글자 인라인코드(`` `×` ``·`` `?` `` 등)·80자 초과 스팬을 건너뛴다. 건너뛴 스팬의 닫는 backtick이 다음 스팬의 여는 backtick과 짝지어져 **두 코드 스팬 사이의 산문**이 토큰으로 오인된다. 직전 슬라이스에서 이 유령 토큰 5건이 거짓 FAIL을 냈고(T3 BLOCKED), 근거 주석을 단 allowlist 5행으로 우회했다.
- **④ corpus 소스-자기포함**: corpus에 검사 대상 소스 파일 자신이 들어 있어, 토큰이 토큰 집합에서는 사라졌지만 산문 substring으로 소스에 남아 있으면 "찾았다"로 통과한다. 유령 5건이 추가로 이 경로에 가려졌고(build-log "실개수 10건"의 나머지 5), 구조적으로는 진짜 소실도 소스의 우연 substring이 가릴 수 있다.
- **⑤ 안내 stale**: `root-doc-maintenance.md`의 스크립트 줄번호 인용 3곳이 전부 밀렸고(C5), Justfile 주석·`[move]` FAIL 문구·allowlist 헤더가 소스 파라미터화 이전의 "root" 서술로 남아 있다.
- **⑥ R10 서술 경계(축소 — 리뷰 F1)**: `docs/dev/ui-gotcha-narratives.md` §R10 **헤딩**엔 "— 리팩터 당시 제약"이 이미 있다(cc8114ea fix-wave 헤딩 보강). 남은 갭은 **본문 232행 문장**뿐 — "판정 로직 … byte-identical 유지"가 무기한 명령형이라 단독 인용 시 현행 상시 제약으로 오독될 수 있다 (record-only).

## 2. 설계 (A안 — 원인 제거; 사용자 채택 2026-08-07)

### 2.1 `scripts/check-doc-coverage.py`

1. **`tokens()` 짝-보존**: backtick 규칙을 backtick-run 구분자 정규식으로 교체 — 스팬을 길이 무관하게 짝으로 소비하고, **토큰 채택 길이창(2–80자)만 유지**:

   ```python
   def tokens(t):
       s = {m[1] for m in re.findall(r"(`+)([^`\n]*?)\1", t) if 2 <= len(m[1]) <= 80}
       s |= set(re.findall(r"docs/[A-Za-z0-9/_.-]+\.md", t))
       s |= set(re.findall(r"ADR-\d{4}", t))
       return s
   ```

   - **효과 (관측된 아티팩트 전소멸)**: base f870cfd9 대비 차분에서 짝-밀림 산문 조각 18건 전부 소멸(C2). run 구분자라 이중 backtick 인라인(````…````)도 올바로 소비(현행 사용 0건 — C3).
   - **잔존 한계 (정직 서술 — 리뷰 F3)**: "아티팩트가 어느 경우에도 불가능"은 아니다. ⓐ **줄 안 backtick 홀수**면 양 정규식이 동일하게 산문을 뽑을 수 있고(반례 실측: `` 쓰지 말 것 ` 대신 `bar` 를 써라 `` → `' 대신 '`), ⓑ **run-길이 불일치**(내부 backtick 포함 이중 스팬)에선 신 정규식도 국소 오추출 가능(C8 반례). 둘 다 현행 소스 0건이며 C3의 `` grep '``' ``·이빨 V3가 감시 지점이다. 완전 마크다운 파싱은 비목표.
   - **탐지 집합 확대 (리뷰 F2 — "탐지 범위 불변" 아님)**: 짝-밀림에 *가려져 있던* 실식별자가 추가 포획된다 — 전체 토큰 집합 실측(C7): base ui **+42/−65**, 현행 ui **+28/−48**, root 17369d32 **+8/−17**, 현행 root **+5/−8** (+ = 새로 포획된 실스팬, − = 소멸한 산문 조각). 부수효과: 게이트가 소스당 수십 토큰을 더 추적해 **엄격해진다**(의도된 방향) — 향후 큐레이션에서 소실 판독 대상이 늘 수 있음을 명시해 둔다.
2. **corpus 소스 자기-제외**: `main()`의 corpus 조립 호출부(현행 `corpus = "".join(…)` 컴프리헨션)에서 `if pathlib.Path(p).resolve() != pathlib.Path(src).resolve()` 필터 — **`corpus_paths()` 시그니처는 불변**(리뷰 M1 — 옛 spec들이 함수명 인용 중). 소실 증명은 목적지에서만 성립한다. root `CLAUDE.md`는 원래 corpus 리터럴에 없으므로 root 소스 실행 거동 불변.
3. **토큰 소실 진단 2분화 (리뷰 R1/M2 결정; 코드 형태는 리뷰 B1로 고정)**: 소스-제외 후 "소스에 산문으로 남았지만 목적지엔 없는" 토큰(정당한 backtick 해제 리라이팅 포함)이 기존 문구 `소실(목적지 어디에도 없음)`으로 찍히면 **거짓 진단**이다(텍스트는 소스에 실재). **반드시 중첩 분기**(corpus·allowlist 통과 실패가 확정된 뒤 메시지만 2분화)로 구현한다 — `t in cur_src`를 corpus 검사와 **독립으로** 두면 정당하게 이관된 식별자 28건이 거짓 FAIL이 된다(C12 실측). **allowlist는 두 분기 공통 억제**(§2.2 헤더가 운영자에게 약속하는 경로):

   ```python
   for t in sorted(tokens(base_src) - tokens(cur_src)):
       if t in corpus or t in allow:      # allowlist는 두 분기 공통 억제
           continue
       msg = ("소스에 산문으로 잔존 — 목적지 미확인" if t in cur_src
              else "소실(목적지 어디에도 없음)")
       fails.append(f"FAIL [토큰] {msg}: {t[:60]}")
   ```

   여전히 blocking(게이트 약화 아님) — 운영자가 정확한 원인으로 allowlist/이동 판단을 하게 하는 것이 목적. 기본 실행(f870cfd9/ui)에서 이 분기의 결과는 FAIL 0 = 현행 유지(C2).
4. **`[move]` FAIL 문구 소스-중립화**: 기준 = **"root" 오지칭이 있는 문구만** 개명(리뷰 C-b — "verbatim 인용 여부"는 기준이 못 된다; 인용 문서는 §2.4 sweep이 따라간다): `base root에 anchor 없음` → `base 소스에 anchor 없음`, `root에 anchor 잔존(미제거)` → `소스에 anchor 잔존(미제거)`. 다른 FAIL 문구(manifest·R17·R18·토큰 기존 문구)는 "root" 오지칭이 없으므로 불변. 내부 변수 `base_root`/`cur_root` → `base_src`/`cur_src` **일괄 13행/15 발생**(C9 — 리뷰 N2: `:178`·`:209`는 한 행에 두 식별자. plan이 `grep -o` 발생 단위로 재고정해 부분 개명 방지).

### 2.2 `scripts/doc-coverage-allowlist.txt`

- 아티팩트 5행(현행 16–20행, "ui-curation 토큰 아티팩트" 근거 행 전부) **삭제** — 2.1-1 이후 차분에서 전소멸(C2)이라 죽은 행이다.
- 실식별자 4행(12–15행)은 **유지** — 정확한 이유(리뷰 F5): 이 4행은 **root 소스 실행의 토큰 검사에서 지금도 유효한 억제자**다(17369d32 base 차분에 4건 전부 등장 — 삭제 시 그 실행에서 `FAIL [토큰]` 4건). 단 root 소스 실행 자체는 현행 61행 ui manifest 탓에 `[move]` anchor FAIL **61건**(C11 — 리뷰 1차의 "23건"은 리뷰어의 `tail` 절단 계수 오류, 2차 자기 정정)으로 어차피 green 불가 — 즉 "역사적 root 차분 재현 시 토큰 클래스만이라도 정직하게 유지"가 목적이다. 현행 기본 실행(ui 소스)의 차분엔 미등장(inert — C6).
- **헤더 2–3행 갱신 (리뷰 R3 — 스코프 안)**: 현행 "base root에는 있었는데 현재 root에도 corpus(…)에도 없는 토큰은 FAIL" 서술은 소스 파라미터화로 이미 stale이고 소스-제외 후엔 **반대 의미**가 된다. `base:<소스>에는 있었는데 corpus(소스 제외)에 없는 토큰은 FAIL` 취지로 재작성 + 2.1-3의 신규 진단 문구도 한 줄 언급.
- 후행 공백 경고는 **유지하되 근거를 일반화**: 짝-밀림 산문 조각 서사를 지우고 "토큰 필드는 탭 앞까지 byte-exact(후행 공백 포함 — backtick 스팬은 공백으로 끝날 수 있다)"로.

### 2.3 문서 3곳 현행화

1. **`docs/dev/root-doc-maintenance.md`** (편집 5건 — 리뷰 R2·B2로 2건 추가):
   - 줄번호 인용 3곳(`check-doc-coverage.py:87`·`:114`·`:126`)을 **검사명 인용**으로 교체(사용자 채택): `rows()` 함수 · `[move]`의 "base 소스에 anchor" 검사 · `[move]`의 marker 신규성(⑤) 검사.
   - **`:29`의 verbatim FAIL 문구 인용**(`검사 ② FAIL [move] root에 anchor 잔존(미제거): …`)을 개명된 문구로 갱신 — 이 줄은 이력이 아니라 **현행 처방**이다(C10).
   - "토큰 차분 함정 2종" 중 ② 갱신 — **정확한 문장으로(리뷰 F4)**: "짝-밀림 원인 중 `{2,80}` 경계는 제거됨(doc-gate-precision, corpus 소스-자기포함 은폐도 함께 해소). 잔존 원인 = 줄 안 backtick 홀수·run-길이 불일치(현행 소스 0건)" 취지. "아티팩트는 더 이상 생기지 않는다" 같은 전칭 금지. ①(후행 공백 byte-exact)은 잔존 — 근거만 2.2와 동일하게 일반화.
   - `base:CLAUDE.md` 고정 표기는 소스 파라미터화에 맞춰 `base:<소스>`로.
   - **`:30`의 토큰 FAIL 문구 등재를 2종으로 확장 (리뷰 B2)**: 현행은 `FAIL [토큰] 소실(목적지 어디에도 없음)` 하나만 열거 — §2.1-3의 신규 문구 `소스에 산문으로 잔존 — 목적지 미확인`을 함께 등재해야 이 슬라이스가 US3(문구·문서 일치)를 스스로 위반하지 않는다.
2. **`Justfile`** doc-coverage 주석: "root CLAUDE.md 재분배 이동 검증" → 소스 파라미터화(`<base> [source]`)를 반영한 일반 서술(coverage 검사 명명은 유지).
3. **`docs/dev/ui-gotcha-narratives.md`** §R10 **본문 232행만**(헤딩은 이미 경계 명시 — §1 ⑥): "판정 로직 … byte-identical 유지" 문장에 당시-제약 한정("그 리팩터 task의 no-behavior-change 제약 — 현행 상시 제약 아님") 절을 추가. record-only, 다른 서술 불변.

### 2.4 sweep 의무 (패턴 재발 방지 규율)

2.1-4의 문구 개명·2.3-1 갱신 후, 옛 서술 잔존을 **경계 없는 전수 grep + 열거형 기대치**(리뷰 C-c — "0건"은 판정 불가)로 확인:

```bash
grep -rn "base root에 anchor\|root에 anchor 잔존" docs/ scripts/ Justfile CLAUDE.md ui/CLAUDE.md .claude/ .githooks/ .github/
grep -rn "check-doc-coverage.py:[0-9]" docs/ CLAUDE.md .claude/
grep -n "root" scripts/doc-coverage-allowlist.txt scripts/check-doc-coverage.py Justfile docs/dev/root-doc-maintenance.md
```

- **sweep 1 기대(열거형, 리뷰 n2·S1)**: 이력 plan 2파일 **6건 고정** — `docs/superpowers/plans/2026-07-30-claude-md-redistribute.md:267,269,374` + `2026-08-03-ui-claude-md-curation.md:47,104,220`(당시 plan-local 판정이 이 문자열에 의존했던 기록 — 수정 금지) + **이 spec 자신**(개명 서술·`:29` 인용·sweep 명령줄·C11 재현 명령 — spec 편집마다 개수가 변하는 자기참조라 **숫자를 spec에 박지 않고 plan이 디스패치 직전 실측으로 고정**한다; 리뷰 S1 시점 실측 4곳). **그 외 0건**(특히 `scripts/`·`Justfile`·`docs/dev/`·`.claude/`·`.githooks/`·`.github/` 0건).
- **sweep 2 기대**: 이 spec 자신 외 0건.
- **sweep 3 기대(keep-list)**: 정당한 root-특정 서술만 잔존 — `check-doc-coverage.py`의 `ROOT` 상수·R17/R18 등 root 개념 자체를 다루는 줄, `root-doc-maintenance.md`의 root 재분배 절차 서술(파일 주제가 root), Justfile의 다른 레시피. **"검사 대상을 root로 오지칭"하는 매치 0건** — plan이 변경 후 실측으로 keep-list를 줄 단위 고정한다.
- 이력 기록(`docs/build-log.md`·`docs/superpowers/plans/*`·메모리)은 당시 사실이므로 **수정 금지**. root CLAUDE.md 상태줄·roadmap-status의 연기 언급은 finish-slice가 교체하므로 이 슬라이스 sweep 대상 아님.

## 3. 비목표

- 연기 ①(ui/CLAUDE.md L108 ② 앵커 절 복원)·②(섹션 포인터 키워드 보강) — 사용자 스코프 결정으로 제외.
- `scripts/check-doc-budget.py`·`BASELINES`·R18 — 무접촉.
- ADR 신선화 pass — 별개 후보.
- 게이트 스크립트 상설 테스트 도입 — 이 레포 규약은 수동 RED/GREEN 이빨 실증(§4)이며 이번에 바꾸지 않는다.
- 마크다운 완전 파싱(홀수 backtick·run-길이 불일치 케이스) — §2.1-1 잔존 한계로 문서화만.

## 4. 검증 (이빨 재실증 — 두 상태 규율)

게이트 판정은 전부 파이프 없이 `…; echo exit=$?`로 종료코드 명시 캡처.

| # | 실증 | baseline(변경 전) 기대 | 변경 후 기대 |
|---|---|---|---|
| V1 (US1) | allowlist 아티팩트 5행 삭제 상태에서 `just doc-coverage` | **FAIL 5건**(유령 토큰 소실 — C2로 사전 실측 확인) | **OK** |
| V2 (US2) | 소스-유일 토큰 하나의 backtick을 현행 ui/CLAUDE.md에서 임시 해제 → `just doc-coverage` → 원복. 선정 절차: C4 후보(437건) 중 ⓐ **현행 소스 backtick 스팬 정확히 1회 등장**(2회 이상이면 잔존해 차분에 안 뜸) ⓑ **보조 패턴(`docs/**.md` 경로·`ADR-\d{4}`) 미매치**(매치면 backtick 해제해도 토큰 잔존 — 리뷰 R6). baseline arm은 OK만으론 무판별이므로 **은폐 증거를 기록**: 해제 상태에서 `토큰 ∈ tokens(base)−tokens(cur′)` ∧ corpus 내 유일 매치 파일 = 소스 자신임을 3줄 python으로 출력해 남긴다 | **OK**(소스 자기-매치 은폐 — 이것이 결함, 위 기록이 증거) | **FAIL 1건**(신규 진단 문구 `소스에 산문으로 잔존 — 목적지 미확인`) → 원복 후 **OK** |
| V3 (③ 단위) | 1글자 인라인코드가 낀 합성 텍스트로 `tokens()` 직접 호출 — 파일명 하이픈 탓에 `import` 불가, `importlib.util.spec_from_file_location`으로 로드(리뷰 n3; `__main__` 가드 있어 안전) | 산문 조각이 토큰으로 추출됨 | 산문 조각 미추출 + 인접 실토큰 정상 추출 |
| V4 (회귀) | T1(스크립트+allowlist) 커밋 전 `just doc-coverage` (기본 f870cfd9/ui) | — | **OK** (C2에서 사전 실측 완료) |
| V5 (US3) | ⓐ §2.4 sweep 3종 = 열거형 기대치 일치 ⓑ 갱신된 검사명 인용 3종 각각 `grep -n` 1회 도달 실증 — 문자열 고정(리뷰 n4): `def rows`(1건) · `base 소스에 anchor`(개명 후 1건) · `marker 신규성`(1건); 문서 인용 문구는 이 문자열과 byte-exact ⓒ narratives :232 본문에 당시-제약 절 존재 | — | 전부 충족 |
| V6 (T2 회귀 — 리뷰 R5) | T2(문서 3곳) 커밋 전 `just doc-coverage` — `ui-gotcha-narratives.md`는 차분 토큰 153건 중 73건의 유일 매치 파일이라 문서 편집이 게이트를 깰 수 있다 | — | **OK** |

V1·V2는 같은 조작을 변경 전/후 **두 상태 모두**에서 돌려 "결함이 실재했고, 수정이 그 결함을 제거했다"를 쌍으로 실증한다(고의 회귀→RED→원복→GREEN의 게이트판).

## 5. Claims ledger (사실 주장 ↔ 생성 명령 — plan 디스패치 전 일괄 재실행)

| # | 주장 | 명령 |
|---|---|---|
| C1 | 현재 게이트 GREEN (manifest 61행·R17 8섹션) | `just doc-coverage; echo exit=$?` → `OK … exit=0` |
| C2 | 짝-보존+소스-제외 적용 시 base f870cfd9 대비 아티팩트 스팬 18건 전소멸(allowlist 5건 포함)·잔존 FAIL 후보 0 → allowlist 5행 삭제 가능. 현행 차분 163건 → 짝-보존판 153건(신규 정상 포획 8건 — 전부 corpus 매치) | 재현 로직 §5.1 — `FAIL 후보` 출력 0건 |
| C3 | 이중 backtick 인라인 사용 0건(cur·base ui/CLAUDE.md), root 4건은 전부 ``` 펜스 줄 | `grep -c '\`\`' ui/CLAUDE.md CLAUDE.md; git show f870cfd9:ui/CLAUDE.md \| grep -c '\`\`'` → 0·4·0 + 펜스 여부 육안(리뷰 재확인: 29·46·64·80행 전부 펜스) |
| C4 | US2 이빨용 소스-유일 토큰 실존(437건) | §5.1 동형 로직으로 `toks(base)∩toks(cur)` 중 corpus(소스 제외) 무매치 나열 → 437 |
| C5 | 문서 줄번호 인용 3곳 stale (`:87/:114/:126` → 실제 88/125/137) | `grep -n "def rows\|if anchor not in base_root\|elif int(gain) > 0 and m in base_dest" scripts/check-doc-coverage.py` |
| C6 | allowlist 실식별자 4행은 현행 기본 실행(ui 소스)의 차분에 미등장(inert) | §5.1 출력에서 해당 4 토큰 부재 확인 |
| C7 | 전체 토큰 집합 변화: base ui +42/−65 · 현행 ui +28/−48 · root(17369d32) +8/−17 · 현행 root +5/−8 (짝-보존판 vs 현행) | 검증 스크립트(§5.1 동형 — `fix_tok(t)−cur_tok(t)` / 역방향, 4개 텍스트) — 리뷰어 실측과 orchestrator 재실행 일치 |
| C8 | 잔존 한계 반례 2종 재현: 홀수 backtick 줄은 양 정규식 공통 산문 추출(`' 대신 '`), run-길이 불일치는 신 정규식 국소 오추출 | 동 스크립트 — 합성 텍스트 2건 출력 |
| C9 | `base_root`/`cur_root` **13행/15 발생**(`:178`·`:209`는 행당 2 식별자) | `grep -o "base_root\|cur_root" scripts/check-doc-coverage.py \| wc -l` → 15 (행 수는 `grep -n … \| wc -l` → 13) |
| C10 | `root-doc-maintenance.md:29`가 개명 대상 FAIL 문구를 현행 처방으로 verbatim 인용 | `sed -n '29p' docs/dev/root-doc-maintenance.md` |
| C11 | root 소스 실행은 현행 ui manifest로 green 불가 — `[move]` anchor FAIL **61건**(리뷰 1차 "23건"은 `tail` 절단 계수 오류 — 2차 자기 정정, 재발 방지 교훈: 계수는 `grep -c`로) | `python3 scripts/check-doc-coverage.py 17369d32 CLAUDE.md \| grep -c "FAIL \[move\] base root에 anchor 없음"` → 61 |
| C12 | §2.1-3을 독립 검사로 오구현 시 기본 실행에서 거짓 FAIL 28건(차분 153 중 `cur_src` raw substring ∧ corpus(소스 제외) 실재) | §5.1 동형 로직에 `t in cur ∧ t in corpus_wo` 계수 추가 → 28 |

### 5.1 C2/C4 재현 로직 (plan이 검증 스크립트로 옮겨 쓸 정본)

base=`f870cfd9`, src=`ui/CLAUDE.md`. ① 현행 `tokens()`와 짝-보존판(`` (`+)([^`\n]*?)\1 `` 후 2–80 채택)을 각각 base/cur에 적용해 차분 계산 ② 각 차분 토큰을 allowlist·corpus(소스 포함)·corpus(소스 제외)에 대조 분류 ③ 짝-보존판 차분 중 corpus(소스 제외) 무매치 = FAIL 후보. 2026-08-07 실측: 현행 차분 163건 → 짝-보존판 153건(아티팩트 18건 소멸·정상 포획 신규 8건 — 전부 corpus 매치), FAIL 후보 0건.

## 6. 파이프라인 메모

- production 0-diff → **라이브 검증 생략 근거 성립**(US 증명은 §4 게이트 실측이 대신 — ui-claude-md-curation 선례). 보안 게이트는 finish-slice §0 grep이 결정(스크립트·docs만이라 무매치 예상이나 grep이 지배).
- pre-commit: cargo-영향·`ui/`(non-.md) staged 없음 → fast-pass(`.githooks/pre-commit`의 `CARGO_PATHS`에 `scripts/`·`Justfile`·`docs/` 없음 — 리뷰 확인). tdd-guard·spec-review-guard 표면 무접촉 — **리뷰 루프는 순전히 규율로 지킨다**(리뷰어 지적: 이 슬라이스엔 기계 강제가 없다).
- **T1 내 커밋 순서**: 정규식 fix → allowlist 삭제 순이면 어느 중간 시점도 green; 역순이면 중간이 FAIL 5건 red(리뷰 scope assessment).
- plan task 구성 제안: T1 스크립트+allowlist+이빨 V1~V4, T2 문서 3곳+sweep(§2.4)+V5·V6. 각 독립 green 커밋.
