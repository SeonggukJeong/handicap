# 배포 / K8s (`deploy/`) 함정

이 파일은 `deploy/` 파일을 건드릴 때 자동 로드되는 중첩 CLAUDE.md다. 프로젝트 전역 규칙·git 토폴로지·검증 훅·일하는 모드는 루트 `CLAUDE.md` 참고. 엔진/컨트롤러/워커/UI 함정은 각 디렉토리의 CLAUDE.md.

kind 단일 노드 + Helm chart 1개로 controller + worker가 K8s Job 로 동작. `--worker-mode {subprocess,kubernetes}`. ADR-0019(dispatcher 추상화).

## Helm chart (`deploy/helm/handicap`)

- **`{Release.Name}-{Chart.Name}-controller` Service 이름 collision** (Slice 6): 표준 `handicap.fullname` helper 는 `release-chart` 를 쓰므로, release 이름을 chart 이름과 같게 `handicap` 으로 잡으면 controller Service 이름이 `handicap-handicap-controller` 가 된다. README/runbook 에서 무심코 `handicap-controller` 로 적으면 port-forward 가 조용히 fail. 두 가지 다 명시: release ≠ chart name 으로 가거나, fullname 그대로 쓰거나. Slice 6 은 후자.
- **Helm RWO PVC 는 `strategy.type: Recreate` 필수** (Slice 6): 기본 RollingUpdate 로 가면 새 pod 가 PVC 를 attach 하지 못해(ReadWriteOnce 가 이미 old pod 한테 잡힘) deploy 가 deadlock. `templates/controller-deployment.yaml` 에 인라인 주석으로 이유를 박아뒀다 — 무심결에 RollingUpdate 로 되돌리는 회귀 방지.
- **`helm get manifest | grep -A1 'kind: Deployment$'` 는 `-A2` 가 맞음** (Slice 6): `scripts/deploy-kind.sh` 1차 구현이 plan 의 한 줄짜리 awk pipe 를 그대로 베꼈는데, 렌더된 chart 의 Deployment 블록은 `kind: Deployment\nmetadata:\n  name: …` 3줄 구조라 `-A1` 로는 `name:` 라인이 안 잡혀 wait target 이 빈 문자열. 항상 freshly rendered chart 로 dry-run 해서 grep 출력 확인하고 커밋.
- **Snapshot test 는 label/format drift 도 잡는다** (Slice 6): `deploy/helm/handicap/tests/snapshot_test.sh` 가 default + custom values 두 시나리오로 rendered manifest 비교. 1차 run 에서 `_helpers.tpl` 의 표준 label set 에 `app.kubernetes.io/instance` 가 빠져 있었는데 snapshot diff 가 바로 잡았다. **의도된 변경 후엔 `UPDATE_SNAPSHOTS=1 ./snapshot_test.sh` 로 재생성** — 안 하면 다음 PR 의 CI 가 빨갛게.

## Dockerfile / 빌드

- **Dockerfile 에서 CMD/ENTRYPOINT 둘 다 의도적으로 미설정** (Slice 6): 멀티-바이너리(controller + worker) 이미지라 default 가 있으면 "controller container 가 worker binary 를 실행" 같은 사고가 가능. 둘 다 비우고 모든 consumer(Helm Deployment, `build_job_spec` 의 K8s Job spec)가 `command:` 를 명시하도록 강제. 새 consumer 추가 시도 같은 컨벤션.
- **Vite + Monaco + Recharts 빌드는 Docker 안에서 Node OOM** (Slice 6): `pnpm build` 의 default V8 old-space limit(≈2GiB)가 우리 UI 번들(Monaco lazy chunk + Recharts + React Flow)에는 부족해 multi-stage Dockerfile 의 UI 빌드 스테이지가 OOM kill. `ENV NODE_OPTIONS=--max-old-space-size=4096` 한 줄로 해소. macOS 호스트의 `pnpm build` 가 통과하는 건 Node 가 호스트 메모리 압력에 따라 동적으로 더 잡기 때문 — container cgroup limit 안에선 다르다.

## kind 점검 / port-forward

- **여러 워크트리에서 `kubectl port-forward` IPv4/IPv6 충돌** (Slice 6): 다른 워크트리의 `cargo run --bin controller` 가 `127.0.0.1:18080` 을 점유한 상태로 `kubectl port-forward 18080:8080` 을 띄우면, kubectl 은 IPv4 bind 가 EADDRINUSE 라 silent 하게 `[::1]:18080` 만 listen 한다. 그 후 `curl 127.0.0.1:18080/api/scenarios` 는 잘못된 프로세스(다른 worktree 의 controller, 다른 DB)에 도달해 "no such table: scenarios" 같은 가짜 schema 에러. `lsof -i :18080` 으로 점유자 확인하고 stray `target/*/controller` 죽이는 게 표준.
- **공유 endpoint 의 health check 는 forward 정합성을 증명하지 못한다** (Slice 6): `kubectl port-forward svc/wiremock 9001:8080` 후 `curl -sf …/__admin/health && echo OK` 로 끝내면 거짓 안심 — 9001 에서 **무엇이든** 200 을 주면(stale forward, 9001 선점 프로세스) OK 가 찍힌다. 표준: (a) `lsof -ti tcp:9001 | xargs -r kill` 로 stale 정리 → (b) forward 의 `Forwarding from 127.0.0.1:9001` 줄 확인 → (c) health 가 아니라 등록 직후 `…/__admin/mappings` 를 read 해서 방금 넣은 stub 이 보이는지로 검증(read/write round-trip 이 유일하게 믿을 신호). 디버깅 중엔 `-s` 빼고 `-sS`/`-sf` 로 connection error 노출. (`docs/dev/slice-6-manual-check.md` 참고.)
- **타겟 pod 이 재생성되면 `kubectl port-forward` 도 같이 죽는다** (Slice 6): forward 는 특정 pod 에 묶여 있어서 재배포(`just deploy-kind`/`helm upgrade`)·`kubectl delete pod`·eviction 으로 pod 이름이 바뀌면 옛 forward 가 조용히 종료. 증상: 멀쩡히 쓰던 UI(`localhost:8080`)·wiremock(`localhost:9001`)이 "갑자기" 안 뜸 — pod 은 `Running` 인데 8080 에 listen 없음(`lsof -iTCP:8080 -sTCP:LISTEN` 빈 결과). 코드/빌드 문제 아님. **pod 을 한 번이라도 건드렸으면 controller·wiremock forward 를 무조건 재기동**(`kubectl -n handicap port-forward svc/handicap-handicap-controller 8080:8080 &`).
- **kind 점검 시 wiremock은 두 주소로 같은 pod를 친다** (Slice 6): stub 등록은 호스트 port-forward `localhost:9001`, worker(in-cluster Job)는 RunDialog Env `BASE_URL`로 cluster DNS `http://wiremock.handicap-test.svc.cluster.local:8080`. pod 안에서 `localhost`는 자기 loopback이라 worker엔 `:9001`이 안 통함. (로컬 dev subprocess 모드면 worker가 호스트라 `:9001`이 맞아 더 헷갈림.) 상세 → `docs/dev/slice-6-manual-check.md`.

## 멀티 워커 Job (A3c)

- **워커 Job 의 topologySpread/anti-affinity 는 반드시 soft** (A3c): `build_job_spec` 의 `topologySpreadConstraints.whenUnsatisfiable=ScheduleAnyway` + `podAntiAffinity.preferredDuringScheduling...`. **hard(`DoNotSchedule`/`required...`)로 바꾸면 단일 노드 kind 에서 2번째 워커 Pod 가 영영 Pending → 등록 watchdog(60s)이 run 을 Failed 로 → e2e-kind 깨짐.** 멀티 노드 prod 는 soft 라도 spread 됨.
- **워커 `WorkerResources::default()` 는 Guaranteed QoS(req==limit)지만 크기는 modest(250m/256Mi)** (A3c): requests==limits 가 CFS 스로틀 방지의 충실도 레버(spec §7.3)이나, 단일 노드/2-vCPU CI kind 에 N>1 Indexed Pod 가 전부 스케줄+등록돼야 e2e 통과하므로 크기를 작게. **프로덕션 고처리량은 worker cpu/mem 의 Helm values 배선(로드맵 §B full-plumbing)으로 올린다** — 현재 노출되는 워커 Helm value 는 `worker.capacityVus`(N 레버)뿐. equality 가 invariant, 크기 아님.
- **e2e-kind N>1 는 `--set worker.capacityVus=25` 로 강제** (A3c): 기본 capacity 2000 → 50 VUs 가 N=1. e2e(스크립트 + GH 워크플로 둘 다)가 capacity 를 낮춰 N=2 fan-out 을 만들고 Job `completionMode=Indexed`/`completions=2`/`succeeded=2` 를 단언(`.status.succeeded` 는 Pod exit 보다 지연돼 bounded poll 로 대기). 워크플로는 `scripts/e2e-kind.sh` 미경유 인라인 helm install 이라 **양쪽 다** 고쳐야 함.

## K8s 테스트 격리

- **`dispatcher_kubernetes_test` 는 `slice6-k8s` feature 로 격리** (Slice 6): 진짜 kube context 를 요구하는 integration 테스트는 `#![cfg(feature = "slice6-k8s")]` 로 가둬서 일상 `cargo test --workspace` 가 kube 없이도 통과. 진짜 K8s 경로 회귀 방지는 (a) `build_job_spec` 의 순수 단위 테스트(컨트롤러), (b) GitHub Actions `e2e-kind.yml` 의 kind 클러스터 e2e 두 층 — 후자가 dispatcher trait 을 controller 전체 흐름 안에서 검증.
