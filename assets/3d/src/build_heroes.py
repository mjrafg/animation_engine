"""
Builds two ORIGINAL rigged 3D characters and a city street set, fully procedurally:

    blender -b --factory-startup -noaudio --python assets/3d/src/build_heroes.py -- assets/3d

  volt.glb   "Volt": an armoured robot (white/cobalt plates over a dark flexible suit, glowing
             cyan visor and chest core).
  crag.glb   "Crag": a huge stone brute (slate skin with glowing lava bands, heavy fists).
  city.glb   a city street at dusk: asphalt road with markings and crosswalks, sidewalks and
             curbs, buildings with lit windows, street lamps, a parked car, hydrant and bins.

Both characters use the same 16-bone skeleton and bone names as Mika (root, hips, spine, neck,
head, upper_arm/forearm/hand .L/.R, thigh/shin .L/.R) with their own proportions, so the
character runtime, sockets, reach IK and interactions work unchanged. Clips: idle, walk, run
(in place), guard (fighting stance, loop), punch (right straight), roar (arms spread), hit
(recoil). Morphs: blink (eyes/visor), mouth_open, mouth_oh, smile, angry. Front faces +Z (glTF).
Every body part is one continuous skinned surface with blended weights across the joints; armour
plates and fists are rigid pieces on top.
"""
import importlib.util
import math
import os
import sys

import bmesh
import bpy
from mathutils import Quaternion, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("build_assets", os.path.join(HERE, "build_assets.py"))
ba = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ba)  # helpers only (its builds run only as __main__)

OUT = sys.argv[sys.argv.index("--") + 1] if "--" in sys.argv else "."
FPS = ba.FPS
reset, cube, sphere, cylinder, skinned_tube, export = ba.reset, ba.cube, ba.sphere, ba.cylinder, ba.skinned_tube, ba.export


def mat(name, rgba, rough=0.5, metal=0.0, emit=None, strength=0.0, coat=0.0):
    m = bpy.data.materials.get(name)
    if m:
        return m
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = rgba
    b.inputs["Roughness"].default_value = rough
    b.inputs["Metallic"].default_value = metal
    if coat:
        b.inputs["Coat Weight"].default_value = coat
    if emit:
        b.inputs["Emission Color"].default_value = emit
        b.inputs["Emission Strength"].default_value = strength
    return m


def smooth(t):
    t = max(0.0, min(1.0, t))
    return t * t * (3 - 2 * t)


def band(z, hi, lo, a, b):
    """weights moving from bone a (above hi) to bone b (below lo)"""
    if z >= hi:
        return {a: 1.0}
    if z <= lo:
        return {b: 1.0}
    t = smooth((hi - z) / (hi - lo))
    return {a: 1 - t, b: t}


# ---- rig -----------------------------------------------------------------------------------------


def build_rig(name, J):
    """J: joint heights/offsets. Same bones and hierarchy as Mika."""
    sc = bpy.context.scene
    data = bpy.data.armatures.new(name + "Rig")
    arm = bpy.data.objects.new(name, data)
    sc.collection.objects.link(arm)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode="EDIT")

    def bone(n, head, tail, parent=None):
        b = data.edit_bones.new(n)
        b.head, b.tail, b.roll = head, tail, 0.0
        if parent:
            b.parent = data.edit_bones[parent]
            b.use_connect = False

    bone("root", (0, 0, 0), (0, 0.25, 0))
    bone("hips", (0, 0, J["hip"]), (0, 0, J["hip"] + 0.15), "root")
    bone("spine", (0, 0, J["hip"] + 0.15), (0, 0, J["neck"]), "hips")
    bone("neck", (0, 0, J["neck"]), (0, 0, J["head"]), "spine")
    bone("head", (0, 0, J["head"]), (0, 0, J["top"]), "neck")
    for s, sg in (("L", 1), ("R", -1)):
        x = sg * J["sx"]
        bone("upper_arm." + s, (x, 0, J["sz"]), (x, 0, J["ez"]), "spine")
        bone("forearm." + s, (x, 0, J["ez"]), (x, 0, J["wz"]), "upper_arm." + s)
        bone("hand." + s, (x, 0, J["wz"]), (x, 0, J["wz"] - J["hand"]), "forearm." + s)
        lx = sg * J["lx"]
        bone("thigh." + s, (lx, 0, J["hip"]), (lx, 0, J["kz"]), "hips")
        bone("shin." + s, (lx, 0, J["kz"]), (lx, 0, J["az"]), "thigh." + s)
    bpy.ops.object.mode_set(mode="OBJECT")
    return arm


def rigid(o, arm, bone_name):
    vg = o.vertex_groups.new(name=bone_name)
    vg.add(list(range(len(o.data.vertices))), 1.0, "REPLACE")
    mod = o.modifiers.new("Armature", "ARMATURE")
    mod.object = arm
    o.parent = arm
    return o


def torso_weights(J):
    def w(z):
        if z < J["hip"] + 0.2:
            return band(z, J["hip"] + 0.2, J["hip"] + 0.06, "spine", "hips")
        if z < J["neck"] - 0.03:
            return {"spine": 1.0}
        if z < J["head"] + 0.02:
            return band(z, J["head"] + 0.02, J["neck"] - 0.03, "head", "spine") if z > J["neck"] + 0.03 else band(z, J["neck"] + 0.03, J["neck"] - 0.03, "neck", "spine")
        return {"head": 1.0}

    return w


def arm_weights(J, s):
    def w(z):
        if z > J["sz"] - 0.04:
            t = smooth((z - (J["sz"] - 0.04)) / 0.12)
            return {"spine": 0.5 * t, "upper_arm." + s: 1 - 0.5 * t}
        if z > J["ez"] + 0.07:
            return {"upper_arm." + s: 1.0}
        if z > J["ez"] - 0.07:
            return band(z, J["ez"] + 0.07, J["ez"] - 0.07, "upper_arm." + s, "forearm." + s)
        if z > J["wz"] + 0.03:
            return {"forearm." + s: 1.0}
        if z > J["wz"] - 0.03:
            return band(z, J["wz"] + 0.03, J["wz"] - 0.03, "forearm." + s, "hand." + s)
        return {"hand." + s: 1.0}

    return w


def leg_weights(J, s):
    def w(z):
        if z > J["hip"] - 0.04:
            t = smooth((z - (J["hip"] - 0.04)) / 0.1)
            return {"hips": 0.6 * t, "thigh." + s: 1 - 0.6 * t}
        if z > J["kz"] + 0.07:
            return {"thigh." + s: 1.0}
        if z > J["kz"] - 0.07:
            return band(z, J["kz"] + 0.07, J["kz"] - 0.07, "thigh." + s, "shin." + s)
        return {"shin." + s: 1.0}

    return w


# ---- face ----------------------------------------------------------------------------------------


def shape_keys(o, keys):
    o.shape_key_add(name="Basis")
    for name, fn in keys:
        k = o.shape_key_add(name=name)
        for i, v in enumerate(o.data.vertices):
            k.data[i].co = fn(v.co.copy())


def join(objs, name):
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    o = bpy.context.active_object
    o.name = o.data.name = name
    return o


def subdivided_box(name, size, loc, material, cuts=6):
    o = cube(name, size, loc, material)
    bpy.context.view_layer.objects.active = o
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.subdivide(number_cuts=cuts)
    bpy.ops.object.mode_set(mode="OBJECT")
    return o


# ---- clips ---------------------------------------------------------------------------------------


def add_clips(arm, heavy=False):
    data = arm.data
    arm.animation_data_create()
    rest = {b.name: b.matrix_local.to_3x3() for b in data.bones}

    def local_q(bone_name, axis, deg):
        ax = (rest[bone_name].inverted() @ Vector(axis)).normalized()
        return Quaternion(ax, math.radians(deg))

    def clip(name, keys, loc_keys=()):
        act = bpy.data.actions.new(name)
        arm.animation_data.action = act
        for pb in arm.pose.bones:
            pb.rotation_mode = "QUATERNION"
        # several rotations on one bone are composed per frame (world axes at rest)
        per_bone = {}
        for bone_name, axis, frames in keys:
            per_bone.setdefault(bone_name, []).append((axis, dict(frames)))
        for bone_name, chans in per_bone.items():
            pb = arm.pose.bones[bone_name]
            frames = sorted({f for _, fr in chans for f in fr})

            def val(fr, f):
                ks = sorted(fr)
                if f <= ks[0]:
                    return fr[ks[0]]
                for a, b in zip(ks, ks[1:]):
                    if a <= f <= b:
                        return fr[a] + (fr[b] - fr[a]) * (f - a) / (b - a)
                return fr[ks[-1]]

            for f in frames:
                q = Quaternion()
                for axis, fr in chans:
                    q = local_q(bone_name, axis, val(fr, f)) @ q
                pb.rotation_quaternion = q
                pb.keyframe_insert("rotation_quaternion", frame=f)
        for bone_name, frames in loc_keys:
            pb = arm.pose.bones[bone_name]
            for f, loc in frames:
                pb.location = loc
                pb.keyframe_insert("location", frame=f)
        for pb in arm.pose.bones:
            pb.rotation_quaternion = (1, 0, 0, 0)
            pb.location = (0, 0, 0)
        tr = arm.animation_data.nla_tracks.new()
        tr.name = name
        tr.strips.new(name, 1, act)
        arm.animation_data.action = None

    X, Y, Z = (1, 0, 0), (0, 1, 0), (0, 0, 1)
    k = 1.25 if heavy else 1.0
    n = 2 * FPS
    clip("idle", [
        ("spine", X, [(1, 0), (1 + n // 2, 3 * k), (1 + n, 0)]),
        ("head", Z, [(1, 0), (1 + n // 4, 4), (1 + 3 * n // 4, -4), (1 + n, 0)]),
        ("upper_arm.L", Y, [(1, -6 * k), (1 + n // 2, -9 * k), (1 + n, -6 * k)]),
        ("upper_arm.R", Y, [(1, 6 * k), (1 + n // 2, 9 * k), (1 + n, 6 * k)]),
        ("forearm.L", X, [(1, -8), (1 + n // 2, -12), (1 + n, -8)]),
        ("forearm.R", X, [(1, -8), (1 + n // 2, -12), (1 + n, -8)]),
    ])
    n = int(FPS * (1.2 if heavy else 1.0))
    h = n // 2
    clip("walk", [
        ("thigh.L", X, [(1, -26), (1 + h, 26), (1 + n, -26)]),
        ("thigh.R", X, [(1, 26), (1 + h, -26), (1 + n, 26)]),
        ("shin.L", X, [(1, 10), (1 + h // 2, 35), (1 + h, 5), (1 + n, 10)]),
        ("shin.R", X, [(1, 5), (1 + h, 10), (1 + h + h // 2, 35), (1 + n, 5)]),
        ("upper_arm.L", X, [(1, 20), (1 + h, -20), (1 + n, 20)]),
        ("upper_arm.R", X, [(1, -20), (1 + h, 20), (1 + n, -20)]),
        ("upper_arm.L", Y, [(1, -8 * k), (1 + n, -8 * k)]),
        ("upper_arm.R", Y, [(1, 8 * k), (1 + n, 8 * k)]),
        ("forearm.L", X, [(1, -12), (1 + h, -28), (1 + n, -12)]),
        ("forearm.R", X, [(1, -28), (1 + h, -12), (1 + n, -28)]),
        ("spine", Z, [(1, 5 * k), (1 + h, -5 * k), (1 + n, 5 * k)]),
        ("spine", X, [(1, 4 * k), (1 + n, 4 * k)]),
    ], [("hips", [(1, (0, 0, 0)), (1 + h // 2, (0, 0.03 * k, 0)), (1 + h, (0, 0, 0)), (1 + h + h // 2, (0, 0.03 * k, 0)), (1 + n, (0, 0, 0))])])
    n = int(0.6 * FPS)
    h = n // 2
    clip("run", [
        ("thigh.L", X, [(1, -45), (1 + h, 40), (1 + n, -45)]),
        ("thigh.R", X, [(1, 40), (1 + h, -45), (1 + n, 40)]),
        ("shin.L", X, [(1, 15), (1 + h // 2, 85), (1 + h, 15), (1 + n, 15)]),
        ("shin.R", X, [(1, 15), (1 + h, 15), (1 + h + h // 2, 85), (1 + n, 15)]),
        ("upper_arm.L", X, [(1, 40), (1 + h, -40), (1 + n, 40)]),
        ("upper_arm.R", X, [(1, -40), (1 + h, 40), (1 + n, -40)]),
        ("forearm.L", X, [(1, -80), (1 + n, -80)]),
        ("forearm.R", X, [(1, -80), (1 + n, -80)]),
        ("spine", X, [(1, 14), (1 + n, 14)]),
    ], [("hips", [(1, (0, 0, 0)), (1 + h // 2, (0, 0.05, 0)), (1 + h, (0, 0, 0)), (1 + h + h // 2, (0, 0.05, 0)), (1 + n, (0, 0, 0))])])

    # guard: fists up in front of the face, knees bent, weight bouncing (loop 1.2 s)
    n = int(1.2 * FPS)
    h = n // 2

    def guard_keys(f0, f1):
        return [
            ("upper_arm.L", X, [(f0, -55), (f1, -55)]),
            ("upper_arm.L", Z, [(f0, 22), (f1, 22)]),
            ("forearm.L", X, [(f0, -95), (f1, -95)]),
            ("upper_arm.R", X, [(f0, -40), (f1, -40)]),
            ("upper_arm.R", Z, [(f0, -22), (f1, -22)]),
            ("forearm.R", X, [(f0, -110), (f1, -110)]),
            ("spine", X, [(f0, 10), (f1, 10)]),
            ("spine", Z, [(f0, -12), (f1, -12)]),
            ("head", X, [(f0, -6), (f1, -6)]),
            ("thigh.L", X, [(f0, -22), (f1, -22)]),
            ("thigh.R", X, [(f0, 12), (f1, 12)]),
            ("shin.L", X, [(f0, 30), (f1, 30)]),
            ("shin.R", X, [(f0, 26), (f1, 26)]),
        ]

    clip("guard", guard_keys(1, 1 + n), [("hips", [(1, (0, -0.04, 0)), (1 + h, (0, -0.07, 0)), (1 + n, (0, -0.04, 0))])])

    # punch: from guard, a fast right straight and back (0.7 s)
    n = int(0.7 * FPS)
    hit_f = 1 + int(0.22 * FPS)
    back = 1 + int(0.45 * FPS)
    keys = [x for x in guard_keys(1, 1 + n) if not x[0].endswith(".R") or x[0].startswith("thigh") or x[0].startswith("shin")]
    keys = [x for x in keys if x[0] not in ("spine",)]
    keys += [
        ("upper_arm.R", X, [(1, -40), (hit_f, -88), (back, -88), (1 + n, -40)]),
        ("upper_arm.R", Z, [(1, -22), (hit_f, 8), (back, 8), (1 + n, -22)]),
        ("forearm.R", X, [(1, -110), (hit_f, -4), (back, -4), (1 + n, -110)]),
        ("spine", X, [(1, 10), (hit_f, 16), (back, 16), (1 + n, 10)]),
        ("spine", Z, [(1, -12), (hit_f, 22), (back, 22), (1 + n, -12)]),
    ]
    clip("punch", keys, [("hips", [(1, (0, -0.04, 0)), (hit_f, (0, -0.06, -0.04)), (1 + n, (0, -0.04, 0))])])

    # roar: arms spread wide and up, chest out, head back (1.6 s)
    n = int(1.6 * FPS)
    a, b = 1 + int(0.35 * FPS), 1 + int(1.2 * FPS)
    clip("roar", [
        ("upper_arm.L", Y, [(1, -8), (a, -105), (b, -105), (1 + n, -8)]),
        ("upper_arm.R", Y, [(1, 8), (a, 105), (b, 105), (1 + n, 8)]),
        ("forearm.L", Y, [(1, 0), (a, -45), (b, -45), (1 + n, 0)]),
        ("forearm.R", Y, [(1, 0), (a, 45), (b, 45), (1 + n, 0)]),
        ("spine", X, [(1, 0), (a, -12), (b, -12), (1 + n, 0)]),
        ("head", X, [(1, 0), (a, -18), (b, -18), (1 + n, 0)]),
        ("thigh.L", X, [(1, 0), (a, -10), (b, -10), (1 + n, 0)]),
        ("thigh.R", X, [(1, 0), (a, 10), (b, 10), (1 + n, 0)]),
    ], [("hips", [(1, (0, 0, 0)), (a, (0, -0.05, 0)), (b, (0, -0.05, 0)), (1 + n, (0, 0, 0))])])

    # hit: recoil backwards and recover (0.8 s)
    n = int(0.8 * FPS)
    a = 1 + int(0.15 * FPS)
    clip("hit", [
        ("spine", X, [(1, 0), (a, -22), (1 + n, 0)]),
        ("head", X, [(1, 0), (a, -25), (1 + n, 0)]),
        ("upper_arm.L", Y, [(1, -6), (a, -40), (1 + n, -6)]),
        ("upper_arm.R", Y, [(1, 6), (a, 40), (1 + n, 6)]),
        ("forearm.L", X, [(1, -10), (a, -40), (1 + n, -10)]),
        ("forearm.R", X, [(1, -10), (a, -40), (1 + n, -10)]),
        ("thigh.L", X, [(1, 0), (a, -18), (1 + n, 0)]),
        ("shin.L", X, [(1, 0), (a, 25), (1 + n, 0)]),
    ])


# ---- Volt ----------------------------------------------------------------------------------------

VOLT = dict(hip=0.95, neck=1.53, head=1.60, top=1.93, sx=0.25, sz=1.47, ez=1.19, wz=0.93, hand=0.1, lx=0.115, kz=0.52, az=0.09)


def build_volt():
    reset()
    J = VOLT
    arm = build_rig("Volt", J)
    suit = mat("volt_suit", (0.05, 0.055, 0.07, 1), 0.45, 0.3)
    white = mat("volt_armor", (0.86, 0.88, 0.9, 1), 0.22, 0.35, coat=0.6)
    cobalt = mat("volt_cobalt", (0.07, 0.2, 0.62, 1), 0.25, 0.55, coat=0.5)
    steel = mat("volt_steel", (0.55, 0.57, 0.6, 1), 0.3, 0.9)
    glow = mat("volt_glow", (0.2, 0.9, 1.0, 1), 0.2, 0.0, emit=(0.25, 0.9, 1.0, 1), strength=6.0)

    # continuous flexible suit: pelvis -> torso -> neck
    H = J["hip"]
    skinned_tube("suit_body", 0, 0, [
        (H - 0.14, 0.02, 0.02), (H - 0.12, 0.12, 0.09), (H - 0.06, 0.17, 0.11), (H + 0.04, 0.18, 0.115), (H + 0.15, 0.165, 0.105),
        (H + 0.3, 0.2, 0.12), (H + 0.44, 0.24, 0.14), (J["sz"] - 0.03, 0.235, 0.13), (J["neck"] - 0.02, 0.15, 0.1),
        (J["neck"] + 0.02, 0.065, 0.06), (J["head"] + 0.03, 0.06, 0.06), (J["head"] + 0.06, 0.02, 0.02)],
        torso_weights(J), lambda z: 1 if H + 0.16 < z < H + 0.24 else 0, [suit, cobalt], arm)
    for s, sg in (("L", 1), ("R", -1)):
        x = sg * J["sx"]
        skinned_tube("suit_arm" + s, x, 0, [
            (J["sz"] + 0.07, 0.02, 0.02), (J["sz"] + 0.05, 0.05, 0.05), (J["sz"], 0.066, 0.066), (J["ez"] + 0.1, 0.058, 0.058),
            (J["ez"], 0.05, 0.05), (J["wz"] + 0.08, 0.046, 0.046), (J["wz"], 0.04, 0.04), (J["wz"] - 0.03, 0.05, 0.04),
            (J["wz"] - 0.08, 0.05, 0.035), (J["wz"] - 0.12, 0.02, 0.02)],
            arm_weights(J, s), lambda z: 0, [suit], arm)
        lx = sg * J["lx"]
        skinned_tube("suit_leg" + s, lx, 0, [
            (H + 0.08, 0.02, 0.02), (H + 0.06, 0.07, 0.07), (H, 0.085, 0.085), (J["kz"] + 0.12, 0.07, 0.07), (J["kz"], 0.065, 0.065),
            (J["az"] + 0.12, 0.052, 0.052), (J["az"], 0.05, 0.05), (J["az"] - 0.04, 0.03, 0.03)],
            leg_weights(J, s), lambda z: 0, [suit], arm)

        # armour plates (rigid)
        rigid(sphere("pauldron" + s, 0.105, (x * 1.08, 0, J["sz"] + 0.02), white, (1.0, 1.05, 0.8)), arm, "upper_arm." + s)
        rigid(cube("pauldron_trim" + s, (0.03, 0.2, 0.05), (x * 1.42, 0, J["sz"] - 0.02), cobalt, 0.012), arm, "upper_arm." + s)
        rigid(cylinder("bicep" + s, 0.066, 0.16, (x, 0, J["sz"] - 0.16), white), arm, "upper_arm." + s)
        rigid(cylinder("gauntlet" + s, 0.06, 0.2, (x, 0, J["wz"] + 0.12), white), arm, "forearm." + s)
        rigid(cylinder("gauntlet_band" + s, 0.063, 0.03, (x, 0, J["wz"] + 0.2), cobalt), arm, "forearm." + s)
        rigid(sphere("gauntlet_light" + s, 0.018, (x + sg * 0.005, -0.058, J["wz"] + 0.12), glow), arm, "forearm." + s)
        rigid(cube("hand_plate" + s, (0.085, 0.07, 0.1), (x, 0, J["wz"] - 0.06), steel, 0.02), arm, "hand." + s)
        rigid(cube("thigh_plate" + s, (0.14, 0.15, 0.22), (lx, -0.01, J["kz"] + 0.2), white, 0.04), arm, "thigh." + s)
        rigid(sphere("knee" + s, 0.06, (lx, -0.055, J["kz"]), cobalt, (1, 0.8, 1)), arm, "shin." + s)
        rigid(cube("shin_plate" + s, (0.12, 0.13, 0.26), (lx, -0.01, J["kz"] - 0.2), white, 0.04), arm, "shin." + s)
        rigid(cube("boot" + s, (0.13, 0.25, 0.1), (lx, -0.045, 0.05), steel, 0.03), arm, "shin." + s)
        rigid(cube("boot_toe" + s, (0.12, 0.08, 0.06), (lx, -0.16, 0.035), cobalt, 0.02), arm, "shin." + s)

    rigid(cube("chest", (0.4, 0.24, 0.3), (0, -0.012, J["sz"] - 0.12), white, 0.06), arm, "spine")
    rigid(cube("chest_stripe", (0.08, 0.25, 0.28), (0, -0.018, J["sz"] - 0.12), cobalt, 0.02), arm, "spine")
    rigid(cylinder("core_ring", 0.06, 0.03, (0, -0.135, J["sz"] - 0.1), steel), arm, "spine").rotation_euler = (math.radians(90), 0, 0)
    core = sphere("core", 0.045, (0, -0.14, J["sz"] - 0.1), glow, (1, 0.5, 1))
    rigid(core, arm, "spine")
    rigid(cube("abs", (0.28, 0.2, 0.14), (0, -0.01, H + 0.3), steel, 0.04), arm, "spine")
    rigid(cube("belt", (0.36, 0.25, 0.07), (0, 0, H + 0.02), cobalt, 0.02), arm, "hips")
    rigid(cube("backpack", (0.3, 0.12, 0.3), (0, 0.15, J["sz"] - 0.12), steel, 0.04), arm, "spine")
    rigid(cylinder("collar", 0.09, 0.06, (0, 0, J["neck"] + 0.01), cobalt), arm, "neck")

    # helmet + face
    hc = J["head"] + 0.14
    rigid(sphere("helmet", 0.155, (0, 0, hc), white, (0.95, 1.05, 1.1), 32), arm, "head")
    rigid(cube("faceplate", (0.2, 0.07, 0.16), (0, -0.135, hc - 0.04), mat("volt_face", (0.03, 0.035, 0.05, 1), 0.2, 0.6), 0.03), arm, "head")
    rigid(cube("crest", (0.035, 0.26, 0.05), (0, 0.0, hc + 0.16), cobalt, 0.015), arm, "head")
    for sg in (1, -1):
        rigid(cube("ear", (0.03, 0.09, 0.1), (sg * 0.15, 0, hc), cobalt, 0.012), arm, "head")
        rigid(sphere("ear_light", 0.016, (sg * 0.166, 0, hc), glow), arm, "head")

    visor = subdivided_box("eyes", (0.17, 0.02, 0.032), (0, -0.172, hc + 0.005), glow, 4)
    shape_keys(visor, [("blink", lambda c: Vector((c.x, c.y, hc + 0.005 + (c.z - hc - 0.005) * 0.12))),
                       ("angry", lambda c: Vector((c.x, c.y, c.z - 0.012 * (1 - abs(c.x) / 0.085))))])
    rigid(visor, arm, "head")
    # speaker grille "mouth": three light bars that spread apart when talking
    bars = [subdivided_box("bar%d" % i, (0.07 - 0.012 * abs(i - 1), 0.012, 0.007), (0, -0.172, hc - 0.07 - 0.014 * i), glow, 2) for i in range(3)]
    mouth = join(bars, "mouth")
    mz = hc - 0.084

    shape_keys(mouth, [
        ("mouth_open", lambda c: Vector((c.x, c.y, mz + (c.z - mz) * 2.4))),
        ("mouth_oh", lambda c: Vector((c.x * 0.55, c.y, mz + (c.z - mz) * 1.9))),
        ("smile", lambda c: Vector((c.x * 1.1, c.y, c.z + (c.x / 0.035) ** 2 * 0.008))),
    ])
    rigid(mouth, arm, "head")
    add_clips(arm, heavy=False)
    export(os.path.join(OUT, "volt.glb"), animations=True)


# ---- Crag ----------------------------------------------------------------------------------------

CRAG = dict(hip=1.0, neck=1.86, head=1.93, top=2.22, sx=0.44, sz=1.8, ez=1.4, wz=1.03, hand=0.16, lx=0.2, kz=0.56, az=0.11)


def build_crag():
    reset()
    J = CRAG
    arm = build_rig("Crag", J)
    stone = mat("crag_stone", (0.23, 0.24, 0.28, 1), 0.85)
    stone_dark = mat("crag_stone_dark", (0.12, 0.12, 0.15, 1), 0.9)
    lava = mat("crag_lava", (1.0, 0.35, 0.05, 1), 0.4, emit=(1.0, 0.33, 0.04, 1), strength=5.0)
    cloth = mat("crag_cloth", (0.28, 0.17, 0.1, 1), 0.95)
    rope = mat("crag_rope", (0.5, 0.38, 0.22, 1), 0.9)
    H = J["hip"]

    def lava_bands(period, width, lo, hi, base=0):
        def f(z):
            if lo < z < hi and (z % period) < width:
                return 1
            return base

        return f

    # massive torso: barrel chest, broad shoulders, thick neck
    skinned_tube("body", 0, 0, [
        (H - 0.2, 0.02, 0.02), (H - 0.18, 0.2, 0.15), (H - 0.1, 0.27, 0.19), (H + 0.05, 0.29, 0.2), (H + 0.2, 0.3, 0.21),
        (H + 0.4, 0.36, 0.25), (H + 0.6, 0.44, 0.29), (J["sz"] - 0.08, 0.47, 0.3), (J["sz"] + 0.02, 0.38, 0.25),
        (J["neck"] - 0.02, 0.2, 0.17), (J["neck"] + 0.04, 0.15, 0.14), (J["head"] + 0.08, 0.13, 0.13), (J["head"] + 0.1, 0.02, 0.02)],
        torso_weights(J),
        lambda z: 2 if z < H + 0.08 else (1 if (H + 0.25 < z < J["sz"] - 0.1 and (z * 11.3) % 1.0 < 0.1) else 0),
        [stone, lava, cloth], arm)
    for s, sg in (("L", 1), ("R", -1)):
        x = sg * J["sx"]
        skinned_tube("arm" + s, x, 0, [
            (J["sz"] + 0.14, 0.03, 0.03), (J["sz"] + 0.1, 0.12, 0.12), (J["sz"] + 0.02, 0.16, 0.15), (J["sz"] - 0.12, 0.15, 0.14),
            (J["ez"] + 0.12, 0.12, 0.12), (J["ez"], 0.11, 0.11), (J["ez"] - 0.12, 0.125, 0.12), (J["wz"] + 0.12, 0.115, 0.11),
            (J["wz"] + 0.02, 0.09, 0.085), (J["wz"] - 0.03, 0.09, 0.085), (J["wz"] - 0.06, 0.03, 0.03)],
            arm_weights(J, s), lambda z: 1 if (J["wz"] + 0.05 < z < J["sz"] - 0.05 and (z * 9.1) % 1.0 < 0.09) else 0,
            [stone, lava], arm)
        # huge fists (rigid rock blocks) and knuckles
        rigid(cube("fist" + s, (0.19, 0.2, 0.2), (x, -0.01, J["wz"] - 0.1), stone_dark, 0.05), arm, "hand." + s)
        for k in range(4):
            rigid(sphere("knuckle%d%s" % (k, s), 0.03, (x - 0.07 + 0.047 * k, -0.105, J["wz"] - 0.1), stone), arm, "hand." + s)
        rigid(sphere("shoulder_rock" + s, 0.13, (x * 1.05, 0.03, J["sz"] + 0.08), stone_dark, (1.1, 1.0, 0.75)), arm, "upper_arm." + s)
        rigid(cylinder("wrist_rope" + s, 0.123, 0.04, (x, 0, J["wz"] + 0.06), rope), arm, "forearm." + s)
        lx = sg * J["lx"]
        skinned_tube("leg" + s, lx, 0, [
            (H + 0.06, 0.03, 0.03), (H + 0.04, 0.13, 0.13), (H - 0.04, 0.16, 0.16), (J["kz"] + 0.14, 0.14, 0.14), (J["kz"], 0.12, 0.12),
            (J["kz"] - 0.12, 0.125, 0.125), (J["az"] + 0.1, 0.1, 0.1), (J["az"], 0.095, 0.095), (J["az"] - 0.05, 0.04, 0.04)],
            leg_weights(J, s), lambda z: 1 if z > J["kz"] - 0.02 else 0, [stone, cloth], arm)
        rigid(cube("foot" + s, (0.22, 0.34, 0.11), (lx, -0.07, 0.055), stone_dark, 0.04), arm, "shin." + s)
        rigid(cube("shorts_rag" + s, (0.26, 0.3, 0.1), (lx, 0, J["kz"] + 0.16), cloth, 0.03), arm, "thigh." + s)
    rigid(cube("belt", (0.62, 0.44, 0.1), (0, 0, H + 0.03), rope, 0.03), arm, "hips")
    rigid(sphere("back_rock", 0.24, (0, 0.2, J["sz"] - 0.15), stone_dark, (1.4, 0.6, 1.0)), arm, "spine")
    for i, (px, pz) in enumerate(((-0.12, 0.12), (0.1, 0.05), (0.18, -0.12), (-0.2, -0.05))):
        rigid(sphere("chest_rock%d" % i, 0.06, (px, -0.27, J["sz"] - 0.3 + pz), stone_dark, (1.2, 0.6, 1.0)), arm, "spine")

    # head: small for the body, heavy jaw and brow
    hc = J["head"] + 0.14
    rigid(sphere("headmesh", 0.155, (0, 0, hc), stone, (1.0, 1.0, 1.05), 32), arm, "head")
    rigid(cube("jaw", (0.22, 0.17, 0.1), (0, -0.05, hc - 0.1), stone, 0.04), arm, "head")
    rigid(sphere("skull_rock", 0.1, (0.03, 0.04, hc + 0.13), stone_dark, (1.3, 1.2, 0.6)), arm, "head")
    brow = subdivided_box("brow", (0.23, 0.07, 0.045), (0, -0.13, hc + 0.05), stone_dark, 4)
    shape_keys(brow, [("angry", lambda c: Vector((c.x, c.y, c.z - 0.03 * (1 - min(1, abs(c.x) / 0.11)))))])
    rigid(brow, arm, "head")
    e1 = sphere("eyeL", 0.022, (0.055, -0.14, hc + 0.005), lava, (1, 0.6, 0.8), 16)
    e2 = sphere("eyeR", 0.022, (-0.055, -0.14, hc + 0.005), lava, (1, 0.6, 0.8), 16)
    eyes = join([e1, e2], "eyes")
    shape_keys(eyes, [("blink", lambda c: Vector((c.x, c.y, hc + 0.005 + (c.z - hc - 0.005) * 0.12)))])
    rigid(eyes, arm, "head")
    mouth = subdivided_box("mouth", (0.12, 0.03, 0.022), (0, -0.142, hc - 0.085), mat("crag_mouth", (0.35, 0.08, 0.02, 1), 0.5, emit=(0.8, 0.2, 0.02, 1), strength=1.5), 4)
    mz = hc - 0.085
    shape_keys(mouth, [
        ("mouth_open", lambda c: Vector((c.x * 0.95, c.y, mz + (c.z - mz) * 3.4 - 0.012))),
        ("mouth_oh", lambda c: Vector((c.x * 0.5, c.y, mz + (c.z - mz) * 2.6 - 0.008))),
        ("smile", lambda c: Vector((c.x * 1.1, c.y, c.z + (c.x / 0.06) ** 2 * 0.014))),
    ])
    rigid(mouth, arm, "head")
    add_clips(arm, heavy=True)
    export(os.path.join(OUT, "crag.glb"), animations=True)


# ---- city street -----------------------------------------------------------------------------------


def build_city():
    reset()
    asphalt = mat("asphalt", (0.07, 0.07, 0.08, 1), 0.75)
    wet = mat("asphalt_wet", (0.04, 0.04, 0.05, 1), 0.18, 0.2)
    paint_y = mat("paint_yellow", (0.95, 0.72, 0.1, 1), 0.6)
    paint_w = mat("paint_white", (0.9, 0.9, 0.88, 1), 0.6)
    concrete = mat("sidewalk", (0.42, 0.41, 0.4, 1), 0.85)
    curb = mat("curb", (0.55, 0.54, 0.52, 1), 0.8)
    brick = mat("brick", (0.42, 0.18, 0.12, 1), 0.85)
    brick2 = mat("brick_dark", (0.24, 0.13, 0.1, 1), 0.85)
    stonew = mat("stone_wall", (0.58, 0.55, 0.5, 1), 0.8)
    glassd = mat("glass_tower", (0.1, 0.16, 0.22, 1), 0.08, 0.8)
    win_lit = mat("window_lit", (0.9, 0.65, 0.4, 1), 0.3, emit=(1.0, 0.7, 0.4, 1), strength=0.9)
    win_dark = mat("window_dark", (0.05, 0.07, 0.1, 1), 0.1, 0.5)
    shop = mat("shop_window", (0.5, 0.42, 0.32, 1), 0.2, 0.2, emit=(1.0, 0.78, 0.5, 1), strength=0.45)
    metal = mat("lamp_metal", (0.12, 0.13, 0.14, 1), 0.4, 0.8)
    bulb = mat("lamp_bulb", (1.0, 0.9, 0.7, 1), 0.2, emit=(1.0, 0.85, 0.6, 1), strength=5.0)
    car_body = mat("car_paint", (0.62, 0.05, 0.06, 1), 0.2, 0.5, coat=1.0)
    tire = mat("tire", (0.03, 0.03, 0.03, 1), 0.9)
    carglass = mat("car_glass", (0.06, 0.08, 0.1, 1), 0.05, 0.3)
    red = mat("hydrant", (0.75, 0.1, 0.06, 1), 0.5)
    green = mat("bin", (0.12, 0.26, 0.16, 1), 0.6, 0.3)
    headl = mat("headlight", (1, 1, 0.9, 1), 0.2, emit=(1, 0.95, 0.8, 1), strength=6)
    taill = mat("taillight", (1, 0.1, 0.05, 1), 0.2, emit=(1, 0.05, 0.02, 1), strength=4)

    # Blender coords: x along the street, -y toward the camera side, z up
    cube("road", (60, 12, 0.1), (0, 0, -0.05), asphalt)
    for i, (px, py, sx, sy) in enumerate(((-2.5, 1.2, 3.5, 1.6), (3.2, -2.4, 2.4, 1.1), (7.0, 2.6, 2.8, 1.4))):
        o = cylinder("puddle%d" % i, 1.0, 0.004, (px, py, 0.002), wet, 48)
        o.scale = (sx / 2, sy / 2, 1)
    for k in range(-14, 15):  # double yellow centre line, dashed white lanes
        cube("dash%d" % k, (1.6, 0.12, 0.01), (k * 2.2, -3.0, 0.004), paint_w)
        cube("dashb%d" % k, (1.6, 0.12, 0.01), (k * 2.2, 3.0, 0.004), paint_w)
    cube("yellow1", (60, 0.1, 0.01), (0, 0.12, 0.004), paint_y)
    cube("yellow2", (60, 0.1, 0.01), (0, -0.12, 0.004), paint_y)
    for side in (-1, 1):  # crosswalks
        for k in range(12):
            cube("zebra%d_%d" % (side, k), (0.45, 3.4, 0.01), (side * 11 + (k - 5.5) * 0.9, 0, 0.005), paint_w)
    for sy in (-1, 1):
        cube("sidewalk%d" % sy, (60, 4.5, 0.18), (0, sy * 8.25, 0.09), concrete)
        cube("curb%d" % sy, (60, 0.25, 0.2), (0, sy * 6.1, 0.1), curb)
        for k in range(-7, 8):  # street lamps
            x = k * 8 + (0 if sy > 0 else 4)
            y = sy * 6.6
            cylinder("lamp_pole", 0.07, 5.2, (x, y, 2.6), metal, 16)
            cube("lamp_arm", (0.08, 1.3, 0.08), (x, y - sy * 0.62, 5.15), metal)
            cube("lamp_head", (0.35, 0.5, 0.14), (x, y - sy * 1.2, 5.08), metal, 0.03)
            cube("lamp_light", (0.28, 0.4, 0.03), (x, y - sy * 1.2, 5.0), bulb)
    # buildings on the far side (+y), with window grids
    x = -30.0
    idx = 0
    import random

    rnd = random.Random(7)
    while x < 30:
        w = rnd.uniform(5, 9)
        h = rnd.uniform(12, 34)
        d = rnd.uniform(8, 12)
        facade = [brick, brick2, stonew, glassd][idx % 4]
        cx = x + w / 2
        cube("bldg%d" % idx, (w - 0.25, d, h), (cx, 10.5 + d / 2, h / 2), facade)
        cube("cornice%d" % idx, (w - 0.1, 0.5, 0.35), (cx, 10.45, h - 0.2), curb)
        cube("storefront%d" % idx, (w - 0.8, 0.12, 2.6), (cx, 10.47, 1.6), shop if idx % 3 else win_dark)
        cube("awning%d" % idx, (w - 0.6, 1.3, 0.12), (cx, 9.9, 3.1), [car_body, green, metal][idx % 3])
        cols = max(2, int((w - 1.2) / 1.4))
        rows = int((h - 4.5) / 3.2)
        for r in range(rows):
            for c in range(cols):
                lit = rnd.random() < 0.42
                wx = cx - (cols - 1) * 1.4 / 2 + c * 1.4
                cube("win", (0.85, 0.1, 1.5), (wx, 10.46, 4.8 + r * 3.2), win_lit if lit else win_dark)
        x += w
        idx += 1
    # buildings behind the camera side (visible in reverse shots), plainer
    x = -30.0
    while x < 30:
        w = rnd.uniform(6, 10)
        h = rnd.uniform(10, 24)
        cube("bldgs%d" % idx, (w - 0.25, 8, h), (x + w / 2, -14.5, h / 2), [brick2, stonew][idx % 2])
        x += w
        idx += 1
    # parked car (generic sedan) on the near lane
    cx, cy = 5.2, 4.9
    cube("car_body", (4.4, 1.8, 0.7), (cx, cy, 0.62), car_body, 0.12)
    cube("car_cabin", (2.4, 1.6, 0.6), (cx - 0.2, cy, 1.2), carglass, 0.15)
    cube("car_roof", (2.2, 1.62, 0.08), (cx - 0.2, cy, 1.5), car_body, 0.04)
    for dx in (-1.4, 1.4):
        for dy in (-0.85, 0.85):
            o = cylinder("wheel", 0.36, 0.26, (cx + dx, cy + dy, 0.36), tire, 24)
            o.rotation_euler = (math.radians(90), 0, 0)
    for dy in (-0.6, 0.6):
        cube("headlight", (0.06, 0.3, 0.14), (cx + 2.2, cy + dy, 0.75), headl)
        cube("taillight", (0.06, 0.3, 0.12), (cx - 2.2, cy + dy, 0.78), taill)
    # street furniture
    cylinder("hydrant", 0.13, 0.6, (-4.5, 6.6, 0.48), red, 16)
    sphere("hydrant_top", 0.14, (-4.5, 6.6, 0.8), red)
    for i, bx in enumerate((-8.2, 9.5)):
        cylinder("bin%d" % i, 0.3, 0.9, (bx, 7.2, 0.63), green, 20)
    export(os.path.join(OUT, "city.glb"))


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    build_volt()
    build_crag()
    build_city()
