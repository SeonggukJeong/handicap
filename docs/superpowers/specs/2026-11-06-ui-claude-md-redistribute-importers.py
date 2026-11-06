import re, os, sys, pathlib
root = pathlib.Path(sys.argv[1])
moved = set("RunDialog LoadModelFields DataBindingPanel EnvironmentPicker CriteriaFields StepCriteriaFields StageCurvePreview LoadShapePreview loadShapes loadModel profileForm openLoopChecks runSummary sizing SlotSizingHelper VuSizingHelper WorkerSizingHelper ScheduleForm TriggerBuilder triggerCron ScheduleEventTimeline RunVuCell RunListControls".split())
comp = (root/"components").resolve()
movedpaths = {str(comp/n) for n in moved}
movedfiles = set()
for n in moved:
    for p in comp.glob(n+".*"): movedfiles.add(str(p))
    for p in (comp/"__tests__").glob(n+".*"): movedfiles.add(str(p))
movedfiles.add(str(comp/"__tests__"/"scaleVuStages.test.ts"))
rx = re.compile(r"""(['"`])(\.\.?/[^'"`\n]*)\1""")
for p in sorted(root.rglob("*")):
    if p.suffix not in (".ts",".tsx",".js",".jsx",".css",".json",".md",".snap",".html"): continue
    if str(p.resolve()) in movedfiles: continue
    t = p.read_text(errors="ignore")
    for m in rx.finditer(t):
        spec = m.group(2)
        tgt = os.path.normpath(str(p.parent.resolve()/spec))
        tgt_noext = re.sub(r"\.(tsx?|jsx?)$","",tgt)
        if tgt_noext in movedpaths:
            line = t[:m.start()].count("\n")+1
            ctx = t.split("\n")[line-1].strip()[:120]
            print(p.relative_to(root), line, ctx)
