/**
 * Writes examples/playground/scene.json: two kids run in, hop onto a seesaw and play (10 s).
 * This script plays the agent: every intention becomes explicit layers, pivots, z and keyframes.
 *
 * Rig idea: each kid's root is a child of the seesaw plank at its seat attachment point from the
 * start. While the plank is level (frames 0-62) the root's local x/y are plain world offsets, so
 * the kids can run in and hop on; once seated (local 0,0) they ride the plank's rotation.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
type Kf = { frame: number; value: number | string | boolean; interpolation?: string; bezier?: number[] };

async function main() {
  const S = JSON.parse(await fs.readFile(path.join(HERE, "assets/processed/summary.json"), "utf8"));
  const assets: Record<string, unknown> = {};
  for (const [n, s] of Object.entries<any>(S)) assets[n] = { src: s.src, ...(s.attachmentPoints ? { attachmentPoints: s.attachmentPoints } : {}) };
  const box = (n: string) => ({
    asset: n,
    width: +(S[n].width / S[n].res).toFixed(2),
    height: +(S[n].height / S[n].res).toFixed(2),
    anchorX: S[n].pivot?.x ?? 0.5,
    anchorY: S[n].pivot?.y ?? 0.5,
  });

  const FPS = 30;
  const DURATION = 300;
  const layers: Record<string, unknown>[] = [];
  const animations: { target: string; property: string; keyframes: Kf[] }[] = [];
  const track = (target: string, property: string, keyframes: Kf[]) => animations.push({ target, property, keyframes });
  const ease = "ease-in-out";

  // ------------------------------------------------------------------ set
  layers.push({ id: "park", asset: "park_bg", x: 960, y: 560, z: 0 });
  layers.push({ id: "cloud_a", ...box("cloud_a"), x: 330, y: 150, z: 1 });
  layers.push({ id: "cloud_b", ...box("cloud_b"), x: 1350, y: 250, z: 1 });
  track("cloud_a", "x", [{ frame: 0, value: 330 }, { frame: DURATION - 1, value: 560 }]);
  track("cloud_b", "x", [{ frame: 0, value: 1350 }, { frame: DURATION - 1, value: 1190 }]);
  layers.push({ id: "bird", asset: "bird_up", scaleX: 0.5, scaleY: 0.5, x: -80, y: 300, z: 2 });
  track("bird", "x", [{ frame: 15, value: -80 }, { frame: 210, value: 2020 }]);
  track("bird", "y", [
    { frame: 15, value: 320, interpolation: ease },
    { frame: 80, value: 270, interpolation: ease },
    { frame: 150, value: 310, interpolation: ease },
    { frame: 210, value: 260 },
  ]);
  track("bird", "asset", Array.from({ length: 40 }, (_, i) => ({ frame: 15 + i * 5, value: i % 2 ? "bird_down" : "bird_up" })));

  layers.push({ id: "swing_frame", ...box("swing_frame"), x: 360, y: 745, z: 5 });
  for (const [i, phase] of [[1, 0], [2, 22]] as const) {
    layers.push({ id: `swing_${i}`, parent: "swing_frame", parentPoint: `swing_${i}`, ...box("swing"), z: 4 });
    const k: Kf[] = [];
    for (let f = -phase, s = 1; f < DURATION + 40; f += 35, s = -s) k.push({ frame: Math.max(0, f), value: s * (i === 1 ? 7 : 5), interpolation: ease });
    track(`swing_${i}`, "rotation", dedupe(k));
  }
  layers.push({ id: "slide", ...box("slide"), x: 1650, y: 748, z: 5 });
  layers.push({ id: "ball", ...box("ball"), x: 1530, y: 985, z: 40 });
  layers.push({ id: "flowers_l", ...box("flowers"), x: 150, y: 1090, scaleX: 1.3, scaleY: 1.3, z: 60 });
  layers.push({ id: "flowers_r", ...box("flowers"), x: 1800, y: 1092, scaleX: -1.2, scaleY: 1.2, z: 60 });

  // seesaw: fulcrum on the sand, plank pivots on its axle, handles ride on the plank
  // the whole seesaw group (and the kids riding it) is scaled through the fulcrum: parent scale
  layers.push({ id: "fulcrum", ...box("fulcrum"), x: 960, y: 940, scaleX: 1.35, scaleY: 1.35, z: 21 });
  layers.push({ id: "plank", parent: "fulcrum", parentPoint: "axle", ...box("plank"), z: 22 });
  layers.push({ id: "handle_l", parent: "plank", parentPoint: "handle_left", ...box("handle"), z: 23 });
  layers.push({ id: "handle_r", parent: "plank", parentPoint: "handle_right", ...box("handle"), z: 23 });

  // plank rocking: +13° = left end (kid A) up
  const TILT = 13;
  const peaks: [number, number][] = [[84, TILT], [114, -TILT], [144, TILT], [174, -TILT], [204, TILT], [234, -TILT], [262, TILT]];
  track("plank", "rotation", [
    { frame: 62, value: 0, interpolation: ease },
    ...peaks.map(([f, v]) => ({ frame: f, value: v, interpolation: ease })),
    { frame: 288, value: 0 },
  ]);

  // ------------------------------------------------------------------ kids
  const SEAT_HIP_Y = -6; // hips resting on the seat pad
  const STAND_HIP_Y = 38; // hips height when standing on the sand, relative to the seat
  const kid = (p: string, seat: string, dir: 1 | -1, startX: number, upSign: 1 | -1, cheers: number[]) => {
    const Z = { farArm: 18, farLeg: 19, torso: 24, head: 25, mouth: 26, nearLeg: 27, nearArm: 28 };
    layers.push({ id: p, parent: "plank", parentPoint: seat, x: startX, y: STAND_HIP_Y, scaleX: dir, z: 0 });
    layers.push({ id: `${p}_torso`, parent: p, ...box(`${p}_torso`), z: Z.torso });
    layers.push({ id: `${p}_head`, parent: `${p}_torso`, parentPoint: "neck", ...box(`${p}_head`), y: 6, z: Z.head });
    layers.push({ id: `${p}_mouth`, parent: `${p}_head`, parentPoint: "mouth", asset: "mouth_smile", scaleX: 0.5, scaleY: 0.5, z: Z.mouth });
    for (const side of ["far", "near"] as const) {
      const zl = side === "far" ? Z.farLeg : Z.nearLeg;
      layers.push({ id: `${p}_${side}_arm`, parent: `${p}_torso`, parentPoint: "shoulder", ...box(`${p}_arm`), z: side === "far" ? Z.farArm : Z.nearArm });
      layers.push({ id: `${p}_${side}_thigh`, parent: p, ...box(`${p}_thigh`), x: side === "far" ? -3 : 3, y: -4, z: zl });
      layers.push({ id: `${p}_${side}_shin`, parent: `${p}_${side}_thigh`, parentPoint: "knee", ...box(`${p}_shin`), z: zl });
    }

    // run-in (0-44): 8-frame stride, then hop onto the seat (44-58)
    const run = { near: { thigh: [-35, 28], shin: [18, 70], arm: [38, -42] }, far: { thigh: [28, -35], shin: [70, 18], arm: [-42, 38] } };
    const SEAT = { thigh: -86, shin: 88, arm: -66 };
    const stride = (vals: number[], seated: number, extra: Kf[] = []): Kf[] => {
      const k: Kf[] = [];
      for (let f = 0, i = 0; f <= 40; f += 8, i++) k.push({ frame: f, value: vals[i % 2], interpolation: ease });
      return [...k, { frame: 50, value: vals[1] * 0.3, interpolation: ease }, { frame: 58, value: seated, interpolation: ease }, ...extra];
    };
    // seated rocking: legs swing with the plank (tucked at the low end, stretched at the high end)
    const legRock = (base: number, amp: number): Kf[] =>
      peaks.map(([f, v]) => ({ frame: f, value: base + (Math.sign(v) === upSign ? -amp : amp), interpolation: ease }));
    for (const side of ["near", "far"] as const) {
      const off = side === "far" ? 6 : 0;
      track(`${p}_${side}_thigh`, "rotation", [...stride(run[side].thigh, SEAT.thigh + off), ...legRock(SEAT.thigh + off, 6), { frame: 288, value: SEAT.thigh + off }]);
      track(`${p}_${side}_shin`, "rotation", [...stride(run[side].shin, SEAT.shin - off), ...legRock(SEAT.shin - off, -16), { frame: 288, value: SEAT.shin - off }]);
    }
    // arms: swing while running, then hold the handle; the kid at the TOP sometimes cheers
    const farArm = stride(run.far.arm, SEAT.arm - 4);
    const nearArm = stride(run.near.arm, SEAT.arm);
    for (const c of cheers) {
      nearArm.push({ frame: c - 12, value: SEAT.arm, interpolation: ease }, { frame: c - 2, value: -128, interpolation: ease }, { frame: c + 10, value: -128, interpolation: ease }, { frame: c + 20, value: SEAT.arm, interpolation: ease });
    }
    track(`${p}_far_arm`, "rotation", farArm);
    track(`${p}_near_arm`, "rotation", nearArm.sort((a, b) => a.frame - b.frame));
    track(`${p}_torso`, "rotation", [
      { frame: 0, value: 9, interpolation: ease },
      { frame: 44, value: 9, interpolation: ease },
      { frame: 58, value: 2 },
    ]);
    // root: run in, bob, hop, sit
    const xk: Kf[] = [{ frame: 0, value: startX, interpolation: "linear" }, { frame: 44, value: dir * -34, interpolation: "ease-out" }, { frame: 58, value: 0 }];
    const yk: Kf[] = [];
    for (let f = 0, i = 0; f <= 40; f += 4, i++) yk.push({ frame: f, value: STAND_HIP_Y - (i % 2 ? 7 : 0), interpolation: ease });
    yk.push({ frame: 44, value: STAND_HIP_Y + 4, interpolation: "ease-out" }, { frame: 51, value: SEAT_HIP_Y - 38, interpolation: "ease-in" }, { frame: 58, value: SEAT_HIP_Y });
    track(p, "x", xk);
    track(p, "y", yk);

    // face: laugh on the way up to each of this kid's high points, "o" on the hop
    const mouth: Kf[] = [{ frame: 0, value: "mouth_smile" }, { frame: 46, value: "mouth_o" }, { frame: 60, value: "mouth_smile" }];
    const head: Kf[] = [{ frame: 0, value: 4, interpolation: ease }, { frame: 44, value: 4, interpolation: ease }, { frame: 60, value: 0, interpolation: ease }];
    for (const [f, v] of peaks) {
      if (Math.sign(v) !== upSign) continue;
      mouth.push({ frame: f - 10, value: "mouth_laugh" }, { frame: f + 9, value: "mouth_smile" });
      head.push({ frame: f - 12, value: 0, interpolation: ease }, { frame: f - 2, value: -7, interpolation: ease }, { frame: f + 12, value: 0, interpolation: ease });
    }
    track(`${p}_mouth`, "asset", mouth);
    track(`${p}_head`, "rotation", head);
  };
  // kid A (girl) runs in from the left, kid B (boy) from the right, mirrored with scaleX -1
  kid("kidA", "seat_left", 1, -560, 1, [144, 262]);
  kid("kidB", "seat_right", -1, 620, -1, [174]);

  // ------------------------------------------------------------------ camera + fades
  layers.push({ id: "fade", fill: "#000000", x: 960, y: 540, width: 1920, height: 1080, opacity: 1, z: 100 });
  track("fade", "opacity", [
    { frame: 0, value: 1, interpolation: "ease-out" },
    { frame: 14, value: 0, interpolation: "step" },
    { frame: 283, value: 0, interpolation: "ease-in" },
    { frame: 299, value: 1 },
  ]);
  const cam = (prop: string, vals: [number, number][]) => track("camera", prop, vals.map(([frame, value]) => ({ frame, value, interpolation: ease })));
  cam("scale", [[40, 1], [140, 1.16], [240, 1.16], [299, 1.06]]);
  cam("x", [[40, 0], [140, 0], [240, 0], [299, 0]]);
  cam("y", [[40, 0], [140, 60], [240, 60], [299, 30]]);

  const scene = {
    version: 1,
    name: "playground-seesaw",
    canvas: { width: 1920, height: 1080, fps: FPS, background: "#000000" },
    duration: DURATION,
    assets,
    layers,
    animations,
    audio: [
      { src: "assets/audio/music.wav", startFrame: 0, volume: 0.55 },
      { src: "assets/audio/giggles.wav", startFrame: 0, volume: 0.9 },
    ],
  };
  await fs.writeFile(path.join(HERE, "scene.json"), JSON.stringify(scene, null, 2) + "\n");
  console.log(`scene.json: ${layers.length} layers, ${animations.length} tracks, ${DURATION} frames`);
}

function dedupe(k: Kf[]): Kf[] {
  const m = new Map<number, Kf>();
  for (const x of k) m.set(x.frame, x);
  return [...m.values()].filter((x) => x.frame < 300).sort((a, b) => a.frame - b.frame);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
