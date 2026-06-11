import { ko } from "../i18n/ko";

/**
 * 시나리오 템플릿 갤러리 (spec 2026-06-11 UX §4, U3).
 * - 클라 상수(UI-only). 각 YAML은 version 1 + 유효 ULID id + step name 필수 규칙을
 *   만족하는 완전한 시나리오 — templates.test.ts가 Zod 게이트 통과를 락인한다.
 * - 한국어 주석은 Document API round-trip으로 보존돼 YAML 탭에서 "고치며 배우는"
 *   자료가 된다(스텝 노드 통째 교체 시 그 스텝 내부 주석은 소실 — 알려진 한도).
 * - step id는 고정 ULID(fixture 관용 01HX… 스타일): 템플릿은 시나리오당 1회
 *   seed라 시나리오-내 유일성만 필요하다.
 */
export interface ScenarioTemplate {
  id: "blank" | "simple-get" | "login-flow" | "data-driven";
  name: string;
  description: string;
  yaml: string;
}

export const BLANK_TEMPLATE_YAML = `version: 1
name: "Untitled"
cookie_jar: auto
variables: {}
steps: []
`;

const SIMPLE_GET_YAML = `version: 1
name: "단순 GET"
cookie_jar: auto
variables: {}
steps:
  # 가장 단순한 부하: URL 하나에 GET을 반복합니다.
  - id: 01HX0000000000000000000310
    name: "헬스체크"
    type: http
    request:
      method: GET
      # 여기에 테스트할 URL을 넣으세요. 환경을 쓰면 "\${BASE_URL}/health"처럼 적을 수 있습니다.
      url: https://api.example.com/health
    # 응답 검증: 상태코드가 200이 아니면 에러로 집계됩니다.
    assert:
      - status: 200
`;

const LOGIN_FLOW_YAML = `version: 1
name: "로그인 흐름"
cookie_jar: auto
variables: {}
steps:
  # 1단계: 로그인 — 자격증명을 보내고 응답 본문에서 토큰을 꺼냅니다.
  - id: 01HX0000000000000000000320
    name: "로그인"
    type: http
    request:
      method: POST
      # \${BASE_URL}은 실행 시 선택한 환경(예: dev/stage)에서 주입됩니다.
      url: "\${BASE_URL}/login"
      body:
        json:
          username: "tester"
          password: "secret"
    assert:
      - status: 200
    # 값 추출: 응답 JSON의 $.token을 {{token}}으로 저장해 다음 스텝에서 씁니다.
    extract:
      - var: token
        from: body
        path: $.token
  # 2단계: 인증 API 호출 — 헤더에 {{token}}을 넣습니다.
  - id: 01HX0000000000000000000321
    name: "내 정보 조회"
    type: http
    request:
      method: GET
      url: "\${BASE_URL}/me"
      headers:
        Authorization: "Bearer {{token}}"
    assert:
      - status: 200
`;

const DATA_DRIVEN_YAML = `version: 1
name: "데이터 기반"
cookie_jar: auto
variables: {}
steps:
  # {{user}}/{{password}}는 CSV 데이터셋의 열과 연결됩니다.
  # 실행 설정의 '데이터 바인딩'에서 데이터셋을 선택하고 열을 매핑하세요.
  - id: 01HX0000000000000000000330
    name: "로그인(CSV 변수)"
    type: http
    request:
      method: POST
      url: "\${BASE_URL}/login"
      body:
        form:
          username: "{{user}}"
          password: "{{password}}"
    assert:
      - status: 200
`;

export const SCENARIO_TEMPLATES: ReadonlyArray<ScenarioTemplate> = [
  {
    id: "blank",
    name: ko.templates.blankName,
    description: ko.templates.blankDesc,
    yaml: BLANK_TEMPLATE_YAML,
  },
  {
    id: "simple-get",
    name: ko.templates.getName,
    description: ko.templates.getDesc,
    yaml: SIMPLE_GET_YAML,
  },
  {
    id: "login-flow",
    name: ko.templates.loginName,
    description: ko.templates.loginDesc,
    yaml: LOGIN_FLOW_YAML,
  },
  {
    id: "data-driven",
    name: ko.templates.dataName,
    description: ko.templates.dataDesc,
    yaml: DATA_DRIVEN_YAML,
  },
];
