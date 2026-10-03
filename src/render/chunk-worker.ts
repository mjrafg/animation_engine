import { parentPort, workerData } from "node:worker_threads";
import { AnimationEngine } from "../api/engine.js";
import { startEncoder } from "./video.js";
const ctrl = new AbortController();
parentPort!.on("message", (message) => {
  if (message === "abort") ctrl.abort();
});
async function run() {
  const { document, baseDir, start, end, out, videoCacheBytes, losslessRgb } = workerData;
  const engine = new AnimationEngine(document, baseDir);
  let enc: ReturnType<typeof startEncoder> | undefined;
  try {
    await engine.prepare();
    if (losslessRgb) {
      const result = await engine.renderVideo(out, { intermediate: "lossless-rgb", audio: false,
        startFrame: start, endFrame: end, videoCacheBytes, signal: ctrl.signal,
        onProgress: (progress) => parentPort!.postMessage({ progress }) });
      parentPort!.postMessage({ metrics: result.timings });
      return;
    }
    await engine.configureVideoSources("sequential", ctrl.signal, videoCacheBytes);
    const c = engine.scene.canvas;
    enc = startEncoder({ out, width: c.width, height: c.height, fps: c.fps, frameCount: end - start, lossless: losslessRgb ? "rgb" : true });
    const cancel = () => {
      void enc?.abort();
    };
    ctrl.signal.addEventListener("abort", cancel, { once: true });
    try {
      let previousKey: string | undefined;
      let previousPixels: Buffer | undefined;
      for (let frame = start; frame < end; frame++) {
        if (ctrl.signal.aborted) throw new Error("Chunk cancelled");
        const key = JSON.stringify({ ...engine.displayList(frame), frame: 0 });
        if (key !== previousKey || !previousPixels) {
          previousPixels = (await engine.renderFrame(frame)).rgba();
          previousKey = key;
        }
        await enc.write(previousPixels);
        parentPort!.postMessage({ progress: frame - start + 1 });
      }
      await enc.finish();
    } finally {
      ctrl.signal.removeEventListener("abort", cancel);
    }
  } catch (e) {
    await enc?.abort();
    throw e;
  } finally {
    await engine.closeVideoSources();
  }
}
run().then(
  () => {
    parentPort!.postMessage({ done: true });
    parentPort!.close();
  },
  (e) => {
    parentPort!.postMessage({ error: String(e) });
    parentPort!.close();
  },
);
