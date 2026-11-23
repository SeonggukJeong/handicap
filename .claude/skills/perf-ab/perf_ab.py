#!/usr/bin/env python3
"""Worker CPU A/B for handicap: a base git ref against the working tree (head).

Builds release worker + controller for both sides, starts one controller per side
whose --worker-bin is a `/usr/bin/time -l` wrapper, runs the same closed-loop
scenario alternately (base, head, head, base, ...) against a zero-delay responder
and reports CPU per request = (user + sys of the worker processes) / request count.

Usage (from the worktree / checkout that holds the change):
  python3 .claude/skills/perf-ab/perf_ab.py --base-ref master
  python3 .claude/skills/perf-ab/perf_ab.py --base-ref master --rounds 8 --vus 50 --seconds 20
  python3 .claude/skills/perf-ab/perf_ab.py --base-ref master --scenario my.yaml

Options:
  --base-ref REF    git ref to compare against (required)
  --head-dir DIR    checkout holding the change (default: current directory)
  --rounds N        measured rounds per side (default 6)
  --warmup N        extra leading rounds per side, run but not counted (default 1)
  --vus N           closed-loop VUs (default 50)
  --seconds N       run length (default 20)
  --scenario FILE   scenario YAML; `{RESPONDER}` is replaced by the responder URL
                    (default: one GET step, no think time)
  --work DIR        scratch dir for base source/target, DBs, logs
                    (default /tmp/perf-ab-<head dir name>); kept between invocations
                    so the base build is reused
  --port-shift N    add N to every port (defaults: responder 19997, base 18099/18098,
                    head 18199/18198)
  --skip-build      reuse binaries from the previous invocation as they are
  --allow-errors    do not treat `errors` or non-200 statuses as a problem (a failed run
                    or zero requests still is); for measuring the cost of failure paths

Exit code: 0 measured, 1 a run was not clean (non-200, errors, failed run), 2 setup failed.
macOS only as written (`/usr/bin/time -l` output format).
"""
import argparse
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import time
import urllib.request

SKILL_DIR = os.path.dirname(os.path.abspath(__file__))
RESPONDER = os.path.join(os.path.dirname(SKILL_DIR), "live-verify", "responder.py")
BUILD = ["cargo", "build", "--release", "-p", "handicap-worker", "--bin", "worker",
         "-p", "handicap-controller", "--bin", "controller"]
ARCHIVE_PATHS = ["Cargo.toml", "Cargo.lock", "rust-toolchain.toml", "crates"]
DEFAULT_SCENARIO = """version: 1
name: perf-ab
steps:
  - id: 01J000000000000000000000K1
    type: http
    name: ping
    request:
      method: GET
      url: {RESPONDER}/
"""
TIME_RE = re.compile(r"([\d.]+) real\s+([\d.]+) user\s+([\d.]+) sys")


def die(msg):
    print("perf-ab: " + msg, file=sys.stderr)
    sys.exit(2)


def run(cmd, **kw):
    print("$ " + " ".join(cmd), flush=True)
    r = subprocess.run(cmd, **kw)
    if r.returncode != 0:
        die("command failed (exit %d): %s" % (r.returncode, " ".join(cmd)))
    return r


def out(cmd, cwd):
    return subprocess.run(cmd, cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()


def http(method, url, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read() or b"null")


def port_busy(port):
    with socket.socket() as s:
        s.settimeout(0.5)
        return s.connect_ex(("127.0.0.1", port)) == 0


def cpu_lines(path):
    with open(path, errors="replace") as f:
        return TIME_RE.findall(f.read())


def build_base(head_dir, ref, work):
    sha = out(["git", "rev-parse", "--verify", ref + "^{commit}"], head_dir)
    src, target, stamp = os.path.join(work, "base-src"), os.path.join(work, "base-target"), os.path.join(work, "base-sha")
    built = os.path.exists(os.path.join(target, "release", "worker")) and os.path.exists(os.path.join(target, "release", "controller"))
    if built and os.path.exists(stamp) and open(stamp).read().strip() == sha:
        print("base %s already built" % sha[:12])
        return sha, target
    shutil.rmtree(src, ignore_errors=True)
    os.makedirs(src)
    tar = os.path.join(work, "base.tar")
    run(["git", "archive", "--format=tar", "-o", tar, sha] + ARCHIVE_PATHS, cwd=head_dir)
    run(["tar", "-xf", tar, "-C", src])
    os.remove(tar)
    run(BUILD, cwd=src, env=dict(os.environ, CARGO_TARGET_DIR=target))
    with open(stamp, "w") as f:
        f.write(sha)
    return sha, target


class Side:
    def __init__(self, name, target, rest, grpc, work):
        self.name, self.rest, self.grpc = name, rest, grpc
        self.base = "http://127.0.0.1:%d" % rest
        self.worker = os.path.join(target, "release", "worker")
        self.controller = os.path.join(target, "release", "controller")
        self.log = os.path.join(work, name + "-controller.log")
        self.db = os.path.join(work, name + ".db")
        self.wrapper = os.path.join(work, "worker-" + name + ".sh")
        self.proc = None
        self.rows = []  # (rps, cpu_us_per_req)

    def start(self, work):
        for p in (self.worker, self.controller):
            if not os.path.exists(p):
                die("missing binary " + p)
        with open(self.wrapper, "w") as f:
            f.write('#!/bin/sh\nexec /usr/bin/time -l "%s" "$@"\n' % self.worker)
        os.chmod(self.wrapper, 0o755)
        for suffix in ("", "-shm", "-wal"):
            if os.path.exists(self.db + suffix):
                os.remove(self.db + suffix)
        logf = open(self.log, "w")
        self.proc = subprocess.Popen(
            [self.controller, "--db", self.db, "--rest", "127.0.0.1:%d" % self.rest, "--grpc", "127.0.0.1:%d" % self.grpc,
             "--worker-bin", self.wrapper, "--scheduler-disabled"],
            cwd=work, stdout=logf, stderr=subprocess.STDOUT)

    def wait_ready(self):
        for _ in range(60):
            if self.proc.poll() is not None:
                die("%s controller exited (see %s)" % (self.name, self.log))
            try:
                http("GET", self.base + "/api/scenarios")
                return
            except OSError:
                time.sleep(0.25)
        die("%s controller not ready (see %s)" % (self.name, self.log))


def one_run(side, sid, vus, secs, allow_errors=False):
    """Returns (count, rps, cpu_seconds, problems)."""
    before = len(cpu_lines(side.log))
    rid = http("POST", side.base + "/api/runs",
               {"scenario_id": sid, "profile": {"vus": vus, "duration_seconds": secs}, "env": {}})["id"]
    while True:
        st = http("GET", side.base + "/api/runs/" + rid)
        if st["status"] in ("completed", "failed", "aborted"):
            break
        time.sleep(1)
    # the worker's `time` line lands after the run turns terminal; a fanned-out run prints one per worker
    seen, stable = before, 0
    for _ in range(40):
        n = len(cpu_lines(side.log))
        stable = stable + 1 if (n == seen and n > before) else 0
        seen = n
        if stable >= 2:
            break
        time.sleep(0.5)
    lines = cpu_lines(side.log)[before:]
    problems = []
    if st["status"] != "completed":
        problems.append("status=%s message=%s" % (st["status"], st.get("message")))
    if not lines:
        problems.append("no `time` line in " + side.log)
        return 0, 0.0, 0.0, problems
    rep = http("GET", side.base + "/api/runs/" + rid + "/report")
    s = rep["summary"]
    statuses = {}
    for step in rep.get("steps", []):
        for code, n in (step.get("status_counts") or {}).items():
            statuses[code] = statuses.get(code, 0) + n
    if not allow_errors:
        if s["errors"]:
            problems.append("errors=%s" % s["errors"])
        if set(statuses) != {"200"}:
            problems.append("status codes %s" % statuses)
    if not s["count"]:
        problems.append("no requests")
    cpu = sum(float(u) + float(k) for _, u, k in lines)
    return s["count"], s["rps"], cpu, problems


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--base-ref", required=True)
    ap.add_argument("--head-dir", default=".")
    ap.add_argument("--rounds", type=int, default=6)
    ap.add_argument("--warmup", type=int, default=1)
    ap.add_argument("--vus", type=int, default=50)
    ap.add_argument("--seconds", type=int, default=20)
    ap.add_argument("--scenario")
    ap.add_argument("--work")
    ap.add_argument("--port-shift", type=int, default=0)
    ap.add_argument("--skip-build", action="store_true")
    ap.add_argument("--allow-errors", action="store_true")
    a = ap.parse_args()
    if sys.platform != "darwin":
        die("needs macOS `/usr/bin/time -l`")
    head_dir = os.path.abspath(a.head_dir)
    if not os.path.exists(os.path.join(head_dir, "Cargo.toml")):
        die("--head-dir is not a checkout root: " + head_dir)
    work = os.path.abspath(a.work or "/tmp/perf-ab-" + os.path.basename(head_dir))
    os.makedirs(work, exist_ok=True)
    ports = {k: v + a.port_shift for k, v in
             {"responder": 19997, "base_rest": 18099, "base_grpc": 18098, "head_rest": 18199, "head_grpc": 18198}.items()}
    busy = [k for k, p in ports.items() if port_busy(p)]
    if busy:
        die("ports in use (%s) — not mine to kill; rerun with --port-shift N" % ", ".join("%s=%d" % (k, ports[k]) for k in busy))

    head_sha = out(["git", "rev-parse", "HEAD"], head_dir)
    dirty = out(["git", "status", "--porcelain", "-uno"], head_dir)
    if a.skip_build:
        base_sha = open(os.path.join(work, "base-sha")).read().strip()
        base_target = os.path.join(work, "base-target")
    else:
        base_sha, base_target = build_base(head_dir, a.base_ref, work)
        run(BUILD, cwd=head_dir)
    head_target = os.environ.get("CARGO_TARGET_DIR") or os.path.join(head_dir, "target")
    print("base = %s (%s)   head = %s%s" % (base_sha[:12], a.base_ref, head_sha[:12], " + uncommitted changes" if dirty else ""))
    if base_sha == head_sha and not dirty:
        print("NOTE: base and head are the same commit — this is an A/A run (shows the noise floor only)")

    sides = {"base": Side("base", base_target, ports["base_rest"], ports["base_grpc"], work),
             "head": Side("head", head_target, ports["head_rest"], ports["head_grpc"], work)}
    responder_url = "http://127.0.0.1:%d" % ports["responder"]
    yaml_text = (open(a.scenario).read() if a.scenario else DEFAULT_SCENARIO).replace("{RESPONDER}", responder_url)
    ncpu = os.cpu_count() or 1
    load0 = os.getloadavg()[0]
    note = ""
    if load0 > ncpu * 0.25:
        note = ("  (just built — the 1-minute average still carries the build; judge by the spread below)" if not a.skip_build
                else "  WARNING: machine is busy — numbers will wobble")
    print("load average before: %.2f (%d cores)%s" % (load0, ncpu, note))
    if a.allow_errors:
        print("allow-errors: on")

    procs, dirty_runs = [], []
    try:
        procs.append(subprocess.Popen([sys.executable, RESPONDER, str(ports["responder"]), "0"],
                                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
        for s in sides.values():
            s.start(work)
            procs.append(s.proc)
        for s in sides.values():
            s.wait_ready()
        time.sleep(0.5)
        if procs[0].poll() is not None:
            die("responder exited")
        sids = {k: http("POST", s.base + "/api/scenarios", {"yaml": yaml_text})["id"] for k, s in sides.items()}
        total = a.warmup + a.rounds
        for i in range(total):
            for k in (("base", "head") if i % 2 == 0 else ("head", "base")):
                cnt, rps, cpu, problems = one_run(sides[k], sids[k], a.vus, a.seconds, a.allow_errors)
                us = cpu / cnt * 1e6 if cnt else float("nan")
                tag = "warmup" if i < a.warmup else "round %d" % (i - a.warmup + 1)
                print("%-8s %-4s count=%d rps=%.0f cpu=%.2fs cpu/req=%.2f us%s" %
                      (tag, k, cnt, rps, cpu, us, "  !! " + "; ".join(problems) if problems else ""), flush=True)
                if problems:
                    dirty_runs.append((tag, k, problems))
                elif i >= a.warmup:
                    sides[k].rows.append((rps, us))
    finally:
        for p in procs:
            if p.poll() is None:
                p.terminate()
        for p in procs:
            try:
                p.wait(timeout=5)
            except subprocess.TimeoutExpired:
                p.kill()

    print()
    stats = {}
    for k, s in sides.items():
        if not s.rows:
            print("%-4s no clean rounds" % k)
            continue
        us = [r[1] for r in s.rows]
        mean = sum(us) / len(us)
        stats[k] = (mean, min(us), max(us), sum(r[0] for r in s.rows) / len(s.rows))
        print("%-4s cpu/req mean %.2f us (min %.2f, max %.2f, spread %.1f%%)   rps mean %.0f   n=%d" %
              (k, mean, min(us), max(us), (max(us) - min(us)) / mean * 100, stats[k][3], len(us)))
    load1 = os.getloadavg()[0]
    print("load average after: %.2f" % load1)
    if len(stats) == 2:
        b, h = stats["base"], stats["head"]
        print("head vs base: cpu/req %+.1f%%   rps %+.1f%%" % ((h[0] - b[0]) / b[0] * 100, (h[3] - b[3]) / b[3] * 100))
        overlap = h[1] <= b[2] and b[1] <= h[2]
        if min(len(s.rows) for s in sides.values()) < 3:
            print("too few clean rounds to judge wobble (need 3+ per side) — treat the difference as unknown")
        else:
            print("ranges %s" % ("OVERLAP — the difference is inside run-to-run wobble; do not report it as a change"
                                  if overlap else "DO NOT overlap — the difference is larger than run-to-run wobble"))
    print("logs: %s/{base,head}-controller.log" % work)
    if dirty_runs:
        print("NOT CLEAN: %d run(s) excluded — %s" % (len(dirty_runs), dirty_runs))
        sys.exit(1)


if __name__ == "__main__":
    main()
