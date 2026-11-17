// 「모드 전환」 셸 페이지(desktop/src/role.html) 헤드리스 점검 — jsdom + 가짜 __TAURI_INTERNALS__.
//
// 게이트 밖(수동): role.html을 고친 뒤 실행한다. jsdom은 ui/의 devDependency를 빌린다.
//   (cd ui && pnpm install)   # 처음 한 번
//   node desktop/tests/role-page.check.cjs            # 마지막 줄 "ALL PASS", exit 0
//   ROLE_HTML=<다른 role.html> node desktop/tests/role-page.check.cjs   # 다른 판 대조
// 실제 WebView 동작(클립보드·창 이동)은 여기서 보지 못한다 — 라이브 검증 몫.
"use strict";
const path = require("path");
const fs = require("fs");
const { JSDOM, VirtualConsole } = require(path.join(__dirname, "../../ui/node_modules/jsdom"));

const html = fs.readFileSync(process.env.ROLE_HTML || path.join(__dirname, "../src/role.html"), "utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
function check(name, cond) {
  console.log((cond ? "PASS " : "FAIL ") + name);
  if (!cond) fails++;
}

function base(role) {
  return {
    role, switching: false, grpc_port: 8093, ips: ["192.168.0.12", "10.0.0.5"], server_os: "macos",
    self_worker: true, self_worker_busy: false,
    install_id: "a".repeat(32), hostname: "QA-PC-01", worker: null,
    notices: { port_changed: null, save_failed: false, self_worker_excluded: false, config_warning: false, start_error: null, worker_code_unreadable: false },
    app_url: "http://127.0.0.1:5555/", ips_public_fallback: false,
  };
}
const FAKE_CODE = "HANDICAP1-" + "ab".repeat(40);
function workerBase(w) {
  const st = base("worker");
  st.app_url = null;
  st.worker = Object.assign({ state: "idle", servers: ["10.0.0.9:8093"], addr: "10.0.0.9:8093", run_tail: null, scenario_name: null, reason: null, reason_detail: null, retry_in_secs: null }, w);
  return st;
}

// state: { value, runs, after, switchFail, failSetsStartError, roleStateFailures }
async function load(state, opts = {}) {
  const calls = [];
  const logs = [];
  const vc = new VirtualConsole();
  for (const k of ["log", "error", "warn", "info", "debug"]) vc.on(k, (...a) => logs.push(a.join(" ")));
  vc.on("jsdomError", (e) => { if (!/framed/.test(String(e && e.message))) console.error(e); });
  const dom = new JSDOM(html, {
    // pretendToBeVisual: document.hidden=false — 아니면 3초 조회·visibilitychange가 건너뛰어 공허해진다.
    runScripts: "dangerously", url: "tauri://localhost/role.html", virtualConsole: vc, pretendToBeVisual: true,
    beforeParse(w) {
      if (opts.framed) Object.defineProperty(w, "self", { get: () => ({}), configurable: true });
      w.Promise.allSettled = Promise.allSettled.bind(Promise);
      w.__TAURI_INTERNALS__ = {
        invoke(cmd, args) {
          calls.push([cmd, args]);
          if (cmd === "role_state") {
            if (state.roleStateFailures > 0) { state.roleStateFailures--; return Promise.reject("상태를 읽지 못함"); }
            return Promise.resolve(JSON.parse(JSON.stringify(state.value)));
          }
          if (cmd === "worker_command") return Promise.resolve(`CMD ${args.ip} ${args.os} ${state.value.grpc_port}`);
          if (cmd === "active_run_count") return state.runsFail ? Promise.reject(state.runsFail) : Promise.resolve(state.runs || 0);
          if (cmd === "switch_role") {
            if (state.switchFail) {
              if (state.failSetsStartError) state.value.notices.start_error = state.switchFail;
              return Promise.reject(state.switchFail);
            }
            state.value = state.after;
            return Promise.resolve(null);
          }
          if (cmd === "dismiss_notice") {
            state.value.notices[args.kind] = args.kind === "port_changed" || args.kind === "start_error" ? null : false;
            return Promise.resolve(null);
          }
          if (cmd === "set_self_worker") return Promise.resolve(null);
          if (cmd === "connect_code") {
            if (state.codeFail) return Promise.reject(state.codeFail);
            return Promise.resolve(FAKE_CODE);
          }
          if (cmd === "check_code") return state.preview ? Promise.resolve(state.preview) : Promise.reject("접속 코드 형식이 아닙니다");
          if (cmd === "connect_worker" || cmd === "disconnect_worker" || cmd === "reconnect_worker") {
            if (cmd === "reconnect_worker" && state.reconnectFail) return Promise.reject(state.reconnectFail);
            if (cmd === "disconnect_worker" && state.disconnectFail) return Promise.reject(state.disconnectFail);
            if (state.after) state.value = state.after;
            return Promise.resolve(null);
          }
          return Promise.reject("unknown " + cmd);
        },
      };
    },
  });
  await sleep(50);
  return { dom, w: dom.window, d: dom.window.document, calls, logs };
}
const noticeTexts = (d) => [...d.querySelectorAll(".notice span")].map((s) => s.textContent);
const key = (w, k, shift) => w.document.dispatchEvent(new w.KeyboardEvent("keydown", { key: k, shiftKey: !!shift, bubbles: true }));

(async () => {
  // 틀 안: 아무것도 그리지 않고 IPC 없음
  {
    const st = { value: base("server") };
    const { d, calls } = await load(st, { framed: true });
    check("framed: no IPC", calls.length === 0);
    check("framed: document emptied", !d.getElementById("switch"));
  }
  // 혼자 쓰기
  {
    const st = { value: base("local") };
    const { d } = await load(st);
    check("local mode line", d.getElementById("mode").textContent === "현재 모드: 혼자 쓰기 (이 PC만 부하를 냅니다)");
    check("local button", d.getElementById("switch").textContent === "서버로 열기");
    check("local server section hidden", d.getElementById("server").hidden);
    check("back visible", !d.getElementById("back").hidden);
  }
  // 서버
  {
    const st = { value: base("server") };
    st.value.notices.port_changed = [8081, 8093];
    st.value.notices.config_warning = true;
    const { d, calls } = await load(st);
    check("server mode line", d.getElementById("mode").textContent === "현재 모드: 서버로 열려 있음");
    check("server button", d.getElementById("switch").textContent === "혼자 쓰기로 돌아가기");
    const radios = d.querySelectorAll('input[name="ip"]');
    check("2 ip radios, first checked", radios.length === 2 && radios[0].checked && !radios[1].checked);
    check("os default = server_os", d.getElementById("os").value === "macos");
    check("command filled", d.getElementById("cmd").value === "CMD 192.168.0.12 macos 8093");
    check("macos guide", d.getElementById("os-guide").textContent === "같은 버전의 앱을 응용 프로그램 폴더에 설치하고 한 번 열어 허용한 뒤(또는 xattr -dr com.apple.quarantine /Applications/Handicap.app) 터미널에 붙여넣으세요");
    check("macos firewall", d.getElementById("firewall").textContent === "「들어오는 네트워크 연결을 허용하겠습니까?」 창이 뜨면 허용을 눌러 주세요");
    check("port notice", noticeTexts(d).includes("부하기 접속 포트 8081을 다른 프로그램이 쓰고 있어 8093로 열었습니다 — 부하기들에 새 접속 코드(또는 명령)를 주세요"));
    check("config warning notice", noticeTexts(d).includes("저장된 역할 설정을 읽지 못해 혼자 쓰기로 열었습니다"));
    check("toggle checked", d.getElementById("sw").checked && !d.getElementById("sw").disabled);
    const os = d.getElementById("os"); os.value = "linux"; os.dispatchEvent(new d.defaultView.Event("change"));
    await sleep(20);
    check("linux command", d.getElementById("cmd").value === "CMD 192.168.0.12 linux 8093");
    check("linux guide", d.getElementById("os-guide").textContent === "AppImage 폴더에서 붙여넣으세요(실행 권한 필요)");
    radios[1].checked = true; radios[1].dispatchEvent(new d.defaultView.Event("change"));
    await sleep(20);
    check("second ip command", d.getElementById("cmd").value === "CMD 10.0.0.5 linux 8093");
    const btn = [...d.querySelectorAll(".notice")].find((n) => n.textContent.includes("8081")).querySelector("button");
    btn.click(); await sleep(30);
    check("dismiss called", calls.some((c) => c[0] === "dismiss_notice" && c[1].kind === "port_changed"));
    check("port notice gone", !noticeTexts(d).some((s) => s.includes("8081")));
    d.getElementById("copy").click(); await sleep(20);
    check("copy failure message (jsdom has no clipboard)", d.getElementById("copy-msg").textContent === "복사하지 못했습니다 — 칸을 선택해 직접 복사하세요");
    check("no token key in any call args", calls.every((c) => !JSON.stringify(c[1] || {}).includes("token")));
    const pt = d.getElementById("plaintext");
    check("plaintext caution shown", !pt.hidden && !pt.closest("[hidden]") && pt.textContent === "연결은 암호화되지 않습니다 — 회사 망에서만 쓰세요. 부하기 PC는 테스트의 환경 값(비밀 포함)을 받습니다.");
    check("private ips → no public warning", d.getElementById("ip-public").hidden);
  }
  // 사설 주소가 없어 바깥 주소로 채운 목록
  {
    const st = { value: base("server") };
    st.value.ips = ["8.8.4.4"]; st.value.ips_public_fallback = true;
    const { d } = await load(st);
    const w = d.getElementById("ip-public");
    check("public fallback warning shown", !w.hidden && w.textContent === "사설 망 주소가 아닙니다 — 이 주소는 바깥 망에 드러날 수 있습니다");
    check("public fallback keeps plaintext caution", !d.getElementById("plaintext").hidden);
    st.value.ips = []; await sleep(3200);
    check("no ips → public warning hidden", w.hidden && !d.getElementById("no-ip").hidden);
  }
  // 잠금 사유 · 주소 0개 · Windows 방화벽
  {
    const st = { value: base("server") };
    st.value.self_worker_busy = true; st.value.ips = []; st.value.server_os = "windows";
    const { d } = await load(st);
    check("busy toggle disabled + note", d.getElementById("sw").disabled && d.getElementById("sw-note").textContent === "이 PC가 테스트를 실행하는 중이라 끝난 뒤 바꿀 수 있습니다");
    check("no ip message", !d.getElementById("no-ip").hidden && d.getElementById("no-ip").textContent === "이 PC의 망 주소를 찾지 못했습니다");
    check("no ip → empty cmd + copy disabled", d.getElementById("cmd").value === "" && d.getElementById("copy").disabled);
    check("windows firewall", d.getElementById("firewall").textContent === "처음에 묻는 「액세스 허용」을 눌러 주세요 — 놓쳤다면 docs/dev/lan-workers.md §1");
    check("windows guide", d.getElementById("os-guide").textContent === "같은 버전의 포터블 exe를 받아 두고 그 폴더의 PowerShell에 붙여넣으세요");
  }
  {
    const st = { value: base("server") };
    st.value.self_worker = false; st.value.server_os = "linux"; st.value.grpc_port = 8081;
    const { d } = await load(st);
    check("self_worker off → toggle unchecked, enabled, no note", !d.getElementById("sw").checked && !d.getElementById("sw").disabled && d.getElementById("sw-note").hidden);
    check("linux firewall with port", d.getElementById("firewall").textContent === "방화벽(ufw)을 쓰고 있다면 sudo ufw allow 8081/tcp");
  }
  // 실행 중 run 있음: 확인 → 취소 / 확인 → 덮개
  {
    const st = { value: base("local"), runs: 2, after: base("server") };
    const { d, calls } = await load(st);
    d.getElementById("switch").click(); await sleep(20);
    check("confirm shown", d.getElementById("confirm").classList.contains("on") && d.getElementById("confirm-text").textContent === "실행 중인 테스트 2개가 중단됩니다");
    d.getElementById("confirm-cancel").click(); await sleep(20);
    check("cancel → no switch", !calls.some((c) => c[0] === "switch_role") && !d.getElementById("confirm").classList.contains("on"));
    d.getElementById("switch").click(); await sleep(20);
    d.getElementById("confirm-ok").click(); await sleep(20);
    check("overlay on with text", d.getElementById("busy").classList.contains("on") && d.getElementById("busy-text").textContent === "서버 모드로 전환 중…");
    check("overlay aria-busy", d.getElementById("busy").getAttribute("aria-busy") === "true");
    check("buttons disabled under overlay", [...d.querySelectorAll("#app button")].every((b) => b.disabled));
    check("switch_role target server", calls.some((c) => c[0] === "switch_role" && c[1].target === "server"));
    await sleep(700);
    check("overlay off after ≥600ms", !d.getElementById("busy").classList.contains("on"));
    check("re-rendered as server", d.getElementById("mode").textContent === "현재 모드: 서버로 열려 있음");
  }
  // 회귀(fix round 1, IMPORTANT 1): 전환을 한 번 한 뒤 확인 상자 버튼이 잠겨 막다른 길이 되던 버그.
  // 순서: 혼자 쓰기 → (run 0) 서버로 열기 → run 1개 → 「혼자 쓰기로 돌아가기」 → 확인 상자 버튼이 살아 있어야.
  {
    const st = { value: base("local"), runs: 0, after: base("server") };
    const { w, d, calls } = await load(st);
    d.getElementById("switch").click(); await sleep(700);
    check("dead-end: first switch done (server)", d.getElementById("switch").textContent === "혼자 쓰기로 돌아가기");
    st.runs = 1; st.after = base("local");
    d.getElementById("switch").click(); await sleep(20);
    const ok = d.getElementById("confirm-ok"), cancel = d.getElementById("confirm-cancel");
    check("dead-end: confirm open", d.getElementById("confirm").classList.contains("on") && d.getElementById("confirm-text").textContent === "실행 중인 테스트 1개가 중단됩니다");
    check("dead-end: confirm buttons enabled", !ok.disabled && !cancel.disabled);
    // MINOR 4: 포커스는 상자 안(취소에서 시작), Tab·Shift+Tab은 두 버튼 사이만, Esc = 취소
    check("focus starts on 취소", d.activeElement === cancel);
    key(w, "Tab"); check("Tab → 중단하고 전환", d.activeElement === ok);
    key(w, "Tab"); check("Tab → 취소 (cycles)", d.activeElement === cancel);
    key(w, "Tab", true); check("Shift+Tab → 중단하고 전환", d.activeElement === ok);
    key(w, "Escape"); await sleep(20);
    check("Esc closes without switching", !d.getElementById("confirm").classList.contains("on") && calls.filter((c) => c[0] === "switch_role").length === 1);
    d.getElementById("switch").focus(); key(w, "Tab");
    check("after close, Tab handler removed", d.activeElement === d.getElementById("switch"));
    d.getElementById("switch").click(); await sleep(20);
    check("dead-end: reopened buttons enabled", !ok.disabled && !cancel.disabled);
    ok.click(); await sleep(700);
    check("dead-end: second switch target local", calls.filter((c) => c[0] === "switch_role").map((c) => c[1].target).join(",") === "server,local");
    check("dead-end: back to local", d.getElementById("switch").textContent === "서버로 열기");
  }
  // 혼자 쓰기로의 실패: 화면 한 줄만(안내 없음)
  {
    const st = { value: base("server"), runs: 0, switchFail: "bind 실패" };
    const { d } = await load(st);
    d.getElementById("switch").click(); await sleep(20);
    check("0 runs → no confirm", !d.getElementById("confirm").classList.contains("on"));
    check("overlay local text", d.getElementById("busy-text").textContent === "혼자 쓰기로 돌아가는 중…");
    await sleep(700);
    check("local failure: inline message", d.getElementById("err").textContent === "전환하지 못했습니다: bind 실패" && !d.getElementById("err").hidden);
    check("local failure: no start_error notice", !noticeTexts(d).some((s) => s.startsWith("서버로 열지 못했습니다")));
    await sleep(3100); // 3초 조회가 성공해도 전환 실패 줄은 남는다
    check("local failure: inline survives successful poll", d.getElementById("err").textContent === "전환하지 못했습니다: bind 실패");
  }
  // 서버로의 실패: 셸 안내 한 번만(화면 줄 없음)
  {
    const st = { value: base("local"), runs: 0, switchFail: "주소 사용 중", failSetsStartError: true };
    const { d } = await load(st);
    d.getElementById("switch").click(); await sleep(700);
    check("server failure: start_error notice", noticeTexts(d).includes("서버로 열지 못했습니다: 주소 사용 중"));
    check("server failure: no inline duplicate", d.getElementById("err").hidden);
  }
  // MINOR 3: 상태 조회 실패 줄은 다음 조회가 성공하면 사라진다
  {
    const st = { value: base("server"), roleStateFailures: 1 };
    const { d } = await load(st);
    check("refresh error shown", !d.getElementById("err").hidden && d.getElementById("err").textContent === "상태를 읽지 못함");
    d.dispatchEvent(new d.defaultView.Event("visibilitychange")); await sleep(30);
    check("refresh error cleared on success", d.getElementById("err").hidden && d.getElementById("mode").textContent === "현재 모드: 서버로 열려 있음");
  }
  // 컨트롤러 없음(서버 시작 실패)
  {
    const st = { value: base("server") };
    st.value.app_url = null; st.value.notices.start_error = "주소 사용 중";
    const { d } = await load(st);
    check("no backend: mode line hidden", d.getElementById("mode").hidden);
    check("no backend: server section hidden", d.getElementById("server").hidden);
    check("no backend: back hidden", d.getElementById("back").hidden);
    check("start error notice", noticeTexts(d).includes("서버로 열지 못했습니다: 주소 사용 중"));
    check("button 혼자 쓰기로 돌아가기", d.getElementById("switch").textContent === "혼자 쓰기로 돌아가기");
  }
  // ===== 2b: 접속 코드·부하기로 접속·부하기 상태 =====
  {
    const st = { value: base("server") };
    const { d, calls, logs } = await load(st);
    check("server: #code text = code", d.getElementById("code").textContent === FAKE_CODE);
    check("server: #cmd-box closed", d.getElementById("cmd-box").tagName === "DETAILS" && !d.getElementById("cmd-box").open);
    check("server: #cmd-box summary", d.querySelector("#cmd-box summary").textContent === "명령으로 붙이기 (포터블 exe·터미널)");
    check("server: code nowrap style", /nowrap/.test(d.defaultView.getComputedStyle(d.getElementById("code")).whiteSpace));
    check("server: code guide", d.getElementById("server").textContent.includes("부하기 PC의 앱에서 「모드 전환」 → 「부하기로 접속」에 붙여넣으세요 — 같은 버전의 앱이어야 합니다"));
    check("server: code heading", d.getElementById("server").textContent.includes("부하기 PC 접속 코드"));
    check("server: ip-public/plaintext/sw/firewall outside cmd-box", ["plaintext", "ip-public", "sw", "firewall"].every((i) => !d.getElementById("cmd-box").contains(d.getElementById(i))));
    check("server: cmd parts inside cmd-box", ["cmd", "copy", "os", "os-guide", "no-ip", "ips"].every((i) => d.getElementById("cmd-box").contains(d.getElementById(i))));
    check("server: #code-copy enabled", !d.getElementById("code-copy").disabled);
    d.getElementById("code-copy").click(); await sleep(20);
    check("server: code copy failure message", d.getElementById("code-copy-msg").textContent === "복사하지 못했습니다 — 칸을 선택해 직접 복사하세요");
    check("server: #join summary 부하기로 접속", d.querySelector("#join summary").textContent === "부하기로 접속");
    check("server: #join closed", !d.getElementById("join").open);
    check("server: connect_code called once", calls.filter((c) => c[0] === "connect_code").length === 1);
    check("server: no worker panel / switch-server", d.getElementById("worker").hidden && d.getElementById("switch-server").hidden);
    check("no code text in console", logs.every((l) => !l.includes("HANDICAP1-")));
  }
  {
    const st = { value: base("server"), codeFail: "이 PC의 망 주소를 찾지 못했습니다" };
    const { d } = await load(st);
    check("server: code error shown", !d.getElementById("code-err").hidden && d.getElementById("code-err").textContent === "이 PC의 망 주소를 찾지 못했습니다");
    check("server: code copy disabled on error", d.getElementById("code-copy").disabled);
  }
  // 부하기 상태 6종
  {
    const U = "서버에 연결할 수 없습니다 — 서버 PC가 켜져 있고 서버 모드인지, 방화벽이 막지 않는지 확인해 주세요";
    const cases = [
      ["connecting", { state: "connecting", servers: ["10.0.0.9:8093", "10.0.0.8:8093"], addr: null }, "서버에 연결하는 중…", "10.0.0.9:8093, 10.0.0.8:8093", true, false],
      ["idle", { state: "idle" }, "연결됨 · 대기 중", "10.0.0.9:8093", true, false],
      ["running+name", { state: "running", scenario_name: "결제 시나리오", run_tail: "AB12CD" }, "테스트 실행 중 · 결제 시나리오 · #AB12CD", "10.0.0.9:8093", true, false],
      ["running no name", { state: "running", run_tail: "AB12CD" }, "테스트 실행 중 · #AB12CD", "10.0.0.9:8093", true, false],
      ["retrying unreachable", { state: "retrying", reason: "unreachable", retry_in_secs: 4 }, "다시 시도 중 — " + U, "4초 뒤 다시 시도", true, false],
      ["retrying auth", { state: "retrying", reason: "auth_failed", retry_in_secs: 4 }, "다시 시도 중 — 접속 코드의 토큰이 맞지 않습니다 — 서버 화면에서 새 코드를 받아 주세요", "4초 뒤 다시 시도", true, false],
      ["retrying protocol", { state: "retrying", reason: "protocol", retry_in_secs: 4 }, "다시 시도 중 — 서버와 통신하지 못했습니다 — 두 PC의 앱 버전이 같은지 확인해 주세요", "4초 뒤 다시 시도", true, false],
      ["retrying rejected", { state: "retrying", reason: "rejected", reason_detail: "full", retry_in_secs: 4 }, "다시 시도 중 — 서버가 접속을 거절했습니다: full", "4초 뒤 다시 시도", true, false],
      ["retrying 0s", { state: "retrying", reason: "unreachable", retry_in_secs: 0 }, "다시 시도 중 — " + U, "다시 시도하는 중…", true, false],
      ["excluded", { state: "excluded" }, "서버에서 제외됨 — 서버 「워커」 화면에서 제외했습니다", "", false, true],
      ["disconnected", { state: "disconnected" }, "접속 끊김", "", false, true],
    ];
    for (const [name, w, stateText, detailText, disc, reco] of cases) {
      const st = { value: workerBase(w) };
      const { d } = await load(st);
      check(`worker ${name}: #w-state`, d.getElementById("w-state").textContent === stateText);
      check(`worker ${name}: #w-detail`, d.getElementById("w-detail").textContent === detailText);
      check(`worker ${name}: buttons`, d.getElementById("w-disconnect").hidden === !disc && d.getElementById("w-reconnect").hidden === !reco);
      check(`worker ${name}: panel shown, back hidden`, !d.getElementById("worker").hidden && d.getElementById("back").hidden);
    }
    const st = { value: workerBase({ state: "idle" }) };
    const { d } = await load(st);
    check("worker: #mode", !d.getElementById("mode").hidden && d.getElementById("mode").textContent === "현재 모드: 부하기 (서버가 보내는 테스트를 실행합니다)");
    check("worker: #switch text", d.getElementById("switch").textContent === "혼자 쓰기로 돌아가기" && !d.getElementById("switch").hidden);
    check("worker: #switch-server text", d.getElementById("switch-server").textContent === "서버로 열기" && !d.getElementById("switch-server").hidden);
    check("worker: #join summary", d.querySelector("#join summary").textContent === "다른 접속 코드로 바꾸기");
    check("worker: server section hidden", d.getElementById("server").hidden);
    check("worker: #w-ident", d.getElementById("w-ident").textContent === "이 PC: QA-PC-01 · 워커 ID " + "a".repeat(32));
  }
  {
    const st = { value: workerBase({ state: "idle" }) };
    st.value.install_id = null;
    const { d } = await load(st);
    check("worker: install_id null → ident host only", d.getElementById("w-ident").textContent === "이 PC: QA-PC-01");
  }
  {
    const st = { value: workerBase({ state: "disconnected", servers: [] }) };
    const { d } = await load(st);
    check("worker: disconnected no servers → reconnect hidden", d.getElementById("w-reconnect").hidden && d.getElementById("w-disconnect").hidden);
  }
  // XSS: 서버 글자는 textContent + bdi
  {
    const evil = '<img src=x onerror="window.__pwn=1">';
    const st = { value: workerBase({ state: "retrying", reason: "rejected", reason_detail: evil, retry_in_secs: 2 }) };
    const { d, w } = await load(st);
    check("xss reason: no img", d.querySelectorAll("img").length === 0);
    check("xss reason: literal text visible", d.getElementById("w-state").textContent.includes(evil));
    check("xss reason: inside bdi", [...d.querySelectorAll("#w-state bdi")].some((b) => b.textContent === evil));
    st.value = workerBase({ state: "running", scenario_name: evil, run_tail: "X1" });
    d.dispatchEvent(new w.Event("visibilitychange")); await sleep(30);
    check("xss scenario: no img, text visible", d.querySelectorAll("img").length === 0 && d.getElementById("w-state").textContent.includes(evil));
    check("xss scenario: inside bdi", [...d.querySelectorAll("#w-state bdi")].some((b) => b.textContent === evil));
    check("xss: handler never ran", w.__pwn === undefined);
  }
  // 혼자 쓰기: 잘못된 코드
  {
    const st = { value: base("local") };
    const { d, calls, logs } = await load(st);
    check("local: #join summary 부하기로 접속", d.querySelector("#join summary").textContent === "부하기로 접속");
    check("local: #join closed, switch-server/worker hidden", !d.getElementById("join").open && d.getElementById("switch-server").hidden && d.getElementById("worker").hidden);
    d.getElementById("code-in").value = FAKE_CODE.slice(0, -1) + "c";
    d.getElementById("join-btn").click(); await sleep(30);
    check("bad code → join-err", d.getElementById("join-err").textContent === "접속 코드 형식이 아닙니다" && !d.getElementById("join-err").hidden);
    check("bad code: no code in console", logs.every((l) => !l.includes("HANDICAP1-")));
    check("bad code → no connect_worker, no confirm", !calls.some((c) => c[0] === "connect_worker") && !d.getElementById("confirm").classList.contains("on"));
    check("code-in textarea aria-label", d.getElementById("code-in").getAttribute("aria-label") === "접속 코드" && d.getElementById("code-in").tagName === "TEXTAREA");
    check("join guide + button text", d.getElementById("join").textContent.includes("서버 PC의 「모드 전환」 화면에서 복사한 접속 코드를 붙여넣으세요") && d.getElementById("join-btn").textContent === "부하기로 접속");
  }
  // 혼자 쓰기: 좋은 코드
  {
    const st = { value: base("local"), runs: 2, preview: { ips: ["10.0.0.9", "10.0.0.8"], port: 8093, non_private: true }, after: workerBase({ state: "connecting" }) };
    const { d, calls, logs } = await load(st);
    d.getElementById("code-in").value = FAKE_CODE;
    d.getElementById("join-btn").click(); await sleep(40);
    const lines = [...d.querySelectorAll("#confirm-text p")].map((p) => p.textContent);
    check("join confirm 4 lines", lines.length === 4 && lines.join("|") === [
      "이 서버에 부하기로 접속합니다: 10.0.0.9:8093, 10.0.0.8:8093 — 이 서버가 보내는 테스트를 이 PC가 실행합니다",
      "사설 망 주소가 아닙니다 — 회사 망 밖의 서버일 수 있습니다",
      "이 PC의 시나리오 화면·예약 실행·운영 모니터가 멈춥니다(다른 역할로 돌아오면 다시 켜집니다)",
      "실행 중인 테스트 2개가 중단됩니다"].join("|"));
    check("join confirm ok label", d.getElementById("confirm-ok").textContent === "접속");
    d.getElementById("confirm-cancel").click(); await sleep(20);
    check("join cancel → no connect_worker", !calls.some((c) => c[0] === "connect_worker"));
    d.getElementById("join-btn").click(); await sleep(40);
    d.getElementById("confirm-ok").click(); await sleep(30);
    check("join overlay text", d.getElementById("busy").classList.contains("on") && d.getElementById("busy-text").textContent === "부하기로 접속하는 중…");
    const cw = calls.filter((c) => c[0] === "connect_worker");
    check("connect_worker args = pasted code", cw.length === 1 && JSON.stringify(cw[0][1]) === JSON.stringify({ code: FAKE_CODE }));
    await sleep(700);
    check("join success → code-in cleared, join closed, worker panel", d.getElementById("code-in").value === "" && !d.getElementById("join").open && !d.getElementById("worker").hidden);
    check("good code: no code in console", logs.every((l) => !l.includes("HANDICAP1-")));
    check("join: no token key in args", calls.every((c) => !JSON.stringify(c[1] || {}).includes("token")));
  }
  // 사설 + 0 run: 줄 2개
  {
    const st = { value: base("local"), runs: 0, preview: { ips: ["10.0.0.9"], port: 8093, non_private: false } };
    const { d } = await load(st);
    d.getElementById("code-in").value = FAKE_CODE;
    d.getElementById("join-btn").click(); await sleep(40);
    check("join confirm 2 lines (private, 0 runs)", d.querySelectorAll("#confirm-text p").length === 2);
    d.getElementById("confirm-cancel").click(); await sleep(20);
  }
  // 부하기 running: 끊기·전환
  {
    const st = { value: workerBase({ state: "running", run_tail: "AB" }), after: base("local") };
    const { d, calls } = await load(st);
    d.getElementById("w-disconnect").click(); await sleep(30);
    const lines = [...d.querySelectorAll("#confirm-text p")].map((p) => p.textContent);
    check("disconnect running: confirm one line", lines.length === 1 && lines[0] === "실행 중인 테스트가 중단됩니다 — 다른 부하기도 함께 멈춥니다" && d.getElementById("confirm-ok").textContent === "중단하고 끊기");
    d.getElementById("confirm-cancel").click(); await sleep(20);
    check("disconnect cancel → no IPC", !calls.some((c) => c[0] === "disconnect_worker"));
    d.getElementById("w-disconnect").click(); await sleep(30);
    d.getElementById("confirm-ok").click(); await sleep(30);
    check("disconnect overlay text", d.getElementById("busy-text").textContent === "접속을 끊는 중…");
    check("disconnect confirmed → 1 call", calls.filter((c) => c[0] === "disconnect_worker").length === 1);
    await sleep(700);
  }
  {
    const st = { value: workerBase({ state: "idle" }) };
    const { d, calls } = await load(st);
    d.getElementById("w-disconnect").click(); await sleep(30);
    check("disconnect idle: no confirm, called", !d.getElementById("confirm").classList.contains("on") && calls.filter((c) => c[0] === "disconnect_worker").length === 1);
    await sleep(700);
  }
  {
    const st = { value: workerBase({ state: "running", run_tail: "AB" }), after: base("server") };
    const { d, calls } = await load(st);
    d.getElementById("switch-server").click(); await sleep(30);
    check("switch-server running: confirm ok label", d.getElementById("confirm").classList.contains("on") && d.getElementById("confirm-ok").textContent === "중단하고 전환");
    d.getElementById("confirm-ok").click(); await sleep(30);
    check("switch-server overlay text", d.getElementById("busy-text").textContent === "서버 모드로 전환 중…");
    check("switch-server → switch_role server", calls.some((c) => c[0] === "switch_role" && c[1].target === "server"));
    await sleep(700);
    check("switch-server → server rendered", d.getElementById("mode").textContent === "현재 모드: 서버로 열려 있음");
  }
  {
    const st = { value: workerBase({ state: "idle" }), after: base("local") };
    const { d, calls } = await load(st);
    d.getElementById("switch").click(); await sleep(30);
    check("worker switch idle → local, no confirm", !d.getElementById("confirm").classList.contains("on") && d.getElementById("busy-text").textContent === "혼자 쓰기로 돌아가는 중…" && calls.some((c) => c[0] === "switch_role" && c[1].target === "local"));
    await sleep(700);
  }
  // 부하기 역할에서 새 코드로 바꾸기 + running 경고
  {
    const st = { value: workerBase({ state: "running", run_tail: "AB" }), preview: { ips: ["10.0.0.7"], port: 8093, non_private: false }, after: workerBase({ state: "connecting" }) };
    const { d } = await load(st);
    d.getElementById("code-in").value = FAKE_CODE;
    d.getElementById("join-btn").click(); await sleep(40);
    const lines = [...d.querySelectorAll("#confirm-text p")].map((p) => p.textContent);
    check("worker join: 2 lines (target + running)", lines.length === 2 && lines[1] === "실행 중인 테스트가 중단됩니다 — 다른 부하기도 함께 멈춥니다");
    d.getElementById("confirm-cancel").click(); await sleep(20);
  }
  // excluded → 다시 접속
  {
    const st = { value: workerBase({ state: "excluded" }), after: workerBase({ state: "connecting" }) };
    const { d, calls } = await load(st);
    d.getElementById("w-reconnect").click(); await sleep(30);
    check("reconnect: no confirm, called, overlay", !d.getElementById("confirm").classList.contains("on") && calls.filter((c) => c[0] === "reconnect_worker").length === 1 && d.getElementById("busy-text").textContent === "다시 접속하는 중…");
    await sleep(700);
  }
  // 폴링 주기
  {
    const st = { value: workerBase({ state: "idle" }) };
    const { calls } = await load(st);
    await sleep(1200);
    check("worker polls ~1s", calls.filter((c) => c[0] === "role_state").length >= 2);
  }
  {
    const st = { value: base("server") };
    const { calls } = await load(st);
    await sleep(1200);
    check("server polls 3s (1 call in 1.2s)", calls.filter((c) => c[0] === "role_state").length === 1);
  }
  // 입력이 안 날아감
  for (const role of ["worker", "local", "server"]) {
    const st = { value: role === "worker" ? workerBase({ state: "idle" }) : base(role) };
    const { d } = await load(st);
    d.getElementById("join").open = true;
    d.getElementById("code-in").value = "typed-text";
    if (role === "worker") await sleep(1200);
    if (role === "worker") st.value = workerBase({ state: "running", run_tail: "Z" });
    d.dispatchEvent(new d.defaultView.Event("visibilitychange")); await sleep(30);
    check(`input survives redraw (${role})`, d.getElementById("join").open && d.getElementById("code-in").value === "typed-text");
  }
  // 안내
  {
    const st = { value: base("local") };
    st.value.notices.worker_code_unreadable = true;
    const { d, calls } = await load(st);
    check("worker_code_unreadable notice", noticeTexts(d).includes("저장된 접속 코드를 읽지 못했습니다 — 새 코드를 붙여넣어 주세요"));
    d.querySelector(".notice button").click(); await sleep(30);
    check("worker_code_unreadable dismiss kind", calls.some((c) => c[0] === "dismiss_notice" && c[1].kind === "worker_code_unreadable"));
  }
  // 접속 흐름 중 다른 IPC 실패도 #join-err로
  {
    const st = { value: base("local"), preview: { ips: ["10.0.0.9"], port: 8093, non_private: false }, runsFail: "이미 전환 중입니다" };
    const { d, calls } = await load(st);
    d.getElementById("code-in").value = FAKE_CODE;
    d.getElementById("join-btn").click(); await sleep(40);
    check("join: active_run_count failure → #join-err", !d.getElementById("join-err").hidden && d.getElementById("join-err").textContent === "이미 전환 중입니다");
    check("join: failure → no confirm, no connect_worker", !d.getElementById("confirm").classList.contains("on") && !calls.some((c) => c[0] === "connect_worker"));
  }
  // 최신 상태를 새로 읽는다: 캐시(idle)가 아니라 running
  {
    const st = { value: workerBase({ state: "idle" }) };
    const { d } = await load(st);
    st.value = workerBase({ state: "running", run_tail: "Q" });
    d.getElementById("w-disconnect").click(); await sleep(30);
    check("disconnect reads fresh state (idle cached, running now) → confirm", d.getElementById("confirm").classList.contains("on"));
    d.getElementById("confirm-cancel").click(); await sleep(20);
  }
  // 동작별 실패 문구
  {
    const st = { value: workerBase({ state: "idle" }), disconnectFail: "끊기 실패" };
    const { d } = await load(st);
    d.getElementById("w-disconnect").click(); await sleep(700);
    check("disconnect failure text", d.getElementById("err").textContent === "접속을 끊지 못했습니다: 끊기 실패");
  }
  // 서버가 아니게 되면 코드 글자를 DOM에서 지운다
  {
    const st = { value: base("server") };
    const { d, w } = await load(st);
    check("code present while server", d.getElementById("code").textContent === FAKE_CODE);
    st.value = base("local");
    d.dispatchEvent(new w.Event("visibilitychange")); await sleep(30);
    check("code cleared after leaving server", d.getElementById("code").textContent === "" && !d.documentElement.innerHTML.includes("HANDICAP1-"));
  }
  // 잠금 때 textarea도
  {
    const st = { value: base("local"), runs: 0, after: base("server") };
    const { d } = await load(st);
    d.getElementById("switch").click(); await sleep(30);
    check("overlay disables #code-in", d.getElementById("busy").classList.contains("on") && d.getElementById("code-in").disabled);
    await sleep(700);
    check("code-in re-enabled after overlay", !d.getElementById("code-in").disabled);
  }
  // XSS: addr / servers / run_tail
  {
    const evil = '<img src=x onerror="window.__pwn=1">';
    const st = { value: workerBase({ state: "running", addr: evil, run_tail: evil }) };
    const { d, w } = await load(st);
    check("xss addr/run_tail: no img", d.querySelectorAll("img").length === 0);
    check("xss run_tail: text + bdi", d.getElementById("w-state").textContent.includes(evil) && [...d.querySelectorAll("#w-state bdi")].some((b) => b.textContent === evil));
    check("xss addr: text + bdi", d.getElementById("w-detail").textContent === evil && [...d.querySelectorAll("#w-detail bdi")].some((b) => b.textContent === evil));
    st.value = workerBase({ state: "connecting", servers: [evil, "10.0.0.8:8093"], addr: null });
    d.dispatchEvent(new w.Event("visibilitychange")); await sleep(30);
    check("xss servers: no img, text + bdi", d.querySelectorAll("img").length === 0 && d.getElementById("w-detail").textContent === evil + ", 10.0.0.8:8093" && [...d.querySelectorAll("#w-detail bdi")].some((b) => b.textContent === evil));
    check("xss servers: handler never ran", w.__pwn === undefined);
  }
  // 잠금 뒤에도 읽기 전용 명령 칸은 선택 가능해야 한다(복사 대체 경로)
  {
    const st = { value: base("local"), runs: 0, after: base("server") };
    const { d } = await load(st);
    d.getElementById("switch").click(); await sleep(800);
    const cmd = d.getElementById("cmd");
    check("local→server: #cmd has command and is not disabled", cmd && cmd.value === "CMD 192.168.0.12 macos 8093" && cmd.disabled === false);
  }
  {
    const st = { value: workerBase({ state: "excluded" }), reconnectFail: "재접속 실패" };
    const { d } = await load(st);
    d.getElementById("w-reconnect").click(); await sleep(700);
    check("reconnect failure text", d.getElementById("err").textContent === "다시 접속하지 못했습니다: 재접속 실패");
  }
  console.log(fails === 0 ? "ALL PASS" : `${fails} FAIL`);
  process.exit(fails ? 1 : 0);
})();
