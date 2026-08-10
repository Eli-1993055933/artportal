---
name: deck-review-workflow
description: The pipeline for turning student-artwork PPTX folders into polished reviewed decks
metadata: 
  node_type: memory
  type: project
  originSessionId: 28f49869-cd3e-435c-ab90-b90f7daa5858
---

Recurring task: a folder of per-student `.pptx` (each = a week of 素描/速写 homework, one slide per day with 1–5 artwork photos + a date textbox) → polished "已点评" review decks.

Deliverable spec the user wanted (2026-07, done):
1. Make a `已点评` output subfolder.
2. Redesign every deck clean/restrained: **cover** (title `南海艺高{name}同学成功轨迹画室2026暑期集训点评` + subtitle `三组老师：张智涵`), **per-day pages** (left critique column + right gallery grid, subtle matting), **~800-字 weekly summary** page.
   - **Summary rule (user emphasized 2026-07-19): every student's summary MUST be uniquely worded — same narrative BEATS/structure only, but distinct sentences, openings, endings, and examples personalized to that student's actual week. NEVER a name-swapped template.** The shared beats to cover: shy at first→always diligent→opens up & turns out to have ideas→listens to & executes the teacher's requirements→takes good notes→comes up to watch demos at key moments→asks questions after class→visibly improves daily. Gender-unknown → no 他/她/男生/女生, use the name or 这孩子/这名同学. This is now GENERATED per-student inside critique_workflow.js (a `summary` field alongside the per-page critiques); `content.py`'s template is only a fallback.
3. Process images gently (see [[art-scan-image-processing]]).
4. Per-page critique ≤200字 in a 央美附中 素描速写基础部 teacher voice — must reflect the ACTUAL drawing (view thumbnails; identify 石膏像/静物/速写 etc.).
5. Output as `{原名}2026.7.17(已点评).pptx`.

**Reusable tooling is PERSISTED at `D:\画室点评工具\`** (survives across sessions — do NOT rebuild from scratch). `scripts/` has phaseA.py, build_all.py, critique_workflow.js, save_critiques.py, preview_all.py + modules (imgproc, cropui, pipeline, deckbuild, topptx, content). Playbook: `使用说明与经验总结.md`; paste-prompt: `下周提示词.txt`. Run order (~10 min target): `python phaseA.py "<folder>"` → Workflow with critique_workflow.js + args from `_work/<folder>/phaseB_args.json` → `python save_critiques.py "<folder>" "<wf output file>"` → `python build_all.py "<folder>" "<date>"` → optional `preview_all.py`. phaseA is now threaded + auto-repairs corrupt pptx + auto-relabels undated decks + flags placeholders; build_all auto-skips non-artwork pages. Critique step is the only real time cost (~5-6 min, opus); can drop to `model:'sonnet'` in the .js for speed.

Approach that worked: Python (python-pptx build-from-scratch, Pillow+OpenCV for images), shared layout spec rendered to BOTH pptx and a PIL preview (LibreOffice absent → PIL preview + `PYTHONUTF8=1 validate.py` was the QA). Fonts on this machine: 华文中宋 (serif display), 微软雅黑 (body), 等线 (muted). Gotchas: corrupt PNG blocks `Presentation()` open (auto-repaired now); Workflow `args` may arrive as a JSON string (parse defensively — already handled in the .js); avoid gendered pronouns for students. Need pip: Pillow python-pptx numpy opencv-python-headless lxml defusedxml. See [[user-art-teacher]].
