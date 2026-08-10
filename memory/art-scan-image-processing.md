---
name: art-scan-image-processing
description: "How to normalize photos of pencil/charcoal artwork into clean \"scans\" without ruining them"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 28f49869-cd3e-435c-ab90-b90f7daa5858
---

When making photographed 素描/速写 artwork look like clean scans, the user's guidance:

- **Tone unification must be GENTLE and texture-preserving.** Aggressive levels/contrast "吃掉素描画丰富的灰色层次质感" (eats the rich pencil gray gradations). Keep it soft: white-balance the paper neutral, map paper (~90th pct) to a soft white (~242, not 255), only sink the darkest ~1%, no hard S-curve, light desaturation only (preserve red construction lines), gentle unsharp.
- **Crop ONLY images with software edges** (app screenshots / status bars / UI chrome) — strip the chrome to keep just the photo. Do NOT auto-crop or perspective-warp real photos: blind detection ruins clean drawings (clips heads), mis-crops, or leaves desk clutter. Detect screenshots reliably via **runs of exactly-identical pixels** (UI is flat-filled; photos have sensor noise → no exact runs).

**Why:** these photos come from mixed sources (clean shots, "作业批改" app screenshots, tilted-on-desk). The goal is a unified scanned-artwork look while keeping every drawing's real quality intact.

**How to apply:** always keep originals untouched as the one-click revert path; validate tone on samples by eye before batch-running. Reusable code lived in scratchpad `work/` (imgproc.py=scannerize, cropui.py=crop_software_edges). See [[deck-review-workflow]].
