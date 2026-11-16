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
    self_worker: true, self_worker_busy: false, self_worker_unavailable: null,
    notices: { port_changed: null, save_failed: false, self_worker_excluded: false, config_warning: false, start_error: null },
    app_url: "http://127.0.0.1:5555/", ips_public_fallback: false,
  };
}

// state: { value, runs, after, switchFail, failSetsStartError, roleStateFailures }
async function load(state, opts = {}) {
  const calls = [];
  const vc = new VirtualConsole();
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
          if (cmd === "active_run_count") return Promise.resolve(state.runs || 0);
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
          return Promise.reject("unknown " + cmd);
        },
      };
    },
  });
  await sleep(50);
  return { dom, w: dom.window, d: dom.window.document, calls };
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
    check("port notice", noticeTexts(d).includes("부하기 접속 포트 8081을 다른 프로그램이 쓰고 있어 8093로 열었습니다 — 부하기들에 새 명령을 주세요"));
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
    st.value.self_worker = false; st.value.self_worker_unavailable = "PC 이름을 읽지 못해 쓸 수 없습니다"; st.value.server_os = "linux"; st.value.grpc_port = 8081;
    const { d } = await load(st);
    check("unavailable disabled + reason", d.getElementById("sw").disabled && !d.getElementById("sw").checked && d.getElementById("sw-note").textContent === "PC 이름을 읽지 못해 쓸 수 없습니다");
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
  console.log(fails === 0 ? "ALL PASS" : `${fails} FAIL`);
  process.exit(fails ? 1 : 0);
})();
