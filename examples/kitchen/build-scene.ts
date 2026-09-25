/**
 * Writes examples/kitchen/scene.json — the end-to-end test scene.
 *
 * This script plays the role the AI agent will play later: it turns intentions ("walk in, stand
 * behind the counter, pick up the cup, talk") into EXPLICIT numbers. The engine never sees the
 * intentions, only layers, pivots, z values and keyframes.
 *
 * Sizes, pivots and attachment points come from the asset pipeline output
 * (assets/processed/summary.json) so nothing is eyeballed twice.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

interface SummaryEntry {
  src: string;
  width: number;
  height: number;
  res: number;
  pivot?: { x: number; y: number };
  attachmentPoints?: Record<string, { x: number; y: number }>;
}

type Kf = { frame: number; value: number | string | boolean; interpolation?: string; bezier?: number[] };

async function main() {
  const summary = JSON.parse(await fs.readFile(path.join(HERE, "assets/processed/summary.json"), "utf8")) as Record<string, SummaryEntry>;

  const assets: Record<string, unknown> = {};
  for (const [name, s] of Object.entries(summary)) {
    assets[name] = { src: s.src, ...(s.attachmentPoints ? { attachmentPoints: s.attachmentPoints } : {}) };
  }
  /** Layer box for an asset at its intended scene resolution, pivot as anchor. */
  const box = (name: string) => {
    const s = summary[name];
    return {
      asset: name,
      width: +(s.width / s.res).toFixed(2),
      height: +(s.height / s.res).toFixed(2),
      anchorX: s.pivot?.x ?? 0.5,
      anchorY: s.pivot?.y ?? 0.5,
    };
  };

  const FPS = 30;
  const DURATION = 330;
  const layers: Record<string, unknown>[] = [];
  const animations: { target: string; property: string; keyframes: Kf[] }[] = [];
  const track = (target: string, property: string, keyframes: Kf[]) => animations.push({ target, property, keyframes });

  // ------------------------------------------------------------------ set
  layers.push({ id: "background", asset: "kitchen_bg", x: 960, y: 560, z: 0 }); // 2100x1180 plate, centred
  // Window opening in world space: plate top-left is (960-1050, 560-590) = (-90, -30); opening
  // is at plate (560,150) size 520x330  ->  world (470, 120, 520, 330).
  const WINDOW = { x: 470, y: 120, width: 520, height: 330 };
  layers.push({ id: "window_mask", fill: "#ffffff", x: WINDOW.x, y: WINDOW.y, width: WINDOW.width, height: WINDOW.height, anchorX: 0, anchorY: 0, visible: false, z: 0 });
  layers.push({ id: "sky", asset: "sky_view", x: WINDOW.x + WINDOW.width / 2, y: WINDOW.y + WINDOW.height / 2, z: 1, mask: { type: "rect", ...WINDOW } });
  layers.push({ id: "cloud", asset: "cloud", x: 420, y: 190, z: 2, mask: { type: "layer", layer: "window_mask" } });
  track("cloud", "x", [
    { frame: 0, value: 420 },
    { frame: DURATION - 1, value: 1060 },
  ]);
  const wf = summary.window_frame.attachmentPoints!.opening_top_left;
  layers.push({ id: "window_frame", ...box("window_frame"), anchorX: wf.x, anchorY: wf.y, x: WINDOW.x, y: WINDOW.y, z: 3 });

  // Counter: bottom-centre anchored on the floor, scaled down 15%.
  layers.push({ id: "counter", ...box("counter_keyed"), anchorX: 0.5, anchorY: 1, x: 1250, y: 1000, scaleX: 0.85, scaleY: 0.85, z: 20 });

  // Cup waiting on the counter (independent layer). Its position is corrected later from
  // measure_layout so that it coincides with the hand's grip at the pick-up frame.
  // z 30.5 = between the forearm (30) and the hand (31), the same as the held cup, so the
  // fingers draw over the handle both before and after the hand-off (no layering pop).
  layers.push({ id: "cup_on_counter", ...box("cup_keyed"), x: 960, y: 648, z: 30.5 });

  // ------------------------------------------------------------------ character rig
  const FLOOR = 990;
  layers.push({ id: "character", x: -150, y: FLOOR, z: 0, meta: { note: "transform root at the feet; draws nothing" } });
  // legs hang from the hips, torso stands on the hips
  const HIP_Y = -388;
  layers.push({ id: "left_leg", parent: "character", ...box("left_leg"), x: 38, y: HIP_Y, z: 5 });
  layers.push({ id: "right_leg", parent: "character", ...box("right_leg"), x: -38, y: HIP_Y, z: 5 });
  layers.push({ id: "torso", parent: "character", ...box("torso"), x: 0, y: HIP_Y + 8, z: 10 });
  layers.push({ id: "head", parent: "torso", parentPoint: "neck", ...box("head"), x: 0, y: 12, z: 11 });
  layers.push({ id: "eyes", parent: "head", parentPoint: "eyes_center", asset: "eyes_open", scaleX: 0.5, scaleY: 0.5, z: 12 });
  layers.push({ id: "mouth", parent: "head", parentPoint: "mouth_center", asset: "mouth_rest", scaleX: 0.5, scaleY: 0.5, z: 12 });
  // arms: shoulder -> elbow -> wrist, each joint is the child's pivot
  layers.push({ id: "left_upper_arm", parent: "torso", parentPoint: "left_shoulder", ...box("left_upper_arm"), x: -6, y: 0, rotation: -8, z: 13 });
  layers.push({ id: "left_forearm", parent: "left_upper_arm", parentPoint: "elbow", ...box("left_forearm"), rotation: 4, z: 14 });
  layers.push({ id: "left_hand", parent: "left_forearm", parentPoint: "wrist", ...box("left_hand"), z: 15 });
  layers.push({ id: "right_upper_arm", parent: "torso", parentPoint: "right_shoulder", ...box("right_upper_arm"), x: 6, y: 0, rotation: 8, z: 13 });
  layers.push({ id: "right_forearm", parent: "right_upper_arm", parentPoint: "elbow", ...box("right_forearm"), rotation: -4, z: 14 });
  layers.push({ id: "right_hand", parent: "right_forearm", parentPoint: "wrist", ...box("right_hand"), z: 15 });
  // cup held in the right hand: pivot at the cup handle, attached to the hand's grip point
  const handle = summary.cup_keyed.attachmentPoints!.handle;
  layers.push({ id: "cup_in_hand", parent: "right_hand", parentPoint: "grip", ...box("cup_keyed"), anchorX: handle.x, anchorY: handle.y, visible: false, z: 30.5 });
  layers.push({ id: "steam", parent: "cup_in_hand", parentPoint: "rim_center", ...box("steam"), y: -4, opacity: 0, z: 33 });

  // foreground prop and a full-frame fade overlay (screen-sized fill in world space; the
  // camera is back at identity when it fades)
  layers.push({ id: "plant", ...box("plant_keyed"), x: 170, y: 1085, z: 50 });
  layers.push({ id: "fade", fill: "#000000", x: 960, y: 540, width: 1920, height: 1080, opacity: 0, z: 100 });

  // ------------------------------------------------------------------ timeline
  // 1. walk in (frames 0-100)
  track("character", "x", [
    { frame: 0, value: -150, interpolation: "linear" },
    { frame: 84, value: 1060, interpolation: "ease-out" },
    { frame: 100, value: 1150 },
  ]);
  const step = 10;
  const legKeys = (sign: number): Kf[] => {
    const k: Kf[] = [];
    for (let f = 0, i = 0; f <= 90; f += step, i++) k.push({ frame: f, value: sign * (i % 2 ? -7 : 7), interpolation: "ease-in-out" });
    k.push({ frame: 100, value: 0 });
    return k;
  };
  track("left_leg", "rotation", legKeys(1));
  track("right_leg", "rotation", legKeys(-1));
  const bob: Kf[] = [];
  for (let f = 0, i = 0; f <= 90; f += step / 2, i++) bob.push({ frame: f, value: FLOOR - (i % 2 ? 8 : 0), interpolation: "ease-in-out" });
  bob.push({ frame: 100, value: FLOOR });
  track("character", "y", bob);
  // arms swing opposite to the legs while walking, then settle
  track("left_upper_arm", "rotation", legKeys(-0.6).map((k) => ({ ...k, value: (k.value as number) - 8 })));

  // 2. look at the cup (100-130): head tilts toward the counter cup (rotation around the neck)
  // 3. reach (125-155) / pick up at 155 / lift (155-195) / hold while talking / put the arm down a bit
  const REST = { upper: 8, fore: -4 };
  const REACH = { upper: 45, fore: -40 };
  const LIFT = { upper: 34, fore: -112 };
  const PICK = 155;
  track("right_upper_arm", "rotation", [
    ...legKeys(0.6).filter((k) => k.frame <= 90).map((k) => ({ ...k, value: (k.value as number) + REST.upper })),
    { frame: 100, value: REST.upper, interpolation: "linear" },
    { frame: 125, value: REST.upper, interpolation: "ease-in-out" },
    { frame: PICK, value: REACH.upper, interpolation: "ease-in-out" },
    { frame: 195, value: LIFT.upper },
  ]);
  track("right_forearm", "rotation", [
    { frame: 125, value: REST.fore, interpolation: "ease-in-out" },
    { frame: PICK, value: REACH.fore, interpolation: "ease-in-out" },
    { frame: 195, value: LIFT.fore },
  ]);
  // discrete z: the forearm/hand come in front of the counter only while reaching over it
  track("right_forearm", "z", [
    { frame: 0, value: 14 },
    { frame: 125, value: 30 },
  ]);
  track("right_hand", "z", [
    { frame: 0, value: 15 },
    { frame: 125, value: 31 },
  ]);
  track("head", "rotation", [
    { frame: 100, value: 0, interpolation: "ease-in-out" },
    { frame: 120, value: 12, interpolation: "linear" },
    { frame: PICK, value: 12, interpolation: "ease-in-out" },
    { frame: 185, value: -4, interpolation: "ease-in-out" },
    { frame: 215, value: 0, interpolation: "ease-in-out" },
    { frame: 235, value: -5, interpolation: "ease-in-out" },
    { frame: 255, value: 3, interpolation: "ease-in-out" },
    { frame: 275, value: -3, interpolation: "ease-in-out" },
    { frame: 295, value: 0 },
  ]);
  // hand-off: counter cup disappears, hand cup appears on the same frame (step keyframes)
  track("cup_on_counter", "visible", [
    { frame: 0, value: true },
    { frame: PICK, value: false },
  ]);
  track("cup_in_hand", "visible", [
    { frame: 0, value: false },
    { frame: PICK, value: true },
  ]);
  // keep the held cup upright: its rotation cancels the accumulated arm rotation
  track("cup_in_hand", "rotation", [
    { frame: PICK, value: -(REACH.upper + REACH.fore), interpolation: "ease-in-out" },
    { frame: 195, value: -(LIFT.upper + LIFT.fore) },
  ]);

  // steam fades in once the cup is lifted, and breathes (scaleY)
  track("steam", "opacity", [
    { frame: 195, value: 0, interpolation: "ease-out" },
    { frame: 215, value: 0.85 },
  ]);
  track("steam", "scaleY", [
    { frame: 195, value: 0.6, interpolation: "ease-in-out" },
    { frame: 235, value: 1.1, interpolation: "ease-in-out" },
    { frame: 275, value: 0.85, interpolation: "ease-in-out" },
    { frame: 315, value: 1.1 },
  ]);

  // 4. talk (210-290): mouth shapes switch with step keyframes aligned with the audio syllables
  const mouth: [number, string][] = [
    [0, "mouth_rest"],
    [210, "mouth_A"], [214, "mouth_MBP"], [218, "mouth_E"], [222, "mouth_rest"],
    [227, "mouth_O"], [231, "mouth_MBP"], [236, "mouth_A"], [240, "mouth_E"], [244, "mouth_rest"],
    [252, "mouth_MBP"], [255, "mouth_A"], [260, "mouth_O"], [264, "mouth_E"], [268, "mouth_rest"],
    [271, "mouth_A"], [275, "mouth_MBP"], [280, "mouth_E"], [285, "mouth_O"], [290, "mouth_rest"],
  ];
  track("mouth", "asset", mouth.map(([frame, value]) => ({ frame, value, interpolation: "step" })));
  track("eyes", "asset", [
    { frame: 0, value: "eyes_open" },
    { frame: 60, value: "eyes_closed" },
    { frame: 64, value: "eyes_open" },
    { frame: 246, value: "eyes_closed" },
    { frame: 250, value: "eyes_open" },
  ]);

  // 5. camera: push in on the pick-up and the line, then pull back out; fade to black
  track("camera", "scale", [
    { frame: 130, value: 1, interpolation: "ease-in-out" },
    { frame: 200, value: 1.35, interpolation: "linear" },
    { frame: 285, value: 1.35, interpolation: "cubic-bezier", bezier: [0.3, 0, 0.2, 1] },
    { frame: 320, value: 1 },
  ]);
  track("camera", "x", [
    { frame: 130, value: 0, interpolation: "ease-in-out" },
    { frame: 200, value: 150, interpolation: "linear" },
    { frame: 285, value: 150, interpolation: "cubic-bezier", bezier: [0.3, 0, 0.2, 1] },
    { frame: 320, value: 0 },
  ]);
  track("camera", "y", [
    { frame: 130, value: 0, interpolation: "ease-in-out" },
    { frame: 200, value: -140, interpolation: "linear" },
    { frame: 285, value: -140, interpolation: "cubic-bezier", bezier: [0.3, 0, 0.2, 1] },
    { frame: 320, value: 0 },
  ]);
  track("fade", "opacity", [
    { frame: 312, value: 0, interpolation: "ease-in" },
    { frame: 329, value: 1 },
  ]);

  const scene = {
    version: 1,
    name: "kitchen-test",
    canvas: { width: 1920, height: 1080, fps: FPS, background: "#101014" },
    duration: DURATION,
    assets,
    camera: { x: 0, y: 0, scale: 1, rotation: 0 },
    layers,
    animations,
    audio: [{ src: "assets/audio/voice.wav", startFrame: 0, volume: 0.8 }],
  };
  await fs.writeFile(path.join(HERE, "scene.json"), JSON.stringify(scene, null, 2) + "\n");
  console.log(`scene.json: ${layers.length} layers, ${animations.length} tracks, ${DURATION} frames`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
