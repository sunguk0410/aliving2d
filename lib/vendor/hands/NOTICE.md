# MediaPipe Hands (vendored)

- Package: `@mediapipe/hands` 0.4.1675469240 (npm)
- License: Apache License 2.0 — https://www.apache.org/licenses/LICENSE-2.0
- Copyright: Google LLC

Used by the editor's camera tracking to follow the wrists (avatar arms).
Only the SIMD build and the lite landmark model (`modelComplexity: 0`) are
bundled so that tracking works offline and never changes version unexpectedly.
Anything else is loaded from the same pinned version on
https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/.
