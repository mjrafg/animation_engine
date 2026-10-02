# Media performance verification report

Date: 2026-10-02. Base: `main` at `058f804c3844723b54802bcce2d54d88e607b153`.
Verified code: `fix/media-perf` at `983d468`; the later report commit changes documentation/evidence only.

Preparation now lets FFmpeg choose encoder threads unless `threads` (1–256) is supplied. Decoder thread settings remain unchanged. Random reads and sequential restarts seek to an indexed keyframe, then select the exact integer presentation timestamp. Formatting and the named issue-code helper are isolated in the third commit.

## 1. Environment

All runtime commands below used this environment:

```sh
export PATH=/opt/node-v22.23.2-linux-x64/bin:$PATH
export FFMPEG_PATH=/usr/bin/ffmpeg
export FFPROBE_PATH=/usr/bin/ffprobe
```

Commands: `node -v`, `nproc`, the first CPU model from `/proc/cpuinfo`, the engine's `ffmpegPath()`, and the first line of that binary's `-version` output. Actual combined output:

```text
v22.23.2
8
AMD EPYC 9354P 32-Core Processor
Engine FFmpeg: /usr/bin/ffmpeg
ffmpeg version 6.1.1-3ubuntu5 Copyright (c) 2000-2023 the FFmpeg developers
```

The engine actually used the system FFmpeg above, selected explicitly through `FFMPEG_PATH`. The bundled static binary is absent in this installation. Eight CPUs are available to this process; the model name describes the host processor.

## 2. Commits

`git log --oneline main..fix/media-perf` at the verified code revision:

```text
983d468 style(media): format compositing code and name issue mapping
bc60411 perf(media): seek to keyframes before exact frame selection
c794a50 perf(media): let FFmpeg choose preparation threads
```

`git diff --stat main..fix/media-perf` at the same revision:

```text
 README.md                                          | 217 ++++---
 docs/VIDEO_COMPOSITING_REPORT.md                   |  28 +-
 examples/footage-proof/fixtures/fa.provenance.json |  15 +-
 examples/footage-proof/fixtures/ko.provenance.json |  15 +-
 examples/footage-proof/run.ts                      | 380 ++++++++++---
 integrations/elevenlabs/regenerate.ts              |  38 +-
 integrations/elevenlabs/timing.ts                  |  41 +-
 mcp/README.md                                      |  78 +--
 mcp/src/tools.ts                                   | 625 +++++++++++++++++----
 scripts/bench-seek.ts                              |  93 +++
 scripts/media-regression-hashes.ts                 |  20 +
 src/api/engine.ts                                  |  84 ++-
 src/api/operations.ts                              |  64 ++-
 src/api/tools.ts                                   |  87 ++-
 src/capabilities.ts                                |  52 +-
 src/engine/assets.ts                               |  36 +-
 src/engine/displayList.ts                          |  17 +-
 src/errors.ts                                      |  94 +++-
 src/media/frames.ts                                | 162 ++++--
 src/media/prepare.ts                               | 133 +++--
 src/media/process.ts                               |  74 ++-
 src/media/seek.ts                                  | 103 ++++
 src/public.ts                                      |  22 +-
 src/render/chunk-worker.ts                         |  43 +-
 src/render/chunks.ts                               | 109 ++--
 src/render/skia.ts                                 |  34 +-
 src/render/video.ts                                |  20 +-
 src/scene/path.ts                                  |  13 +-
 src/scene/schema.ts                                |  71 ++-
 src/scene/validate.ts                              | 107 ++--
 src/subtitles/encode.ts                            | 155 +++--
 src/subtitles/timing.ts                            | 170 ++++--
 src/timeline/evaluate.ts                           |  20 +-
 src/workspace/jobs.ts                              |  28 +-
 src/workspace/workspace.ts                         | 519 +++++++++++++----
 tests/compositing-audio.test.ts                    | 147 +++--
 tests/compositing.test.ts                          | 513 ++++++++++++-----
 tests/mcp/compositing.test.ts                      |  82 ++-
 tests/media-seek.test.ts                           | 102 ++++
 39 files changed, 3504 insertions(+), 1107 deletions(-)
```

These are the three implementation commits, one per requested item. The separate documentation commit contains this report, raw evidence, and the link from the original report; its own hash cannot appear in its committed contents. No executable code changed after the recorded verification.

## 3. Typecheck

Command: `npx tsc --noEmit`. Exit code: **0**. Full stdout/stderr was empty (the [raw output file](media-perf-evidence/final-typecheck.txt) is zero bytes).

## 4. Unit tests

Command: `npm test`. Exit code: **0**. Actual output:

```text

> animation-engine@1.1.0 test
> vitest run --exclude "tests/mcp/**"


 RUN  v5.0.1 /srv/tandem/projects/animation_engine/repo


 Test Files  12 passed (12)
      Tests  156 passed | 7 skipped (163)
   Start at  09:52:12
   Duration  12.97s (tests 79%, transform 12%, import 9%)
```

No failing tests. Seven tests were skipped by the existing Blender availability gates; this is not evidence that those Blender paths passed.

## 5. MCP tests

Command: `npm run test:mcp`. Exit code: **0**. Full output, including the build that this command invokes:

```text

> animation-engine@1.1.0 test:mcp
> npm run build:mcp && vitest run tests/mcp


> animation-engine@1.1.0 build:mcp
> esbuild mcp/src/main.ts --bundle --platform=node --format=esm --target=node20 --outfile=dist/video-engine-mcp.mjs --external:@napi-rs/canvas --external:sharp --external:ffmpeg-static --external:ffprobe-static --banner:js="import{createRequire as __cr}from\"node:module\";const require=__cr(import.meta.url);" && node -e "require('fs').mkdirSync('dist/blender',{recursive:true});require('fs').copyFileSync('src/scene3d/blender/engine3d.py','dist/blender/engine3d.py')" && esbuild src/render/chunk-worker.ts --bundle --platform=node --format=esm --target=node20 --outfile=dist/video-chunk-worker.mjs --packages=external


  dist/video-engine-mcp.mjs  1.6mb ⚠️

⚡ Done in 86ms

  dist/video-chunk-worker.mjs  101.1kb

⚡ Done in 15ms

 RUN  v5.0.1 /srv/tandem/projects/animation_engine/repo


 Test Files  5 passed (5)
      Tests  19 passed | 1 skipped (20)
   Start at  09:52:26
   Duration  4.56s (tests 84%, transform 10%, import 6%)
```

No failing tests. The skipped test requires Blender.

## 6. Regression hashes

Added [scripts/media-regression-hashes.ts](../scripts/media-regression-hashes.ts). It renders each requested scene at frames `0`, `floor(duration/3)`, `floor(2*duration/3)`, and `duration-1`, and hashes the returned RGBA bytes with SHA-256. Both checkouts use the same installed dependencies and their own committed scene/assets.

Commands (each exited **0**):

```sh
npx tsx scripts/media-regression-hashes.ts /tmp/animation-engine-media-main
npx tsx scripts/media-regression-hashes.ts /srv/tandem/projects/animation_engine/repo
```

The first checkout is detached at the base commit above. Exact values from both command outputs:

| Scene | Frame | `main` RGBA SHA-256 | `fix/media-perf` RGBA SHA-256 | Result |
| --- | ---: | --- | --- | --- |
| `examples/kitchen/scene.json` | 0 | `2bfbe06b5815421e36eefe831720843a62f22c52e373109b445e6d99cd190c36` | `2bfbe06b5815421e36eefe831720843a62f22c52e373109b445e6d99cd190c36` | Match |
| `examples/kitchen/scene.json` | 110 | `0c04cfb82022588d69789ba33fa1fc6689df6d105cff363b1b48848811bdc282` | `0c04cfb82022588d69789ba33fa1fc6689df6d105cff363b1b48848811bdc282` | Match |
| `examples/kitchen/scene.json` | 220 | `e66a22af6f5c5c911cb78102aa899a7b4475b72635ac0ad1e3c90c43f4bcc8a6` | `e66a22af6f5c5c911cb78102aa899a7b4475b72635ac0ad1e3c90c43f4bcc8a6` | Match |
| `examples/kitchen/scene.json` | 329 | `d7489c5f92e95426f405806b89a221d798c8dd31992b20de26caf7a97789fc99` | `d7489c5f92e95426f405806b89a221d798c8dd31992b20de26caf7a97789fc99` | Match |
| `examples/kitchen/scene.before-feedback.json` | 0 | `f2b61eb3d2fac26e3f94e8a6df345eb83685d3676034c1e42006920c32fdd983` | `f2b61eb3d2fac26e3f94e8a6df345eb83685d3676034c1e42006920c32fdd983` | Match |
| `examples/kitchen/scene.before-feedback.json` | 110 | `60ef625a4fb5b74c7be1ea5e837861d08a3ace8a62e540333609152b1ccb1f3c` | `60ef625a4fb5b74c7be1ea5e837861d08a3ace8a62e540333609152b1ccb1f3c` | Match |
| `examples/kitchen/scene.before-feedback.json` | 220 | `e66a22af6f5c5c911cb78102aa899a7b4475b72635ac0ad1e3c90c43f4bcc8a6` | `e66a22af6f5c5c911cb78102aa899a7b4475b72635ac0ad1e3c90c43f4bcc8a6` | Match |
| `examples/kitchen/scene.before-feedback.json` | 329 | `d7489c5f92e95426f405806b89a221d798c8dd31992b20de26caf7a97789fc99` | `d7489c5f92e95426f405806b89a221d798c8dd31992b20de26caf7a97789fc99` | Match |
| `examples/playground/scene.json` | 0 | `d7489c5f92e95426f405806b89a221d798c8dd31992b20de26caf7a97789fc99` | `d7489c5f92e95426f405806b89a221d798c8dd31992b20de26caf7a97789fc99` | Match |
| `examples/playground/scene.json` | 100 | `ba2b7a27094639fe99dcd82fc56cc7af182131f1a13a4a17968039c9b1e6fd62` | `ba2b7a27094639fe99dcd82fc56cc7af182131f1a13a4a17968039c9b1e6fd62` | Match |
| `examples/playground/scene.json` | 200 | `97bc88d60934b56f8e1bcff63ed94a4eff1bade0b678c373215d1da68f38e982` | `97bc88d60934b56f8e1bcff63ed94a4eff1bade0b678c373215d1da68f38e982` | Match |
| `examples/playground/scene.json` | 299 | `d7489c5f92e95426f405806b89a221d798c8dd31992b20de26caf7a97789fc99` | `d7489c5f92e95426f405806b89a221d798c8dd31992b20de26caf7a97789fc99` | Match |

**12 of 12 match.** Raw outputs: [main](media-perf-evidence/main-hashes.txt), [final](media-perf-evidence/final-hashes.txt).

## 7. Benchmark

Added [scripts/bench-seek.ts](../scripts/bench-seek.ts). It generates or reuses a shared 120-second, 1920×1080, 30 fps source under the system temp directory. Each label has its own prepared file and preparation timing. Reused preparations are explicitly labeled with their original timing. Both measurements below used **fresh** preparation of the same source.

Baseline command (exit **0**):

```sh
npx tsx scripts/bench-seek.ts --engine-root /tmp/animation-engine-media-main --label main
```

Full output:

```text
Generating shared 120s 1920x1080 30fps source (excluded from preparation timing)...
Engine: /tmp/animation-engine-media-main
Preparation: 199176.98 ms (fresh)
renderFrame(10): 415.26 ms
renderFrame(1800): 14103.08 ms
renderFrame(3590): 22987.30 ms
```

Final command (exit **0**):

```sh
npx tsx scripts/bench-seek.ts --label fix
```

Full output:

```text
Engine: /srv/tandem/projects/animation_engine/repo
Preparation: 64089.02 ms (fresh)
renderFrame(10): 568.46 ms
renderFrame(1800): 330.00 ms
renderFrame(3590): 348.51 ms
```

| Measurement | `main` (ms) | `fix/media-perf` (ms) | Main / fix |
| --- | ---: | ---: | ---: |
| Preparation | 199176.98 | 64089.02 | 3.11× |
| renderFrame(10) | 415.26 | 568.46 | 0.73× |
| renderFrame(1800) | 14103.08 | 330.00 | 42.74× |
| renderFrame(3590) | 22987.30 | 348.51 | 65.96× |

Source generation and `engine.prepare()` are outside the renderFrame timing. Preparation measures the complete `prepareVideoAsset` call, including output probing and hashing. These are wall-clock observations on this host, not universal speed guarantees. The first render is slower because it creates the packet index. Later reads reuse that index, and no longer decode all preceding video frames. The near-end render is now 0.35 seconds instead of 23 seconds. Benchmark runs did not overlap each other or the verification suites.

## 8. Seek exactness

Command: `npx vitest run tests/media-seek.test.ts --reporter=verbose`. Exit code: **0**. Full output:

```text

 RUN  v5.0.1 /srv/tandem/projects/animation_engine/repo

stdout | tests/media-seek.test.ts > long CFR barcode: exact keyframe boundaries, endpoints and restarts in random mode
long CFR random: 26 indices, zero mismatches

 ✓ tests/media-seek.test.ts > long CFR barcode: exact keyframe boundaries, endpoints and restarts in random mode 4771ms
stdout | tests/media-seek.test.ts > long CFR barcode: exact keyframe boundaries, endpoints and restarts in sequential mode
long CFR sequential: 26 indices, zero mismatches

 ✓ tests/media-seek.test.ts > long CFR barcode: exact keyframe boundaries, endpoints and restarts in sequential mode 1061ms
stdout | tests/media-seek.test.ts > fractional CFR barcode: exact frame selection with a non-default GOP
fractional CFR random: 13 indices, zero mismatches

stdout | tests/media-seek.test.ts > fractional CFR barcode: exact frame selection with a non-default GOP
fractional CFR sequential: 13 indices, zero mismatches

 ✓ tests/media-seek.test.ts > fractional CFR barcode: exact frame selection with a non-default GOP 2078ms
stdout | tests/media-seek.test.ts > random seek near the end stays within 3x the start plus 100ms scheduling tolerance
seek medians: start=75.22ms end=77.94ms; 10 indices, zero mismatches

 ✓ tests/media-seek.test.ts > random seek near the end stays within 3x the start plus 100ms scheduling tolerance 1025ms

 Test Files  1 passed (1)
      Tests  4 passed (4)
   Start at  09:57:49
   Duration  9.49s (tests 96%, import 2%, transform 2%)
```

The 12-bit barcode covers all 3,600 frames. Random and sequential modes each check 26 indices, including 0, 3599, keyframes and adjacent frames, backward jumps, and forward jumps beyond `maxForwardFrames`. A second fixture checks 13 indices in each mode at 30000/1001 fps with GOP 7. The timing test checks another 10 reads with the cache disabled. **88 frame selections checked, zero mismatches** (repeated indices count as separate selections). Two unasserted warm-up reads are excluded from that total.

The timing assertion uses five samples per region after warm-up and accepts `median(end) <= 3 * median(start) + 100 ms`, avoiding a fragile absolute limit on busy CI. This run measured 75.22 ms near the start and 77.94 ms near the end.

Exactness uses packet PTS sorted into presentation order, including B-frame reordering. The nearest preceding keyframe PTS is converted using integer/rational arithmetic to an input seek timestamp, rounded upward to a microsecond. `-copyts -seek_timestamp 1 -noaccurate_seek` preserves timestamps; `select=gte(pts,targetPTS)` makes the final decision using exact integer PTS, never floating-point time comparisons. Sequential restarts use the same path; nearby forward reads retain the running decoder. The existing chunk/barcode tests also passed as part of the unit suite.

## 9. Formatting check

Formatting commit: `983d468`. Before-format checkout: `bc60411`. The same runtime checks were run on both revisions. Actual pre-format unit output:

```text

> animation-engine@1.1.0 test
> vitest run --exclude "tests/mcp/**"


 RUN  v5.0.1 /tmp/animation-engine-media-before-format


 Test Files  12 passed (12)
      Tests  156 passed | 7 skipped (163)
   Start at  09:51:46
   Duration  13.15s (tests 78%, transform 12%, import 10%)
```

Actual pre-format MCP output:

```text

> animation-engine@1.1.0 test:mcp
> npm run build:mcp && vitest run tests/mcp


> animation-engine@1.1.0 build:mcp
> esbuild mcp/src/main.ts --bundle --platform=node --format=esm --target=node20 --outfile=dist/video-engine-mcp.mjs --external:@napi-rs/canvas --external:sharp --external:ffmpeg-static --external:ffprobe-static --banner:js="import{createRequire as __cr}from\"node:module\";const require=__cr(import.meta.url);" && node -e "require('fs').mkdirSync('dist/blender',{recursive:true});require('fs').copyFileSync('src/scene3d/blender/engine3d.py','dist/blender/engine3d.py')" && esbuild src/render/chunk-worker.ts --bundle --platform=node --format=esm --target=node20 --outfile=dist/video-chunk-worker.mjs --packages=external


  dist/video-engine-mcp.mjs  1.6mb ⚠️

⚡ Done in 195ms

  dist/video-chunk-worker.mjs  99.2kb

⚡ Done in 57ms

 RUN  v5.0.1 /tmp/animation-engine-media-before-format


 Test Files  5 passed (5)
      Tests  19 passed | 1 skipped (20)
   Start at  09:52:02
   Duration  5.24s (tests 88%, transform 6%, import 5%)
```

| Check | Before formatting | After formatting |
| --- | --- | --- |
| `npx tsc --noEmit` | Exit 0, no output | Exit 0, no output |
| Unit tests | 12 files; 156 passed, 7 skipped | 12 files; 156 passed, 7 skipped |
| MCP tests | 5 files; 19 passed, 1 skipped | 5 files; 19 passed, 1 skipped |
| Example RGBA hashes | 12 match main | Same 12 match main |

The pre-format hash command was `npx tsx scripts/media-regression-hashes.ts /tmp/animation-engine-media-before-format` (exit **0**). Its [full output](media-perf-evidence/before-format-hashes.txt) is byte-for-byte identical to both hash outputs in section 6.

An additional syntax comparison parsed TypeScript using Prettier's TypeScript parser, discarded comments/location/raw spelling, and compared normalized trees. JSON was compared after parsing. Actual output:

```text
38 TypeScript files: identical normalized syntax trees (comments, locations and raw literal spelling excluded).
src/scene/validate.ts: separately reviewed extraction into sceneIssueCode, retaining branch order and return values.
10 JSON files: parsed values identical before and after formatting.
```

The `sceneIssueCode` extraction was reviewed separately: shape/path, video, audio-extension, then generic Zod mapping remain in exactly the same order with the same return values. This is the only intentional non-formatting syntax change in that commit. Formatting uses double quotes, two spaces, and a 140-column target, including the previously malformed `renderVideo` and workspace job blocks. No dependencies or behavior were changed by the formatting commit.

## 10. Deviations

- The task's explicit final-verification requirement was followed despite the generic Builder/Reviewer boilerplate forbidding Builder suite runs. Only the requested evidence and checks needed to establish formatting equivalence were run.
- The explicit task branch/PR instruction supersedes the prior Tandem branch/no-push default for this delivery. Work is on `fix/media-perf`, based on `main`, with one commit per implementation item and a separate documentation/evidence commit. The requested PR targets `main`; the repository's unrelated default branch is not changed, and the PR is not automatically merged.
- The seek implementation demuxes a packet/keyframe index once per frame-source instance rather than inferring keyframes from a hard-coded GOP. This supports existing prepared files without new metadata, non-default GOPs, B-frame ordering, fractional rates, and lossless chunk intermediates. Pixel decoding begins at the indexed keyframe; the initial indexing cost remains proportional to packet count.
- Tests use a small 144×16 barcode fixture for economical 3,600-frame exactness coverage, while the benchmark uses the requested full 1080p source. The timing test allows 100 ms of scheduling tolerance in addition to the suggested 3× ratio.
- The system FFmpeg was explicitly selected because the bundled binary is not installed. Decoder `-threads 1` settings were left untouched. No dependency changes were required.
- Installed dependency versions were shared between the detached verification worktrees; scene files and engine source came from each respective commit. Tests were not rerun after documentation-only edits.

### Failed setup/diagnostic commands and recovery

No final typecheck, test suite, hash command, benchmark, or named seek check failed. The following setup attempts did fail; they are not represented as successful verification:

1. The first sandboxed baseline benchmark attempt failed before source generation because `tsx` could not create its local IPC listener. It was rerun with approved execution permissions and completed with the full output in section 7. Original error output:

```text
node:net:1919
      const error = new UVExceptionWithHostPort(rval, 'listen', address, port);
                    ^

Error: listen EPERM: operation not permitted /tmp/tsx-1001/16.pipe
    at Server.setupListenHandle [as _listen2] (node:net:1919:21)
    at listenInCluster (node:net:1998:12)
    at Server.listen (node:net:2120:5)
    at file:///srv/tandem/projects/animation_engine/repo/node_modules/tsx/dist/cli.mjs:53:32174
    at new Promise (<anonymous>)
    at createIpcServer (file:///srv/tandem/projects/animation_engine/repo/node_modules/tsx/dist/cli.mjs:53:32152)
    at async file:///srv/tandem/projects/animation_engine/repo/node_modules/tsx/dist/cli.mjs:55:542 {
  code: 'EPERM',
  errno: -1,
  syscall: 'listen',
  address: '/tmp/tsx-1001/16.pipe',
  port: -1
}

Node.js v22.23.2
```

2. A temporary syntax-comparison helper initially tried to load a TypeScript compiler JS API unavailable in this installation; it was changed to use the isolated formatter's parser. Full failure output:

```text
node:internal/modules/cjs/loader:1433
  throw err;
  ^

Error: Cannot find module '/srv/tandem/projects/animation_engine/repo/node_modules/typescript'
Require stack:
- /tmp/media-format-ast.cjs
    at Function._resolveFilename (node:internal/modules/cjs/loader:1430:15)
    at defaultResolveImpl (node:internal/modules/cjs/loader:1040:19)
    at resolveForCJSWithHooks (node:internal/modules/cjs/loader:1045:22)
    at Function._load (node:internal/modules/cjs/loader:1216:25)
    at wrapModuleLoad (node:internal/modules/cjs/loader:254:19)
    at Module.require (node:internal/modules/cjs/loader:1527:12)
    at require (node:internal/modules/helpers:147:16)
    at Object.<anonymous> (/tmp/media-format-ast.cjs:1:12)
    at Module._compile (node:internal/modules/cjs/loader:1781:14)
    at Object..js (node:internal/modules/cjs/loader:1913:10) {
  code: 'MODULE_NOT_FOUND',
  requireStack: [ '/tmp/media-format-ast.cjs' ]
}

Node.js v22.23.2
```

3. The helper's next attempt to read pre-format files through `spawnSync git` encountered sandbox `EPERM`. It was changed to read the detached worktree directly. The [complete original error output](media-perf-evidence/format-helper-sandbox.txt) includes the returned source text in Node's error object; the error begins:

```text
<ref *1> Error: spawnSync git EPERM
    at Object.spawnSync (node:internal/child_process:1120:20)
    at spawnSync (node:child_process:902:24)
    at Object.execFileSync (node:child_process:945:15)
    at /tmp/media-format-ast.cjs:15:23
    at Object.<anonymous> (/tmp/media-format-ast.cjs:22:3)
    at Module._compile (node:internal/modules/cjs/loader:1781:14)
    at Object..js (node:internal/modules/cjs/loader:1913:10)
    at Module.load (node:internal/modules/cjs/loader:1505:32)
    at Function._load (node:internal/modules/cjs/loader:1309:12)
    at wrapModuleLoad (node:internal/modules/cjs/loader:254:19) {
  errno: -1,
  code: 'EPERM',
  syscall: 'spawnSync git',
  path: 'git',
  spawnargs: [ 'show', 'HEAD:examples/footage-proof/run.ts' ],
  error: [Circular *1],
  status: 0,
  signal: null,
```

4. The parser contains BigInt literals, so a helper prototype failed until it encoded those explicitly before comparing normalized trees. Full failure output:

```text
TypeError: Do not know how to serialize a BigInt
    at JSON.stringify (<anonymous>)
    at /tmp/media-format-ast.cjs:18:14
```

Prettier also warned that `--double-quote` was unknown (exit 0); double quotes are its default and were applied. The successful syntax comparison and before/after checks above are the evidence for the final formatting result. Temporary formatter/helper dependencies were isolated under `/tmp` and were not added to the project.

## 11. Known limitations

- Building a seek index is a once-per-source demux pass, not constant time in file length. Output is capped at 64 MiB and 120 seconds; the parsed index also consumes memory independently of the RGBA LRU. Closing the frame source releases the index and cancels an in-progress probe.
- The index expects one uniquely timestamped packet per prepared frame and safe-integer PTS. This covers the prepared H.264 files and FFV1 chunk intermediates exercised here; arbitrary unprepared codecs are not a supported input contract.
- Preparation bytes can differ across thread settings, machines, or FFmpeg builds. Hashing occurs after preparation; a given immutable prepared file still defines the render input. README documents this distinction.
- Blender is unavailable, so seven unit tests and one MCP test were skipped. The requested 2D regression hashes all match; no broader unexecuted 3D guarantee is claimed.
- Timings reflect this Linux host/system FFmpeg. The bundled FFmpeg binary and other platforms were not benchmarked.
- No fixes to unrelated original compositing acceptance gaps (such as provider speech alignment or Git-tag installation) were attempted in this performance-only task.

All recorded stdout/stderr files and command exit codes are preserved in [media-perf-evidence](media-perf-evidence/).
