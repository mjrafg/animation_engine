"""
Builds the engine's reusable 3D test assets (GLB) with Blender, fully procedurally:

    blender -b --factory-startup -noaudio --python assets/3d/src/build_assets.py -- assets/3d

  character.glb  rigged low-poly character "Mika": 16 bones (root, hips, spine, neck, head,
                 upper_arm/forearm/hand .L/.R, thigh/shin .L/.R), clips idle (2 s), walk (1 s,
                 in place), wave (1.5 s, right arm), face morph targets on separate meshes:
                 mouth_open, smile, mouth_oh (mouth) and blink (eyes). Front faces +Z (glTF).
  mug.glb        prop, origin at the bottom centre, 10 cm tall.
  room.glb       environment: floor, two walls, window, rug, table (origin at floor centre).

No external inputs: re-running produces equivalent assets (same geometry, rig, clips and morphs;
the GLB bytes are not guaranteed identical between runs).
"""
import math
import os
import sys

import bpy
from mathutils import Matrix, Quaternion, Vector

OUT = sys.argv[sys.argv.index("--") + 1] if "--" in sys.argv else "."
FPS = 24


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.scene.render.fps = FPS


def mat(name, rgba, rough=0.6, metal=0.0):
    m = bpy.data.materials.get(name)
    if m:
        return m
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = rgba
    b.inputs["Roughness"].default_value = rough
    b.inputs["Metallic"].default_value = metal
    return m


def finish(o, name, material):
    o.name = name
    o.data.name = name
    o.data.materials.append(material)
    return o


def cube(name, size, loc, material, bevel=0.0):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc)
    o = bpy.context.active_object
    o.scale = size
    bpy.ops.object.transform_apply(scale=True)
    if bevel:
        mod = o.modifiers.new("bevel", "BEVEL")
        mod.width = bevel
        mod.segments = 2
        bpy.ops.object.modifier_apply(modifier="bevel")
    return finish(o, name, material)


def sphere(name, radius, loc, material, scale=(1, 1, 1), seg=24):
    bpy.ops.mesh.primitive_uv_sphere_add(radius=radius, location=loc, segments=seg, ring_count=seg // 2)
    o = bpy.context.active_object
    o.scale = scale
    bpy.ops.object.transform_apply(scale=True)
    bpy.ops.object.shade_smooth()
    return finish(o, name, material)


def cylinder(name, radius, depth, loc, material, verts=32):
    bpy.ops.mesh.primitive_cylinder_add(radius=radius, depth=depth, location=loc, vertices=verts)
    o = bpy.context.active_object
    return finish(o, name, material)


def export(path, animations=False):
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        export_animations=animations,
        export_animation_mode="NLA_TRACKS",
        export_morph=True,
        export_skins=True,
        export_yup=True,
        export_apply=False,
    )
    print("BUILT", path, os.path.getsize(path))


# ---- character ------------------------------------------------------------------------------

SKIN = (0.93, 0.74, 0.60, 1)
SHIRT = (0.16, 0.52, 0.62, 1)
PANTS = (0.18, 0.22, 0.38, 1)
HAIR = (0.20, 0.12, 0.08, 1)
DARK = (0.05, 0.04, 0.04, 1)
LIPS = (0.55, 0.15, 0.15, 1)
SHOE = (0.25, 0.16, 0.10, 1)


def build_character():
    reset()
    sc = bpy.context.scene
    data = bpy.data.armatures.new("MikaRig")
    arm = bpy.data.objects.new("Mika", data)
    sc.collection.objects.link(arm)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode="EDIT")

    def bone(name, head, tail, parent=None):
        b = data.edit_bones.new(name)
        b.head, b.tail, b.roll = head, tail, 0.0
        if parent:
            b.parent = data.edit_bones[parent]
            b.use_connect = False
        return b

    bone("root", (0, 0, 0), (0, 0.25, 0))
    bone("hips", (0, 0, 0.9), (0, 0, 1.05), "root")
    bone("spine", (0, 0, 1.05), (0, 0, 1.42), "hips")
    bone("neck", (0, 0, 1.42), (0, 0, 1.5), "spine")
    bone("head", (0, 0, 1.5), (0, 0, 1.82), "neck")
    for s, x in (("L", 0.23), ("R", -0.23)):
        bone("upper_arm." + s, (x, 0, 1.4), (x, 0, 1.14), "spine")
        bone("forearm." + s, (x, 0, 1.14), (x, 0, 0.9), "upper_arm." + s)
        bone("hand." + s, (x, 0, 0.9), (x, 0, 0.8), "forearm." + s)
        bone("thigh." + s, (x * 0.45, 0, 0.9), (x * 0.45, 0, 0.5), "hips")
        bone("shin." + s, (x * 0.45, 0, 0.5), (x * 0.45, 0, 0.08), "thigh." + s)
    bpy.ops.object.mode_set(mode="OBJECT")

    def skin(o, bone_name):
        vg = o.vertex_groups.new(name=bone_name)
        vg.add(list(range(len(o.data.vertices))), 1.0, "REPLACE")
        mod = o.modifiers.new("Armature", "ARMATURE")
        mod.object = arm
        o.parent = arm
        return o

    m_skin, m_shirt, m_pants = mat("skin", SKIN), mat("shirt", SHIRT), mat("pants", PANTS)
    skin(cube("torso", (0.42, 0.24, 0.5), (0, 0, 1.18), m_shirt, 0.04), "spine")
    skin(cube("pelvis", (0.38, 0.22, 0.2), (0, 0, 0.95), m_pants, 0.03), "hips")
    skin(cylinder("neckmesh", 0.05, 0.1, (0, 0, 1.47), m_skin), "neck")
    skin(sphere("headmesh", 0.17, (0, 0, 1.65), m_skin, (1, 0.95, 1.08)), "head")
    skin(sphere("hair", 0.178, (0, 0.02, 1.69), mat("hair", HAIR), (1.02, 1.0, 0.95)), "head")
    # cut the hair cap: delete the front/lower vertices so the face shows
    hair = bpy.data.objects["hair"]
    bpy.context.view_layer.objects.active = hair
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="DESELECT")
    bpy.ops.object.mode_set(mode="OBJECT")
    for v in hair.data.vertices:
        v.select = (v.co.z < 1.66 and v.co.y < 0.05) or v.co.z < 1.57 or (v.co.y < -0.08 and v.co.z < 1.74)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.delete(type="VERT")
    bpy.ops.object.mode_set(mode="OBJECT")
    skin(sphere("nose", 0.022, (0, -0.172, 1.63), m_skin), "head")

    # eyes: one mesh, shape key "blink" squashes both eyes vertically
    e1 = sphere("eyeL", 0.024, (0.062, -0.152, 1.675), mat("eye", DARK, 0.3), (1, 0.6, 1.25), 16)
    e2 = sphere("eyeR", 0.024, (-0.062, -0.152, 1.675), mat("eye", DARK, 0.3), (1, 0.6, 1.25), 16)
    bpy.ops.object.select_all(action="DESELECT")
    e1.select_set(True)
    e2.select_set(True)
    bpy.context.view_layer.objects.active = e1
    bpy.ops.object.join()
    eyes = bpy.context.active_object
    eyes.name = eyes.data.name = "eyes"
    eyes.shape_key_add(name="Basis")
    k = eyes.shape_key_add(name="blink")
    for i, v in enumerate(eyes.data.vertices):
        k.data[i].co = Vector((v.co.x, v.co.y, 1.675 + (v.co.z - 1.675) * 0.12))
    skin(eyes, "head")

    # mouth: a thin dark bar; shape keys open / smile / oh
    mouth = cube("mouth", (0.085, 0.02, 0.014), (0, -0.162, 1.585), mat("lips", LIPS, 0.4))
    bpy.context.view_layer.objects.active = mouth
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.subdivide(number_cuts=4)
    bpy.ops.object.mode_set(mode="OBJECT")
    mouth.shape_key_add(name="Basis")
    cz = 1.585

    def key(name, fn):
        kk = mouth.shape_key_add(name=name)
        for i, v in enumerate(mouth.data.vertices):
            kk.data[i].co = fn(v.co.copy())

    key("mouth_open", lambda c: Vector((c.x * 0.9, c.y, cz + (c.z - cz) * 4.5 - 0.012)))
    key("smile", lambda c: Vector((c.x * 1.15, c.y, c.z + 0.9 * (c.x / 0.0425) ** 2 * 0.018)))
    key("mouth_oh", lambda c: Vector((c.x * 0.45, c.y, cz + (c.z - cz) * 3.2 - 0.006)))
    skin(mouth, "head")

    for s, x in (("L", 0.23), ("R", -0.23)):
        skin(cube("uarm" + s, (0.11, 0.11, 0.28), (x, 0, 1.28), m_shirt, 0.02), "upper_arm." + s)
        skin(cube("farm" + s, (0.09, 0.09, 0.25), (x, 0, 1.02), m_skin, 0.02), "forearm." + s)
        skin(sphere("hand" + s, 0.055, (x, 0, 0.85), m_skin, (0.9, 0.7, 1.1), 16), "hand." + s)
        skin(cube("thigh" + s, (0.14, 0.14, 0.4), (x * 0.45, 0, 0.7), m_pants, 0.02), "thigh." + s)
        skin(cube("shin" + s, (0.12, 0.12, 0.38), (x * 0.45, 0, 0.3), m_pants, 0.02), "shin." + s)
        skin(cube("shoe" + s, (0.13, 0.22, 0.08), (x * 0.45, -0.04, 0.04), mat("shoe", SHOE), 0.02), "shin." + s)

    # ---- clips: rotations given about WORLD axes at rest, converted to each bone's local frame
    arm.animation_data_create()
    rest = {b.name: b.matrix_local.to_3x3() for b in data.bones}

    def local_q(bone_name, axis, deg):
        ax = (rest[bone_name].inverted() @ Vector(axis)).normalized()
        return Quaternion(ax, math.radians(deg))

    def clip(name, length, keys, loc_keys=()):
        act = bpy.data.actions.new(name)
        arm.animation_data.action = act
        for pb in arm.pose.bones:
            pb.rotation_mode = "QUATERNION"
        for bone_name, axis, frames in keys:
            pb = arm.pose.bones[bone_name]
            for f, deg in frames:
                pb.rotation_quaternion = local_q(bone_name, axis, deg)
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
    n = 2 * FPS  # idle: 2 s
    clip("idle", n, [
        ("spine", X, [(1, 0), (1 + n // 2, 2.5), (1 + n, 0)]),
        ("head", Z, [(1, 0), (1 + n // 4, 5), (1 + 3 * n // 4, -5), (1 + n, 0)]),
        ("upper_arm.L", Y, [(1, -4), (1 + n // 2, -6), (1 + n, -4)]),
        ("upper_arm.R", Y, [(1, 4), (1 + n // 2, 6), (1 + n, 4)]),
    ])
    n = FPS  # walk: 1 s cycle, in place (move the object with the timeline)
    h = n // 2
    clip("walk", n, [
        ("thigh.L", X, [(1, -28), (1 + h, 28), (1 + n, -28)]),
        ("thigh.R", X, [(1, 28), (1 + h, -28), (1 + n, 28)]),
        ("shin.L", X, [(1, 10), (1 + h // 2, 35), (1 + h, 5), (1 + n, 10)]),
        ("shin.R", X, [(1, 5), (1 + h, 10), (1 + h + h // 2, 35), (1 + n, 5)]),
        ("upper_arm.L", X, [(1, 22), (1 + h, -22), (1 + n, 22)]),
        ("upper_arm.R", X, [(1, -22), (1 + h, 22), (1 + n, -22)]),
        ("forearm.L", X, [(1, -10), (1 + h, -25), (1 + n, -10)]),
        ("forearm.R", X, [(1, -25), (1 + h, -10), (1 + n, -25)]),
        ("spine", Z, [(1, 4), (1 + h, -4), (1 + n, 4)]),
    ], [("hips", [(1, (0, 0, 0)), (1 + h // 2, (0, 0.025, 0)), (1 + h, (0, 0, 0)), (1 + h + h // 2, (0, 0.025, 0)), (1 + n, (0, 0, 0))])])
    n = int(1.5 * FPS)  # wave: raise right arm, wave the forearm, lower
    clip("wave", n, [
        ("upper_arm.R", Y, [(1, 0), (9, 155), (n - 7, 155), (1 + n, 0)]),
        ("forearm.R", Y, [(1, 0), (9, 0), (13, 30), (18, -25), (23, 30), (28, -25), (n - 7, 0), (1 + n, 0)]),
        ("head", Z, [(1, 0), (9, -8), (n - 7, -8), (1 + n, 0)]),
    ])
    export(os.path.join(OUT, "character.glb"), animations=True)


# ---- props & environment --------------------------------------------------------------------

def build_mug():
    reset()
    m = mat("ceramic", (0.92, 0.25, 0.18, 1), 0.35)
    body = cylinder("mug", 0.04, 0.1, (0, 0, 0.05), m)
    inner = cylinder("coffee", 0.034, 0.005, (0, 0, 0.092), mat("coffee", (0.18, 0.09, 0.04, 1), 0.2))
    bpy.ops.mesh.primitive_torus_add(major_radius=0.025, minor_radius=0.007, location=(0.045, 0, 0.05), rotation=(math.radians(90), 0, 0))
    handle = finish(bpy.context.active_object, "handle", m)
    bpy.ops.object.select_all(action="DESELECT")
    for o in (body, inner, handle):
        o.select_set(True)
    bpy.context.view_layer.objects.active = body
    bpy.ops.object.join()
    export(os.path.join(OUT, "mug.glb"))


def build_room():
    reset()
    wood = mat("floor_wood", (0.55, 0.38, 0.24, 1), 0.7)
    wall = mat("wall", (0.86, 0.83, 0.76, 1), 0.9)
    trim = mat("trim", (0.95, 0.95, 0.93, 1), 0.5)
    glass = mat("window", (0.62, 0.80, 0.95, 1), 0.1)
    rug = mat("rug", (0.55, 0.16, 0.20, 1), 0.95)
    table = mat("table", (0.36, 0.22, 0.12, 1), 0.5)
    cube("floor", (8, 8, 0.1), (0, 0, -0.05), wood)
    cube("back_wall", (8, 0.1, 3), (0, 4, 1.5), wall)
    cube("left_wall", (0.1, 8, 3), (-4, 0, 1.5), wall)
    cube("baseboard", (8, 0.12, 0.12), (0, 3.94, 0.06), trim)
    # front faces kept >= 1 cm apart (wall 3.95, frame 3.90, glass 3.92) to avoid z-fighting
    cube("window_frame", (1.7, 0.1, 1.2), (1.2, 3.95, 1.7), trim)
    cube("window_glass", (1.5, 0.1, 1.0), (1.2, 3.97, 1.7), glass)
    cylinder("rug", 1.3, 0.01, (0, 0.2, 0.005), rug, 64)
    cube("table_top", (1.2, 0.7, 0.05), (1.6, 1.6, 0.75), table)
    for dx in (-0.53, 0.53):
        for dy in (-0.3, 0.3):
            cube("table_leg", (0.05, 0.05, 0.73), (1.6 + dx, 1.6 + dy, 0.365), table)
    cube("frame_picture", (0.9, 0.06, 0.6), (-1.5, 3.94, 1.8), mat("picture", (0.2, 0.35, 0.5, 1), 0.6))
    export(os.path.join(OUT, "room.glb"))


os.makedirs(OUT, exist_ok=True)
build_character()
build_mug()
build_room()
