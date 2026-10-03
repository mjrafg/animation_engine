# Tutorial production profiling

Measured on a Linux container limited to 6 CPUs / 8 GiB, Node 22.23.3,
using the existing Persian admin tutorial: 10,527 output frames at 1920x1080/30.
Input engine commit: e324ffd782a646531b21876dd0f348aac61ed334.

Actual returned measurements are committed alongside this report.

| Operation | Wall seconds | Draw | Decode | Encoder writes |
|---|---:|---:|---:|---:|
| Existing clean MP4 render | 869.107 | 636.229 | 132.803 | 93.803 |
| Single lossless RGB master, exact display-list reuse | 429.916 | 222.646 | 110.010 | 91.443 |
| Three parallel lossless chunks, stream-copy join | 201.601 | not separately returned in this benchmark build | | |

The master rows exclude audio and final delivery H.264 encoding, and therefore
are not end-to-end MP4 comparisons. No resolution/frame-rate/tolerance reduction.
The first master reused 6,593 identical rendered frames. The parallel benchmark
also removed redundant consecutive step keys (lossless timeline compaction).
A subsequent instrumentation-only change exposes summed worker timings; these
sums overlap in wall time and must not be treated as sequential stage durations.

Changes: exact built-in renderer frame reuse (custom renderers are unaffected),
lossless RGB master output, lossless chunk joining without a second pixel pass,
preparation progress callbacks and container frame-count reuse instead of an
unnecessary full pixel decode when MP4 supplies its frame count.

Packaging builds completed. Added regression coverage for changed/unchanged
frames and lossless single/parallel output pixel equality. Tests were not run by
the Builder; independent verification is assigned to the Reviewer.
