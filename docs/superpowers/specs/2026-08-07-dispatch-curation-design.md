# dispatch 섹션 불릿 큐레이션 + 게이트 연기 회수 — 설계

- 날짜: 2026-08-07 · 유형: internal-polish · production 0-diff(docs + 게이트 데이터/기본값) · ADR 불필요(기존 게이트·규약의 적용)
- 대상 파일: `CLAUDE.md`(root) · `ui/CLAUDE.md` · `docs/dev/subagent-dispatch.md` · `scripts/doc-move-manifest.tsv`(데이터 교체) · `Justfile`(doc-coverage 기본값 repoint) · (본 spec/plan)
- 검증은 전부 게이트·grep 실측(doc-gate-precision 선례) — 라이브 검증 생략 예정(production 0-diff, 근거는 build-log에 기록)

## 사용자 스토리 (US)

- **US1**: 개발자-도구가 새 dispatch 함정을 배워 root CLAUDE.md dispatch 섹션에 규칙 한 줄을 추가하려 할 때 — 지금은 섹션이 캡 초과(6,352 B > 6,144 B, `doc-budget` WARN 실발화 중, C1)라 추가가 곧 게이트 위반이고 매번 뭘 줄일지 즉석 판단해야 한다 — 성공하면 `just doc-budget` WARN 0 + 섹션 총합 ≤5,644 B로, 향후 새 규칙 2개(각 ≤250 B)를 큐레이션 없이 받을 수 있다.
- **US2**: 개발자-도구가 압축된 불릿만 읽고 subagent 슬라이스를 운전할 때 — 압축·병합이 규칙의 지시력을 깎았다면 그 손실은 함정 재발로만 드러난다 — 성공하면 기존 29불릿의 규칙 항목 전수가 keep-list(부록 A) 대조로 생존을 증명하고, 기계 게이트(§6 분기 A: repoint된 `just doc-coverage` green / 분기 B: 일회성 판정 `FAIL [토큰]` 0건)가 "root에서 사라진 토큰의 corpus 실재(+ 분기 A에선 이관 앵커의 목적지 실재)"를 증명하며, 압축으로 밀려난 서사 조각은 정본 `docs/dev/subagent-dispatch.md`에 실재한다.
- **US3**: 개발자-도구가 ui/CLAUDE.md:108 사이징 헬퍼 게이트 패턴을 따라 워커-수 앵커 코드를 만질 때 — 지금은 ② count-기반 앵커 절이 narratives에만 있어 "왜 p50이 아니라 count 기반인가"(p50 앵커는 localhost sub-ms run에서 죽는다)를 자동 로드 문서에서 못 본다 — 성공하면 :108 불릿 안에서 ② 절을 직접 읽고, 잔존 표지는 "(③은 narratives)"로 정확해진다.
- **US4**: 개발자-도구가 증상 키워드로 ui 함정 서사를 찾을 때 — 현 포인터 키워드(섹션당 3~7개)가 narratives `###` 항목 61개(승인 시 65로 제시 — C3 실측 61로 정정)의 일부만 표집해, 커버 안 된 함정은 정본의 존재를 모른 채 지나친다 — 성공하면 4개 미러 섹션의 모든 `###` 항목이 포인터 키워드 최소 1개에 귀속된다(키워드 1개가 인접 항목 여럿을 묶는 건 허용, 부록 B 매핑표 대조로 증명).
- **US5**: 개발자-도구가 dispatch 서사 정본을 읽을 때 — 같은 규칙의 장·단 2벌(2단계 리뷰 :15↔:16 · 리뷰-수정 루프 :21+:22↔:23, C5)이 병존해 어느 쪽이 현행인지 대조해야 한다 — 성공하면 각 규칙이 장본 1벌만 남는다(단본 고유 토큰의 장본 잔존을 확인한 뒤 삭제 — 정보 손실 0, §5 전용 검사로 기계 증명).

## 1. 배경·현황 (실측)

`just doc-budget`이 WARN 1건을 실발화 중(C1): `Subagent dispatch 노하우` 섹션 총합 6,352 B > 캡 6,144 B(불릿 29개, 불릿당 캡 250 B에 최대 불릿 250 B로 밀착). 섹션 구성 실측(C2): 헤딩 줄 31 B + 비불릿 줄(프리앰블 blockquote·그룹 헤더 4·공백) 424 B + 불릿 29개 5,897 B. 240–250 B 구간 불릿이 13개로 살이 여기 몰려 있다. 캡 설계 의도는 "서사는 정본에, root엔 규칙 한 줄"(check-doc-budget.py:38)인데, 누적된 불릿들이 슬라이스 태그·예시 절 등 서사 조각을 들고 있다.

별도로 ui-claude-md-curation(2026-08-03)의 연기 ①②가 미회수 상태다: ① ui/CLAUDE.md:108의 ② count-기반 앵커 절이 narratives로 빠져 표지 `(②·③은 narratives)`만 남음(C7) — 102,400 B 예산은 그 슬라이스의 DoD였고 파일 유지 규칙은 ~120 KB라 merge 후 복원 자유. ② 4개 미러 섹션 포인터의 키워드가 절충(3~7개/섹션)이라 narratives `###` 61항목의 소수만 표집(C3·C4: 오프라인 28 / 빌드·타입 14 / 폼·입력 14 / 다단계 ramp 5).

부수 발견(C5): 서사 정본 `docs/dev/subagent-dispatch.md` 안에 root 압축본과 중복인 단본 불릿 2개(:16, :23)가 장본(:15, :21+:22)과 병존한다 — claude-md-redistribute 때 root 요약본이 정본에도 함께 실린 흔적.

**게이트 기계의 현황 (검증 설계의 전제, C12·C13·C14)**: `scripts/doc-move-manifest.tsv`는 소스 컬럼 없는 전역 단일 파일(현행 61행 전부 ui-claude-md-curation의 ui-anchored move 행)이고, `check-doc-coverage.py`는 **모든 행**을 전달된 (base, src) 쌍에 대조한다(:117 이하). 따라서 어느 시점이든 manifest와 정합인 (base, src) 쌍은 최대 1개 — 현행 정합 쌍은 Justfile 기본 `f870cfd9 ui/CLAUDE.md`(exit 0 실측, C12)뿐이고, 다른 쌍(예: `fa94ed6a CLAUDE.md`)은 `FAIL [move]` 벽으로 exit 1(C13 실측). 이 구조는 설계다: **게이트는 "최신 큐레이션"의 이동 무결성을 영속 추적**하고, 각 큐레이션 슬라이스가 manifest를 교체하며 기본 쌍을 repoint해 왔다(claude-md-redistribute가 root 행으로 생성 → ui-claude-md-curation이 ui 행으로 교체 + `Justfile` 기본 flip). corpus는 검사 대상 소스 자신을 제외하며 `docs/dev/*.md`를 포함한다(C14).

## 2. Part A — dispatch 섹션 큐레이션 (US1·US2)

**목표**: 섹션 총합(헤딩 줄 포함, 스크립트 산정과 동일 경계) ≤ **5,644 B** — 캡 6,144 B에서 새 규칙 2개(각 ≤250 B) 여유를 뺀 값. 최소 감축 708 B.

**감축 수단 3종 (우선순위순)**:

1. **서사 조각 압축** — 240–250 B 불릿 13개(C2)가 주 대상. 떼는 것: 슬라이스 출처 태그(`(E1; …)` 류), 예시 절, 정본·메모리에 이미 있는 부연. 남기는 것: 규칙의 지시(what to do)와 위반 신호(why it bites) 한 마디. 규칙 자체를 정본-only로 강등하는 것은 **금지** — 불릿의 존재 이유가 상시 로드다.
2. **겹침 쌍 압축 (재배분 실측 기각)** — L137(모델 라우팅, 248 B)·L138(2단계 리뷰, 250 B)이 모델 라우팅 내용을 나눠 들고 있다. 초판이 계획한 "라우팅 전체를 한 불릿으로" 재배분은 **plan 저작 시 실측 296 B > 캡 250 B로 불가**(C17) — 대신 현행 배분(라우팅 코어 / 2단계+정의된 리뷰어 inherit·env 금지)을 유지: 라우팅 불릿은 문면 유지(+마침표 1 B, 249 B), 2단계 불릿만 압축(250→205 B) — 합 454 B, 원본 498 B 대비 −44 B. 두 규칙 모두 생존(부록 A R16·R17). 불릿 수는 29→29라 R17(불릿 비감소) 자명 통과 — **manifest merge 행 불사용**.
3. **프리앰블 압축** — 상단 blockquote를 짧게. 단 `[docs/dev/subagent-dispatch.md](…)` 링크(L1 검사 대상)와 "규칙 한 줄은 여기, 서사는 그 파일에" 규약 문장은 유지.

**불변 제약**: `## Subagent dispatch 노하우` 헤딩 문자열·`- ` 불릿 마커·4그룹(`**brief/plan 작성**`/`**디스패치**`/`**리뷰**`/`**검증·재개 …**`) 구조 유지(게이트 검사 앵커), 각 불릿 ≤250 B, 압축으로 떼는 서사 조각 중 정본에 없는 사실은 **정본에 선-추가 후** root에서 제거(이동이지 삭제 아님 — 이 이동들이 §6 신규 manifest의 행이 된다).

**no-forget 오라클**: 부록 A의 규칙 keep-list — 현행 29불릿의 규칙 항목 전수와 큐레이션 후 목적지. 기계 검증은 §6의 분기별 게이트(분기 A: repoint된 `just doc-coverage` / 분기 B: 일회성 토큰 판정 — §7).

**재협상 밸브**: 부록 A 전 규칙을 보존하는 정직한 압축으로 5,644 B에 도달 불가가 실측되면(규칙 이빨을 깎아야만 도달) — 조작하지 말고 STOP, 도달치 실측과 함께 사용자에게 목표 재협상을 요청(ui-claude-md-curation `f496ccf2` 선례).

**작성-시점 검증 불가 표지**: 목표 배분(병합 ~150 B·프리앰블 ~80 B·불릿당 ~40 B)은 저작 시점 추정 — 구현 중 실측으로 확정하고, plan 수치와 불일치 시 STOP→재현→plan 정정(doc-gate-precision 2회 실작동 경로).

## 3. Part B — ② count-기반 앵커 절 복원 (US3)

`ui/CLAUDE.md:108` 불릿의 `WorkerSizingHelper` 대목, 표지 `단 세 가지가 다르다(②·③은 narratives)`를 다음으로 갱신:

- 표지: `단 세 가지가 다르다(③은 narratives)` (−5 B, C11)
- ② 절 인라인 삽입 — 위치: "세 가지" 중 무번호 첫 항목(`**단일 공유 disclosure 렌더**(…)` 절, :108에 리터럴 `①` 없음) 뒤, `cross-field 비차단 경고` 문장 앞. 삽입문은 아래 블록쿼트를 **byte-exact**로(191 B 실측, C11) — 이 문안은 narratives :284 원문의 **압축 파생본**이며 원문 verbatim 복사가 아니다(원문을 복사하면 바이트 수치가 어긋나 불필요한 STOP을 유발). 구분자(앞뒤 공백 등)로 ±수 B는 구현 실측로 확정:

> ② **count 기반 앵커**(`usePriorOpenRunWorkerAnchor`의 peak=`peakThroughput(windows)`=초별 Σcount 최대 — p50 앵커와 달리 localhost sub-ms run에서도 `peak>0`이라 생존)

- narratives :284의 원문은 **그대로 둔다**(root=규칙·정본=서사 병존이 기본형). ③(env/measure 경로 없음)은 복원하지 않음 — 부재 노트라 상시 지시가 아니다.

## 4. Part C — 포인터 키워드 전수 귀속 (US4)

4개 미러 섹션 포인터(`ui/CLAUDE.md` :13/:63/:98/:142, 현 241/258/315/322 B, C8)의 `(키워드: …)` 목록을 부록 B 매핑표대로 보강해, narratives `###` 61항목 전부가 최소 1 키워드에 귀속되게 한다. 신규 키워드 36개(오프라인 +17 · 빌드·타입 +9 · 폼·입력 +10 · 다단계 ramp +0), 예상 증가 ~1 KB — ui 래칫(기준 102,395 B, 허용 +10,240 B, C9)·절대 임계(122,880 B) 대비 안전. Part B(+186 B ± 구분자)와 합산해도 래칫 내.

키워드 문구는 grep-우호적으로(정본 `###` 제목의 식별자·고유 표현을 채용), 형식은 기존 ` (키워드: A · B · C)` 유지. ui/CLAUDE.md에 대한 이동·삭제는 없음(순수 가산)이라 coverage 관점 무해 — ui 쪽 검증은 래칫 표시와 부록 B 전수 대조·grep 실측으로 한다(§7).

## 5. Part D — 정본 중복 정리 (US5)

`docs/dev/subagent-dispatch.md`에서 단본 2개 삭제: :16(2단계 리뷰 단본 — 장본 :15 잔존) · :23(리뷰-수정 루프 단본 — 장본 :21+:22 잔존). 삭제 전 검사 2종:

1. **기계(전용 검사)**: 단본 2개의 base 원문에서 인라인 코드 토큰을 추출해, 각 토큰이 삭제 후 파일에 잔존하는지 전수 grep — **전 토큰이 잔존해야 통과, 미잔존 토큰이 1개라도 발견되면 그 토큰을 지목하며 실패**. 명령 형태는 plan이 고정(`git show <base>:docs/dev/subagent-dispatch.md`에서 해당 줄 추출 → backtick 스팬 나열 → `grep -F` 루프). **주의 — coverage 게이트 호출로 대체 불가**: 이 파일을 src로 한 `check-doc-coverage.py` 호출은 ⓐ 전역 manifest 행이 (base, src)에 안 맞아 `FAIL [move]` 벽(C13), ⓑ 토큰 차분이 `tokens(base_src) − tokens(cur_src)`라 장본에 살아남은 토큰은 애초에 '사라진 토큰'으로 안 잡혀(차분 공집합) 아무것도 증명하지 않는다 — 게이트가 green이어도 그건 "장본 잔존" 증명이 아니다. 초판 spec의 이 호출 서술은 리뷰 F1/F3으로 폐기.
2. **육안**: 단본에만 있는 *사실*이 없는지 대조(예: :16의 "역손해"는 :15의 "always-Opus보다 비싸짐"과 동치 — 사실 손실 0). 단본 고유 사실이 있으면 장본에 선-병합 후 삭제.

추가로 파일 전체를 중복 쌍 sweep(`grep -n "^- "` 전 불릿 첫 절 육안 대조) — C5 나열 기준 추가 쌍 없음이 예상이나 구현 시 재확인. root 쪽 대응 불릿(L138·L140)은 Part A에서 압축되므로 정본 장본이 유일 서사 소스로 남는다. 이 파일의 삭제 토큰이 root 검사(src=CLAUDE.md)의 corpus에서 빠지는 부수효과는 무해 — 장본이 같은 파일에 남아 corpus 총량 기준 토큰은 잔존한다.

## 6. manifest 워크스트림 (Part A의 게이트 배선 — 리뷰 R1·F6 해소)

**커밋 순서 제약 (F6 해소의 핵심)**: Part B/C(ui)·Part D(정본 단본 삭제)를 **Part A보다 먼저 커밋**하고, coverage의 base는 분기점이 아니라 **Part A 직전 커밋**으로 잡는다(sha는 구현 중 확정, plan에 기록). 근거: ④ 누적-gain 검사는 `dest 파일 순증 ≥ Σ 선언 gain`(coverage:173–177, C15)인데 Part D가 같은 dest(`subagent-dispatch.md`)에서 1,143 B(:16 689 + :23 454, C15 실측)를 삭제한다 — base를 분기점으로 잡으면 `순증 = Part A 추가 − 1,143 < Σ`로 구조적 FAIL(리뷰 F6). base를 Part D 이후로 잡으면 base_dest에 삭제가 이미 반영돼 상호작용이 소멸하고, dest 변화 = Part A 선-추가뿐이라 정직한 gain(행별 추가분 실측) 선언으로 ④가 구성상 성립한다. **선례 정합**: ui-claude-md-curation의 BASE `f870cfd9`도 분기점이 아니라 "큐레이션 직전 커밋"(spec 커밋 `f58445fa` 직전, C16)이었다 — 그 슬라이스는 dest 신설이라 상호작용이 없었을 뿐, "base = 큐레이션 직전 상태" 규약은 동일.

이관 실측 건수에 따라 **사전 결정된 2분기** (판정·결과를 build-log에 기록):

**분기 A — 이관 ≥1건**: 선례(ui-claude-md-curation `fdfb4529`)를 따라 manifest 교체 + Justfile 기본 쌍 repoint.

1. `scripts/doc-move-manifest.tsv`: 현행 61행(ui-anchored)을 **이 슬라이스의 root 이관 행으로 교체** — Part A에서 "정본에 선-추가 후 root에서 제거"된 서사 조각 각각이 `move` 행(anchor=root base에서 제거된 문구, dest=`docs/dev/subagent-dispatch.md`, marker=정본에 신규 추가된 문구, gain=행별 추가분 실측). ⑤ marker-신규성은 base가 Part A 직전이므로 선-추가 문구가 base_dest에 없음이 보장된다. merge 행은 불사용(§2 수단 2 — 29→29).
2. `Justfile`: `doc-coverage BASE FILE` 기본값을 `f870cfd9 ui/CLAUDE.md` → **`<Part A 직전 커밋 sha> CLAUDE.md`**로 repoint(rebase 시 sha 재산출·재확정). 이후 `just doc-coverage`(무인자)가 이 큐레이션의 이동 무결성을 영속 재검증하고, finish-slice §5가 도는 기본 게이트와 정합.
3. **구 ui 쌍의 운명**: repoint 후 `check-doc-coverage.py f870cfd9 ui/CLAUDE.md` 호출은 새 manifest와 불일치라 더 이상 green이 아니다 — 수용. ui 큐레이션의 이동 무결성은 그 슬라이스 머지 시점에 증명 완료됐고, 게이트는 설계상 "최신 큐레이션"을 추적한다(§1 게이트 기계 현황 — redistribute→ui 교체 때와 동일한 세대교체).

**분기 B — 이관 0건 실측** (리뷰 F6 평가상 유력: 29불릿 전수가 정본 요약본으로 작성돼 탈락 조각 대부분이 이미 정본에 실재 — 리뷰어가 R2~R29의 정본 대응 절 실재를 대조 확인): 기록할 이동이 없으므로 manifest·Justfile **무변경**(ui 쌍 그대로 — 기존 게이트 현상 유지, `MANIFEST_MIN=1` 충돌 없음). US2의 기계 증명은 **일회성 판정 실행**으로 대체: `python3 scripts/check-doc-coverage.py <Part A 직전 커밋> CLAUDE.md`를 1회 실행하고 출력에서 **`FAIL [토큰]` 0건**을 판정(토큰 차분 arm — root에서 사라진 토큰의 corpus 실재 증명은 이 arm이 전담). `FAIL [move]`는 타-세대(ui) manifest 잔존이 만드는 알려진 잡음이라 판정에서 제외 — 이 실행은 영속 게이트가 아니라 슬라이스 검증이며, 판정 명령(grep 포함)·기대 출력은 plan이 고정하고 결과는 build-log에 기록.

**공통**:

- **STOP 밸브**: 분기 판정이 애매하거나(조각이 정본에 부분 실재 등) 분기 A에서 ④/⑤가 예상 밖 FAIL이면 — 끼워맞추지 말고 STOP→기계 재현→plan 정정(작성-시점 검증 불가 부류).
- **기각 대안**: manifest에 소스 컬럼을 추가해 다세대 병존(리뷰 제안 ⓐ) — 게이트 스크립트·스키마 수정으로 스코프가 커지고, 과거 세대 재검증의 실익이 낮아(머지 시점 증명 완료) 선례(교체)를 따른다. 필요해지면 별도 슬라이스. Part D 후속-세대 분리(리뷰 F6 제안 ⓘ)도 기각 — 커밋 순서 제약이 같은 산술을 스코프 분할 없이 성립시킨다.

## 7. 검증 (두-상태 — baseline 전 행 실측 완료) · 파이프라인 속성

> 초판 검증표는 baseline 2행을 실행 없이 "무diff 자명 OK"로 적었다가 리뷰 F1(CRITICAL)에 적발됐다 — 실제로는 manifest 전역 대조 때문에 exit 1(C13). 아래 표는 **전 행을 실행한 실측**이며, 폐기된 호출은 표 아래에 명시한다.

| 게이트 | baseline(현재 — 실행 실측) | 변경 후 기대 |
|---|---|---|
| `just doc-budget` | WARN 1: §dispatch 6,352 B > 6,144 B (C1) | WARN 0 · §dispatch ≤5,644 B · ui 래칫 `+1.2 KB 내외` 표시(WARN 아님, 허용 +10,240 B) |
| `just doc-coverage` (기본 쌍) | 현행 기본 `f870cfd9 ui/CLAUDE.md` exit 0 (C12) | 분기 A: repoint된 기본 `<Part A 직전 커밋> CLAUDE.md` exit 0 — Part A 이동(manifest)+토큰 차분+R17(29→29)+R18(baseline 무변경) / 분기 B: 현행 기본 그대로 exit 0(무변경) + 일회성 판정 `check-doc-coverage.py <Part A 직전 커밋> CLAUDE.md`에서 `FAIL [토큰]` 0건(§6 분기 B) |
| Part D 전용 검사 (§5-1) | N/A(삭제 전 — 검사 대상 없음) | 단본 2개 토큰 전수 장본-잔존, 실패 0 |
| keep-list·매핑표 전수 대조 | 부록 A 29행↔현행 29불릿 1:1(리뷰 검증 완료) · 부록 B 61항목 전수(동일) | 구현 후 잔존 위치 열 채움(`grep -n`으로만) → 리뷰어 재대조 |

**폐기된 호출(초판 §6에서 삭제)**: `check-doc-coverage.py fa94ed6a CLAUDE.md` — base=분기점 호출은 현행 manifest에서 exit 1(C13)이고, F6 해소 후 base 규약은 "Part A 직전 커밋"이라 분기점-base 호출 자체가 폐기(분기 A에선 repoint된 기본 쌍이, 분기 B에선 같은 base의 일회성 토큰 판정이 대체) · `check-doc-coverage.py <base> docs/dev/subagent-dispatch.md`(어느 상태에서도 무의미 — §5-1 주의 참조).

- 커밋: docs+스크립트 데이터·Justfile이라 pre-commit fast-path(cargo-영향 경로 아님). 보안 게이트는 finish-slice §0 grep이 지배(무매치=N/A 예상이나 예측으로 스킵 안 함). migration·proto·엔진·UI 코드 0-diff.
- 슬라이스 분기점은 `git merge-base master HEAD` = `fa94ed6a`(C10 — §1 실측들의 기준). coverage base는 별개로 **Part A 직전 커밋**(§6)이며, master 전진·rebase 시 두 sha 모두 재산출해 Justfile 기본값(분기 A)과 plan 수치를 갱신.

## 8. 비목표

- 규칙 신설·의미 개정 없음 — 문면 압축·재배분만(병합 포함). 규칙의 지시 내용이 바뀌면 스코프 밖.
- root의 다른 섹션(상태줄·알아둘 결정들·로컬 dev 함정 등) 무변경. narratives(`ui-gotcha-narratives.md`) 본문 무변경(ui 쪽은 포인터 줄 4개 + :108 불릿만). `subagent-dispatch.md`는 단본 2개 삭제 + Part A 선-추가 서사 조각 외 무변경.
- **게이트 스크립트 2종(`check-doc-budget.py`·`check-doc-coverage.py`) 무변경** — 캡 값·스키마 조정 없음. 단 `scripts/doc-move-manifest.tsv`(데이터)와 `Justfile` doc-coverage 기본값은 §6의 변경 대상(스크립트 코드와 구분).
- ui/CLAUDE.md의 다른 불릿·섹션 무변경.

## 부록 A — 규칙 keep-list (29불릿 → 규칙 항목 전수)

> 각 행 = 반드시 생존해야 하는 규칙. "처치"는 저작 시점 계획 — 구현 중 실측으로 확정(불일치=STOP→plan 정정). 큐레이션 후 위치 열은 구현 시 `grep -n`으로 채운다. (리뷰 1R에서 29행↔29불릿 1:1·바이트 실측 전건 일치 검증 완료.)

| R# | 현행 | 규칙(생존 필수 요지) | 처치 |
|---|---|---|---|
| R1 | L118 | plan task 헤딩은 숫자 `Task N`(`task-brief` 문자 라벨 exit 3) | 유지(106 B) |
| R2 | L119 | task-밖 공유 정본은 별도 파일 1회 추출, brief와 함께 디스패치("byte-exact") | 소폭 압축 |
| R3 | L120 | US 블록 1회 추출·매 brief 첨부(원천=spec, 헤딩~다음 동레벨-이상; 규약 파일) | 압축 |
| R4 | L121 | `ui/src` 건드리는 task는 brief에 UI 테스트 스텝(tdd-guard) | 유지(131 B) |
| R5 | L122 | plan 인라인 Rust는 clippy-clean(`if let`) | 유지(106 B) |
| R6 | L123 | plan-mandated 테스트도 공허 가능 — RED→GREEN 실증 명시, 결함은 finding | 압축 |
| R7 | L124 | plan 사실 주장도 가설 — 기계 재현 가능한 건 디스패치 전 orchestrator 직접 | 압축 |
| R8 | L125 | plan은 훅에도 실행 가능해야 — tdd-guard 순서 시뮬레이션(① 첫 스텝 차단 ② `it.todo` 언블록·제거 독립 스텝) | 압축 |
| R9 | L126 | 줄번호는 `grep -n`으로만(오프바이원=finding) | 압축 |
| R10 | L127 | 사후-diff 검산·자기-삽입 keep-list는 저작 시점 검증 불가 — 실측 표지·STOP·`^[+-]` 필터 | 압축 |
| R11 | L130 | 워크트리 subagent prompt 첫 줄 `cd <워크트리 절대경로>` | 압축 |
| R12 | L131 | 리포트 경로 `.superpowers/sdd/` + 루트 `.md`·`git add` 금지 | 유지(114 B) |
| R13 | L132 | implementer commit=단일 FOREGROUND(600000ms), background+poll 금지 / orchestrator 커밋은 background, 두 커밋 동시 금지 | 압축 |
| R14 | L133 | 무거운 env-setup·외부 바이너리는 디스패치 전 pre-warm·실측(외부 바이너리 행동은 리뷰어가 못 잡음) | 압축 |
| R15 | L134 | 1M 부모에서 `model:` 생략=즉사+가짜 completed — 항상 명시 / notification 0-tell이면 미실행, 메인 폴백 | 압축 |
| R16 | L137 | 모델 라우팅: 기본 Sonnet · path-gate opus · `escalate` 재패스 · 승격=디스패처(자기승격 불가) | 유지(249 B — 문면 동일+마침표, C17: 통합안 296 B 캡 초과 기각) |
| R17 | L138 | task별 2단계 review 둘 다 APPROVED / 정의된 3 리뷰어 `model: inherit` 유지·`CLAUDE_CODE_SUBAGENT_MODEL` 금지 | 압축(205 B — 배분 유지, 동일 C17) |
| R18 | L139 | 리뷰는 read-only만(`checkout`/`switch`/`stash` 금지 — attached HEAD 파괴) | 유지(128 B) |
| R19 | L140 | 리뷰-수정 루프: read-only는 같은 subagent resume, 코드-fix는 fresh / clean APPROVE + 유한 valve(5회 초과=사용자 질문) | 압축 |
| R20 | L141 | "later fold 가능"이어도 spec invariant 위반은 슬라이스 내 fix | 유지(137 B) |
| R21 | L142 | fold-in 결정은 대상 task brief에 명시 + 그 task 생존 보장 확인 | 압축 |
| R22 | L143 | 리뷰 finding 사실 주장도 가설 — fold-in 전 기계 검증, 틀린 근거 주석 통째 삭제 | 압축 |
| R23 | L144 | 최종 whole-feature 리뷰=`handicap-reviewer` / 단일-task는 병합 1회 / BASE=디스패치 직전 커밋(`HEAD~1` 금지) | 압축 |
| R24 | L145 | 미룬 항목은 주석만으론 유실 — 후속 scoping 때 deferral grep | 압축 |
| R25 | L148 | 새 워크트리엔 deps 없음 — 디스패치 전 `pnpm install`+`cargo build` baseline | 유지(136 B) |
| R26 | L149 | mid-task truncate — report 불신, git로 확인·잔여 완료 / `<new-diagnostics>` STALE — 독립 빌드만 신뢰 | 압축 |
| R27 | L150 | orchestrator의 "검증했다"도 가설 — brief엔 확인한 명령을 | 압축 |
| R28 | L151 | 전수 grep 게이트는 orchestrator 직접 재실행 / zsh word-split·two-dot 금지 | 압축 |
| R29 | L152 | 재개는 git 커밋이 진실의 원천(`git log <base>..HEAD` vs plan 체크박스) | 압축 |

## 부록 B — 키워드→`###` 항목 매핑표 (61항목 전수)

> 왼쪽 = narratives `###` 항목(줄번호는 C4 시점 실측 — 구현 시 재확인), 오른쪽 = 귀속 키워드(★=신규). 포인터 줄 최종 문면은 구현 시 이 표에서 조립. (리뷰 1R에서 61항목·줄번호 전건 실측 일치 검증 완료.)

**§오프라인(CSP) · 테스트 인프라** (28항목, 기존 7 + 신규 17 = 24 키워드):

| 항목(:줄) | 키워드 |
|---|---|
| :10 numRuns 40 | `numRuns` 40 |
| :14 clipboard defineProperty | clipboard defineProperty |
| :18 TextDecoder BOM | BOM desync |
| :24 undici brand-check | undici brand-check |
| :28 HAR 후행공백 trim | ★HAR 후행공백 trim |
| :36 fan-out memo | fan-out memo 31.5s |
| :40 commit-on-blur | commit-on-blur 이전 이디엄 |
| :44 user.type 디스크립터 | ★`user.type` 디스크립터 |
| :48 fetchMock 큐 | ★one-shot `fetchMock` 큐 |
| :52 aria-label ko.ts | ★aria-label도 `ko.ts` |
| :56 grep-0 vs 음수 단언 | ★grep-0 음수 단언 |
| :62 no-op MutationObserver | ★no-op `MutationObserver` |
| :66 부분모킹·dispatchEvent | ★부분모킹 `dispatchEvent` |
| :70 리뷰 subagent HMR | ★리뷰어 HMR 리셋 |
| :74 master 대조 실험 | ★master 대조 선재결함 |
| :78 같은 값 ko 키 2개 | ★동일 문구 `getAllByText` |
| :84 toHaveTextContent 부분문자열 | ★`toHaveTextContent` 부분문자열 |
| :90 WCAG 2.5.3 | ★WCAG 2.5.3·가시라벨⊄aria |
| :94/:100/:104 CI flake 1·2·3차 | CI flake 1·2·3차 |
| :108 ValidityBadge 규칙 스코프 | ★`ValidityBadge` 규칙 스코프 |
| :112 자기참조 단언 | ★자기참조 단언 |
| :116 가시 라벨 ⊄ aria | ★WCAG 2.5.3·가시라벨⊄aria (:90과 공유) |
| :120 Modal 포커스 유실 | ★Modal 포커스 유실·비대화형 목록 |
| :124 비대화형 overflow-auto | ★Modal 포커스 유실·비대화형 목록 (:120과 공유) |
| :128 tdd-guard JSX 주석 | ★tdd-guard JSX 주석 |
| :132 Field grep 오염 | ★`Field` grep 오염 |

**§빌드·타입 게이트** (14항목, 기존 3 + 신규 9 = 12 키워드):

| 항목(:줄) | 키워드 |
|---|---|
| :138 fc.constantFrom | `fc.constantFrom` widening |
| :142 empty-path | `unrecognized_keys` empty-path |
| :146 hoisted function | ★hoisted `function` narrowing |
| :150 targeted green | ★targeted≠full green |
| :154 동일 라벨 다중매치 | ★동일 라벨 다중매치·필터 칩 기각 |
| :158 필터 칩 기각 | ★동일 라벨 다중매치·필터 칩 기각 (:154와 공유) |
| :162 미러 컴포넌트 스텝명 | ★미러 컴포넌트 스텝명 복제 |
| :166 getByText 직계 | ★`getByText` 직계 노드 |
| :170 suite-wide flake | suite-wide flake(`194cfa3`) |
| :178 lint 잠복 경고 | ★lint 잠복 경고 |
| :182 top-level .default() | ★top-level `.default()` 누출 |
| :186 ${env} 캐스트 반전 | ★`${env}` 캐스트 반전·0029 확장 |
| :190 0029 확장 | ★`${env}` 캐스트 반전·0029 확장 (:186과 공유) |
| :196 tsc -b 교차-task | ★`tsc -b` 교차-task widening |

**§폼·입력 UX / 진단 표시** (14항목, 기존 4 + 신규 10 = 14 키워드):

| 항목(:줄) | 키워드 |
|---|---|
| :202 RunDialog 누락 머지 | ★새 옵션 RunDialog 누락 |
| :206 한 칸 add row | ★한 칸 add row |
| :210 step_id 진단성 | ★step_id 진단 |
| :214 KeyValueGrid 2-맵 | ★`KeyValueGrid` 2-맵 |
| :220 간단/상세 prefill | ★간단/상세 prefill 갭 |
| :224 Segmented teeth | Segmented teeth |
| :230 LoadShapePreview R10 | `LoadShapePreview` R10 |
| :234 번호 Section 재구성 | ★번호 `Section` 갭 |
| :238 HelpTip 57px | HelpTip 57px |
| :242 VarUsagePopover 클립 | ★`VarUsagePopover` 클립 |
| :246 프리셋 드롭다운 | ★프리셋 state 클리어 |
| :250 stretched-label | ★stretched-label 선례 0 |
| :254 native radio | native radio sweep |
| :258 aria-label 공유 | ★aria-label 2요소 공유 |

**§다단계 ramp UI** (5항목, 기존 4 키워드로 전수 커버 — 신규 0):

| 항목(:줄) | 키워드 |
|---|---|
| :264 곡선 0s/0RPS 회귀 | 곡선 `0s`/`0 RPS` 회귀 |
| :268 active-VU SUM 머지 | `active_vu_series` SUM 머지 |
| :272 2축 셀렉터 "곧 지원" 시절 | closed+curve "곧 지원" 시절 |
| :280 사이징 헬퍼 3회 검증 | 사이징 헬퍼 3회 검증 |
| :286 closed+curve 게이트 해체 | closed+curve "곧 지원" 시절 (:272와 공유) |

## claims ledger (사실 주장 → 생성 명령; plan 디스패치 전 일괄 재실행 대상)

> 초판의 §6 검증표 baseline 2행은 이 ledger 밖에서 실행 없이 "자명"으로 적혔다가 리뷰 F1에 적발 — 이번 판은 검증표 전 행이 아래 C1·C12·C13 실측에 근거한다. C2의 "12개"도 리뷰 F2가 13개로 정정(재실측 일치).

- C1 WARN 실발화·수치: `just doc-budget` → `WARN [불릿] 'Subagent dispatch 노하우' 섹션 총합 6,352 B > 6,144 B (불릿 29개)` + 표 `§…:최대 불릿 250/250`
- C2 섹션 구성(31+424+5,897=6,352, 240–250 B 불릿 **13개**: L123·125·132·134·137·138·140·142·143·144·149·150·151): python 재계산(스크립트와 동일 경계 — `## Subagent dispatch` 헤딩 줄부터 다음 `## ` 전까지, 줄 바이트=`len(encode())+1`); 합계가 C1 표의 6,352와 일치함을 확인
- C3 `###` 총수 61: `grep -c "^### " docs/dev/ui-gotcha-narratives.md`
- C4 섹션별 분포 28/14/14/5: `awk '/^## /{sec=$0} /^### /{cnt[sec]++} END{…}' docs/dev/ui-gotcha-narratives.md`
- C5 정본 중복 쌍 :15↔:16·:21+:22↔:23, 추가 쌍 없음: `grep -n "^- " docs/dev/subagent-dispatch.md`(전 불릿 나열) 첫 절 육안 대조
- C6 ② 절 원문 위치 :284: `grep -n "count 기반 앵커" docs/dev/ui-gotcha-narratives.md`
- C7 표지 1건 :108: `grep -n "②·③은 narratives" ui/CLAUDE.md`
- C8 포인터 4줄 위치·바이트(:13 241 B / :63 258 B / :98 315 B / :142 322 B): `grep -n "narratives" ui/CLAUDE.md` + `sed -n '13p;63p;98p;142p' | len(encode())`
- C9 래칫·기준선: `grep -n "RATCHET\|BASELINES\|ABS_WARN" scripts/check-doc-budget.py` → RATCHET=10240 · ui 기준 102,395 · ABS ui 122,880
- C10 merge-base=`fa94ed6a`: `git merge-base master HEAD`; coverage 소스 파라미터화: `Justfile:121` `doc-coverage BASE FILE`
- C11 복원문 191 B·표지 −5 B: python `len(encode())` 실측
- C12 현행 기본 게이트 green: `just doc-coverage` → exit 0, `OK: manifest 61행 · R17 섹션 8개`
- C13 비정합 쌍 FAIL 벽: `python3 scripts/check-doc-coverage.py fa94ed6a CLAUDE.md` → exit 1(`FAIL [move]` 123건) · `… fa94ed6a docs/dev/subagent-dispatch.md` → exit 1 — manifest 61행이 전달 쌍에 전역 대조되기 때문(`check-doc-coverage.py:117` 이하), `MANIFEST_MIN = 1`(:11)
- C14 corpus 구성: `check-doc-coverage.py:82 corpus_paths()` — 리터럴 4 + `docs/dev/*.md` + `docs/adr/*.md` + `crates/*/CLAUDE.md` glob, 소스 자신 제외(주석 :208–209, 제외 코드 :212–213)
- C15 ④ 누적-gain 코드·단본 크기: `sed -n '170,180p' scripts/check-doc-coverage.py` → `got = len(cur dest) − len(base dest)`, `got < Σ gain`이면 FAIL(:173–177); 단본 실측 `python len(encode())+1` → :16 = 689 B · :23 = 454 B · 합 1,143 B
- C16 선례 BASE의 정체: `git log --oneline -1 f870cfd9` + `git log f870cfd9~1..cc8114ea | tail` → `f870cfd9`는 ui-claude-md-curation spec 커밋(`f58445fa`) **직전** 커밋 — "base = 큐레이션 직전 상태" 규약의 선례
- C17 병합 재배분 실측 기각: python `len(encode())+1` — "라우팅 전체 통합" 불릿 296 B > 캡 250 B / 채택안 = 라우팅 코어 249 B + 2단계·inherit 205 B(원본 498 B 대비 −44 B)
