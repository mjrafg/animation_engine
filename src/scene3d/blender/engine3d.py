"""
Blender side of the video engine's 3D backend.

    blender -b --factory-startup -noaudio --python engine3d.py -- job.json

The engine (TypeScript) owns the scene, the timeline and all animation decisions. For every frame
it bakes a complete state (transforms, active clips with clip time and weight, morph weights,
camera, lights, world) into the job file. This script only builds the Blender scene once, applies
each baked state and draws it (mode "render"), measures it (mode "measure") or renders an asset
thumbnail (mode "thumbnail"). It never decides timing itself.

Coordinates: the engine uses glTF space (metres, +Y up, model front +Z, Euler degrees applied
X then Y then Z about fixed axes). Blender is Z up. A "WorldRoot" empty rotated +90 deg about X
maps engine space to Blender space, and each imported model sits under an "undo" empty rotated
-90 deg about X that maps the Z-up import back to glTF space, so instance transforms are applied
in pure glTF space.

Protocol: one line per event on stdout, prefixed "VE3D " followed by JSON:
    {"event": "ready", ...} {"event": "frame", "frame": n, "file": ...} {"event": "measure", ...}
    {"event": "error", "code": ..., "message": ...} {"event": "done"}
"""
import json
import math
import os
import sys
import time
import traceback

import bpy
from mathutils import Euler, Matrix, Vector
from bpy_extras.object_utils import world_to_camera_view

C = Matrix.Rotation(math.radians(90.0), 4, "X")  # engine (glTF) space -> Blender world
CI = C.inverted()


def emit(obj):
    sys.stdout.write("\nVE3D " + json.dumps(obj) + "\n")
    sys.stdout.flush()


class JobError(Exception):
    def __init__(self, code, message, details=None):
        super().__init__(message)
        self.code = code
        self.details = details or {}


# ---- helpers --------------------------------------------------------------------------------

def srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def color(hexstr):
    h = hexstr.lstrip("#")
    rgb = [srgb_to_linear(int(h[i:i + 2], 16) / 255.0) for i in (0, 2, 4)]
    a = int(h[6:8], 16) / 255.0 if len(h) == 8 else 1.0
    return rgb, a


def rad(v):
    return (math.radians(v["x"]), math.radians(v["y"]), math.radians(v["z"]))


def vec(v):
    return Vector((v["x"], v["y"], v["z"]))


def trs(pos, rot, scl):
    m = Matrix.Translation(vec(pos))
    e = Euler(rad(rot), "XYZ").to_matrix().to_4x4()
    s = Matrix.Diagonal((scl["x"], scl["y"], scl["z"], 1.0))
    return m @ e @ s


def xyz(v, nd=4):
    return {"x": round(v[0], nd), "y": round(v[1], nd), "z": round(v[2], nd)}


def decompose_engine(mw):
    """Blender world matrix -> engine-space position / rotation (deg) / scale."""
    mg = CI @ mw
    loc, q, s = mg.decompose()
    e = q.to_euler("XYZ")
    return {"position": xyz(loc), "rotation": xyz([math.degrees(a) for a in e], 2), "scale": xyz(s)}


def new_empty(name, parent=None):
    o = bpy.data.objects.new(name, None)
    bpy.context.scene.collection.objects.link(o)
    o.empty_display_size = 0.2
    if parent is not None:
        o.parent = parent
    return o


def material(name, spec):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes.get("Principled BSDF")
    rgb, a = color(spec.get("color", "#bbbbbb"))
    bsdf.inputs["Base Color"].default_value = (*rgb, 1.0)
    bsdf.inputs["Roughness"].default_value = spec.get("roughness", 0.6)
    bsdf.inputs["Metallic"].default_value = spec.get("metallic", 0.0)
    if a < 1.0:
        bsdf.inputs["Alpha"].default_value = a
    return m


# ---- instances ------------------------------------------------------------------------------

class Instance:
    def __init__(self, spec):
        self.id = spec["id"]
        self.spec = spec
        self.root = None  # engine-space transform empty
        self.undo = None  # -90 X: Z-up content back to glTF space
        self.objects = []  # every Blender object belonging to this instance (not children instances)
        self.meshes = []
        self.armature = None
        self.clip_actions = {}  # clip name -> [(owner, action)]
        self.clip_dur = spec.get("clipDurations", {})
        self.groups = {}  # (owner ptr, struct path, attr) -> group
        self.action_groups = {}  # action name -> {group key: [(idx, fcurve)]}
        self.attach = spec.get("attach")


def import_gltf(path):
    before = set(bpy.data.objects)
    try:
        bpy.ops.import_scene.gltf(filepath=path)
    except Exception as e:  # noqa: BLE001
        raise JobError("INVALID_ASSET", "Blender could not import %s: %s" % (os.path.basename(path), e))
    return [o for o in bpy.data.objects if o not in before]


def build_model(inst, path):
    new = import_gltf(path)
    # bone display shapes created by the importer must never render
    shapes = set()
    for o in new:
        if o.type == "ARMATURE":
            for pb in o.pose.bones:
                if pb.custom_shape is not None:
                    shapes.add(pb.custom_shape)
    for s in shapes:
        s.hide_render = True
        s.hide_viewport = True
        for coll in list(s.users_collection):
            coll.objects.unlink(s)
    new = [o for o in new if o not in shapes]
    for o in new:
        if o.parent is None:
            o.parent = inst.undo
            o.matrix_parent_inverse = Matrix.Identity(4)
    inst.objects = new
    inst.meshes = [o for o in new if o.type == "MESH"]
    arms = [o for o in new if o.type == "ARMATURE"]
    inst.armature = arms[0] if arms else None

    # clips: imported as one NLA track per glTF animation (track name = clip name) on every
    # animated owner (armature, animated nodes, shape-key blocks). Keep the actions, clear the NLA
    # so nothing animates on its own; clips are applied manually per frame.
    owners = list(new) + [o.data.shape_keys for o in inst.meshes if o.data and o.data.shape_keys]
    for owner in owners:
        ad = owner.animation_data
        if ad is None:
            continue
        for tr in list(ad.nla_tracks):
            if tr.strips:
                act = tr.strips[0].action
                if act is not None:
                    act.use_fake_user = True
                    inst.clip_actions.setdefault(tr.name, []).append((owner, act))
            ad.nla_tracks.remove(tr)
        if ad.action is not None and not inst.clip_actions:
            act = ad.action
            act.use_fake_user = True
            inst.clip_actions.setdefault(act.name, []).append((owner, act))
        ad.action = None

    # channel groups
    for name, lst in inst.clip_actions.items():
        for owner, act in lst:
            table = inst.action_groups.setdefault(act.name, {})
            for fc in act.fcurves:
                head, _, attr = fc.data_path.rpartition(".")
                try:
                    struct = owner.path_resolve(head) if head else owner
                    cur = getattr(struct, attr)
                except Exception:  # noqa: BLE001
                    continue
                key = (owner.as_pointer(), head, attr)
                if key not in inst.groups:
                    is_arr = hasattr(cur, "__len__") and not isinstance(cur, str)
                    if head.startswith("pose.bones["):
                        rest = {"location": [0, 0, 0], "rotation_quaternion": [1, 0, 0, 0], "scale": [1, 1, 1], "rotation_euler": [0, 0, 0]}.get(attr)
                        rest = list(rest) if rest is not None else (list(cur) if is_arr else cur)
                    else:
                        rest = list(cur) if is_arr else cur
                    inst.groups[key] = {"struct": struct, "attr": attr, "array": is_arr, "rest": rest}
                table.setdefault(key, []).append((fc.array_index, fc))


def build_primitive(inst, p):
    shape = p["shape"]
    size = p.get("size")
    sx, sy, sz = (size["x"], size["y"], size["z"]) if size else {"plane": (10, 0, 10)}.get(shape, (1, 1, 1))
    # created in glTF-space terms under the undo empty: glTF (x, y, z) == Blender local (x, -z, y)
    if shape == "plane":
        bpy.ops.mesh.primitive_plane_add(size=1)
        o = bpy.context.active_object
        o.scale = (sx, sz, 1)
    elif shape == "box":
        bpy.ops.mesh.primitive_cube_add(size=1)
        o = bpy.context.active_object
        o.scale = (sx, sz, sy)
        o.location = (0, 0, sy / 2)
    elif shape == "sphere":
        bpy.ops.mesh.primitive_uv_sphere_add(radius=0.5, segments=48, ring_count=24)
        o = bpy.context.active_object
        o.scale = (sx, sx, sx)
        o.location = (0, 0, sx / 2)
        bpy.ops.object.shade_smooth()
    elif shape == "cylinder":
        bpy.ops.mesh.primitive_cylinder_add(radius=0.5, depth=1, vertices=48)
        o = bpy.context.active_object
        o.scale = (sx, sz, sy)
        o.location = (0, 0, sy / 2)
    else:
        raise JobError("INVALID_VALUE", "unknown primitive %s" % shape)
    o.name = "%s_prim" % inst.id
    o.data.materials.append(material("%s_mat" % inst.id, p))
    o.parent = inst.undo
    o.matrix_parent_inverse = Matrix.Identity(4)
    inst.objects = [o]
    inst.meshes = [o]


# ---- scene ----------------------------------------------------------------------------------

class Scene3D:
    def __init__(self, job):
        self.job = job
        bpy.ops.wm.read_factory_settings(use_empty=True)
        self.sc = bpy.context.scene
        self.sc.render.fps = 24
        self.world_root = new_empty("WorldRoot")
        self.world_root.rotation_euler = (math.radians(90), 0, 0)
        self.instances = {}
        self.order = []
        self.lights = {}
        self._setup_render()
        self._build_objects()
        self._build_lights()
        self._build_camera()
        bpy.context.view_layer.update()

    def _setup_render(self):
        job, sc = self.job, self.sc
        r = job["render"]
        sc.render.resolution_x = job["width"]
        sc.render.resolution_y = job["height"]
        sc.render.resolution_percentage = 100
        sc.render.image_settings.file_format = "PNG"
        sc.render.image_settings.color_depth = "8"
        sc.render.film_transparent = bool(r.get("transparent"))
        sc.render.image_settings.color_mode = "RGBA" if r.get("transparent") else "RGB"
        engine = r.get("engine", "cycles")
        quality = r.get("quality", "standard")
        if engine == "cycles":
            sc.render.engine = "CYCLES"
            sc.cycles.samples = r.get("samples") or {"draft": 8, "standard": 24, "high": 64}[quality]
            sc.cycles.preview_samples = sc.cycles.samples
            try:
                import _cycles

                oidn = bool(getattr(_cycles, "with_openimagedenoise", False))
            except Exception:  # noqa: BLE001
                oidn = False
            sc.cycles.use_denoising = oidn and quality != "draft"
            if quality == "draft":
                sc.cycles.max_bounces = 4
            self.device = self._cycles_device(r.get("device", "CPU"))
        elif engine == "eevee":
            try:
                sc.render.engine = "BLENDER_EEVEE_NEXT"
            except TypeError:
                sc.render.engine = "BLENDER_EEVEE"
            sc.eevee.taa_render_samples = r.get("samples") or {"draft": 8, "standard": 32, "high": 64}[quality]
            try:
                sc.eevee.use_soft_shadows = quality != "draft"
                sc.eevee.use_gtao = quality == "high"
                sc.eevee.gtao_distance = 0.5
                if quality == "high":
                    sc.eevee.shadow_cube_size = "1024"
                    sc.eevee.shadow_cascade_size = "2048"
            except AttributeError:  # EEVEE Next (4.2+) has different shadow settings
                pass
            self.device = "OpenGL/EGL"
        else:
            sc.render.engine = "BLENDER_WORKBENCH"
            sc.display.shading.light = "STUDIO"
            sc.display.shading.color_type = "MATERIAL"
            sc.display.shading.show_shadows = True
            self.device = "CPU"
        for k, v in (r.get("tune") or {}).items():  # experiments only
            obj, _, attr = k.rpartition(".")
            setattr({"cycles": sc.cycles, "render": sc.render, "eevee": sc.eevee}[obj], attr, v)
        sc.view_settings.view_transform = "Standard"
        sc.view_settings.look = "None"
        world = bpy.data.worlds.new("World")
        world.use_nodes = True
        sc.world = world
        self.bg = world.node_tree.nodes.get("Background")

    def _cycles_device(self, want):
        sc = self.sc
        sc.cycles.device = "CPU"
        if want != "GPU":
            return "CPU"
        try:
            prefs = bpy.context.preferences.addons["cycles"].preferences
            for kind in ("OPTIX", "CUDA", "HIP", "ONEAPI", "METAL"):
                try:
                    prefs.compute_device_type = kind
                except TypeError:
                    continue
                prefs.get_devices()
                devs = [d for d in prefs.devices if d.type == kind]
                if devs:
                    for d in prefs.devices:
                        d.use = d.type == kind
                    sc.cycles.device = "GPU"
                    return "GPU/" + kind
        except Exception:  # noqa: BLE001
            pass
        return "CPU"

    def _build_objects(self):
        specs = self.job["objects"]
        for spec in specs:
            inst = Instance(spec)
            inst.root = new_empty("OBJ_%s" % spec["id"])
            inst.undo = new_empty("UNDO_%s" % spec["id"], inst.root)
            inst.undo.rotation_euler = (math.radians(-90), 0, 0)
            if spec.get("asset"):
                build_model(inst, spec["asset"])
            elif spec.get("primitive"):
                build_primitive(inst, spec["primitive"])
            self.instances[spec["id"]] = inst
        for spec in specs:
            inst = self.instances[spec["id"]]
            if spec.get("parent"):
                inst.root.parent = self.instances[spec["parent"]].root
            elif not spec.get("attach"):
                inst.root.parent = self.world_root
            # attached objects have no parent: their world matrix is computed per frame
        # order: parents / attach targets before dependants
        done, order = set(), []

        def visit(i):
            if i in done:
                return
            done.add(i)
            s = self.instances[i].spec
            dep = s.get("parent") or (s.get("attach") or {}).get("object")
            if dep:
                visit(dep)
            order.append(i)

        for s in specs:
            visit(s["id"])
        self.order = order
        for inst in self.instances.values():
            if inst.attach:
                target = self.instances[inst.attach["object"]]
                if target.armature is None or inst.attach["bone"] not in target.armature.pose.bones:
                    raise JobError("BONE_NOT_FOUND", "bone %s not found on %s" % (inst.attach["bone"], target.id))

    def _build_lights(self):
        for spec in self.job["lights"]:
            kind = {"sun": "SUN", "point": "POINT", "spot": "SPOT", "area": "AREA"}[spec["type"]]
            data = bpy.data.lights.new(spec["id"], kind)
            o = bpy.data.objects.new("LIGHT_%s" % spec["id"], data)
            self.sc.collection.objects.link(o)
            o.parent = self.world_root
            size = spec.get("size", 0.25)
            if kind == "SUN":
                data.angle = math.radians(size)
            elif kind == "AREA":
                data.size = max(size, 0.001)
            else:
                data.shadow_soft_size = size
            if kind == "SPOT":
                data.spot_size = math.radians(spec.get("spotAngle", 45))
            shadows = bool(spec.get("shadows", True))
            try:
                data.use_shadow = shadows
            except Exception:  # noqa: BLE001
                pass
            try:
                data.cycles.cast_shadow = shadows
            except Exception:  # noqa: BLE001
                pass
            self.lights[spec["id"]] = o

    def _build_camera(self):
        cam = bpy.data.cameras.new("Camera")
        cam.sensor_fit = "VERTICAL"
        cam.clip_start = self.job["camera"].get("near", 0.05)
        cam.clip_end = self.job["camera"].get("far", 500)
        self.cam = bpy.data.objects.new("Camera", cam)
        self.sc.collection.objects.link(self.cam)
        self.cam.parent = self.world_root
        self.sc.camera = self.cam

    # ---- per-frame state ----------------------------------------------------------------------

    def apply(self, state):
        objs = {o["id"]: o for o in state["objects"]}
        for inst in self.instances.values():
            st = objs[inst.id]
            if not inst.attach:
                inst.root.location = vec(st["position"])
                inst.root.rotation_mode = "XYZ"
                inst.root.rotation_euler = rad(st["rotation"])
                inst.root.scale = vec(st["scale"])
            self._apply_clips(inst, st["clips"])
            for name, w in st.get("morphs", {}).items():
                for m in inst.meshes:
                    keys = m.data.shape_keys
                    if keys and name in keys.key_blocks:
                        keys.key_blocks[name].value = w
        # visibility: a hidden object hides its (parent-)children
        for inst in self.instances.values():
            for o in inst.objects:
                o.hide_render = False
        for inst in self.instances.values():
            if not objs[inst.id]["visible"]:
                for o in inst.root.children_recursive:
                    if o.type != "EMPTY":
                        o.hide_render = True
        # world
        rgb, _ = color(state["world"]["color"])
        self.bg.inputs["Color"].default_value = (*rgb, 1.0)
        self.bg.inputs["Strength"].default_value = state["world"]["strength"]
        # lights
        for l in state["lights"]:
            o = self.lights[l["id"]]
            o.location = vec(l["position"])
            o.rotation_mode = "XYZ"
            o.rotation_euler = rad(l["rotation"])
            rgb, _ = color(l["color"])
            o.data.color = rgb
            o.data.energy = l["intensity"]
        bpy.context.view_layer.update()
        # attachments (in dependency order) follow the evaluated pose
        for i in self.order:
            inst = self.instances[i]
            if inst.attach:
                self._place_attached(inst, objs[i])
                bpy.context.view_layer.update()
        self._apply_camera(state["camera"])
        bpy.context.view_layer.update()

    def _apply_clips(self, inst, clips):
        if not inst.groups:
            return
        total = min(1.0, sum(c["weight"] for c in clips))
        acc = {}
        for c in clips:
            lst = inst.clip_actions.get(c["name"])
            if not lst:
                raise JobError("CLIP_NOT_FOUND", "clip %s not found on %s" % (c["name"], inst.id))
            w = c["weight"]
            dur = inst.clip_dur.get(c["name"], 0)
            for owner, act in lst:
                f0, f1 = act.frame_range
                frame = f0 + (c["time"] / dur) * (f1 - f0) if dur > 0 else f0
                table = inst.action_groups.get(act.name, {})
                for key, g in inst.groups.items():
                    if key[0] != owner.as_pointer():
                        continue
                    chans = table.get(key)
                    if g["array"]:
                        v = list(g["rest"])
                        for idx, fc in chans or []:
                            v[idx] = fc.evaluate(frame)
                    else:
                        v = chans[0][1].evaluate(frame) if chans else g["rest"]
                    a = acc.get(key)
                    if a is None:
                        acc[key] = [x * w for x in v] if g["array"] else v * w
                    elif g["array"]:
                        if g["attr"] == "rotation_quaternion" and sum(p * q for p, q in zip(a, v)) < 0:
                            v = [-x for x in v]
                        acc[key] = [p + x * w for p, x in zip(a, v)]
                    else:
                        acc[key] = a + v * w
        for key, g in inst.groups.items():
            rest = g["rest"]
            a = acc.get(key)
            if g["array"]:
                if a is None:
                    v = list(rest)
                else:
                    if g["attr"] == "rotation_quaternion" and sum(p * q for p, q in zip(a, rest)) < 0:
                        rest = [-x for x in rest]
                    v = [p + r * (1 - total) for p, r in zip(a, rest)]
                    if g["attr"] == "rotation_quaternion":
                        n = math.sqrt(sum(x * x for x in v)) or 1.0
                        v = [x / n for x in v]
                arr = getattr(g["struct"], g["attr"])
                for i, x in enumerate(v):
                    arr[i] = x
            else:
                setattr(g["struct"], g["attr"], rest if a is None else a + rest * (1 - total))

    def _place_attached(self, inst, st):
        """Offsets are expressed in the target's own engine space at its rest pose; the object then
        follows the bone's deformation (full) or only its position."""
        at = inst.attach
        target = self.instances[at["object"]]
        arm = target.armature
        pb = arm.pose.bones[at["bone"]]
        A = arm.matrix_world
        D = A @ pb.matrix @ pb.bone.matrix_local.inverted() @ A.inverted()  # rest world -> posed world
        G = target.root.matrix_world  # target's engine space -> world
        head_rest = G.inverted() @ (A @ pb.bone.head_local)
        L = trs(st["position"], st["rotation"], st["scale"])
        base = G @ Matrix.Translation(head_rest)
        if at.get("follow", "full") == "full":
            M = D @ base @ L
        else:
            M = Matrix.Translation(D @ base.translation) @ base.to_3x3().to_4x4() @ L
        inst.root.matrix_world = M

    def target_point(self, look):
        if "object" in look:
            inst = self.instances[look["object"]]
            bone = look.get("bone")
            if bone:
                arm = inst.armature
                return arm.matrix_world @ arm.pose.bones[bone].head
            b = self.world_bounds(inst, precise=False)
            return (b[0] + b[1]) / 2 if b else inst.root.matrix_world.translation
        return C @ vec(look)

    def _apply_camera(self, cam):
        self.cam.data.angle_y = math.radians(cam["fov"])
        self.cam.location = vec(cam["position"])
        self.cam.rotation_mode = "XYZ"
        self.cam.rotation_euler = rad(cam["rotation"])
        look = cam.get("lookAt")
        if look:
            bpy.context.view_layer.update()
            eye = self.cam.matrix_world.translation.copy()
            target = self.target_point(look)
            d = target - eye
            if d.length > 1e-6:
                q = d.to_track_quat("-Z", "Y")
                self.cam.matrix_world = Matrix.Translation(eye) @ q.to_matrix().to_4x4()

    # ---- measurement ---------------------------------------------------------------------------

    def world_points(self, inst, precise=True):
        deps = bpy.context.evaluated_depsgraph_get()
        pts = []
        for o in inst.meshes:
            if o.hide_render:
                continue
            ev = o.evaluated_get(deps)
            mw = ev.matrix_world
            if precise:
                me = ev.to_mesh()
                pts.extend(mw @ v.co for v in me.vertices)
                ev.to_mesh_clear()
            else:
                pts.extend(mw @ Vector(c) for c in ev.bound_box)
        return pts

    def world_bounds(self, inst, precise=True):
        pts = self.world_points(inst, precise)
        if not pts:
            return None
        lo = Vector((min(p[i] for p in pts) for i in range(3)))
        hi = Vector((max(p[i] for p in pts) for i in range(3)))
        return lo, hi

    def project(self, p):
        sc = self.sc
        v = world_to_camera_view(sc, self.cam, p)
        W, H = sc.render.resolution_x, sc.render.resolution_y
        return v.x * W, (1 - v.y) * H, v.z

    def measure(self, state, bones_req):
        W, H = self.sc.render.resolution_x, self.sc.render.resolution_y
        objs = {o["id"]: o for o in state["objects"]}
        out = []
        for i in self.order:
            inst = self.instances[i]
            st = objs[i]
            rec = {"id": i, "visible": st["visible"], "world": decompose_engine(inst.root.matrix_world), "clips": st["clips"]}
            pts = self.world_points(inst, precise=True)
            if pts:
                eng = [CI @ p for p in pts]
                lo = [min(p[k] for p in eng) for k in range(3)]
                hi = [max(p[k] for p in eng) for k in range(3)]
                rec["bounds"] = {"min": xyz(lo), "max": xyz(hi), "size": xyz([hi[k] - lo[k] for k in range(3)]), "center": xyz([(hi[k] + lo[k]) / 2 for k in range(3)])}
                proj = [self.project(p) for p in pts]
                front = [p for p in proj if p[2] > 0]
                rec["screen"] = self._screen(front, len(proj), W, H)
            else:
                rec["bounds"] = None
                rec["screen"] = None
            cam_local = self.cam.matrix_world.inverted() @ inst.root.matrix_world.translation
            rec["cameraSpace"] = {"x": round(cam_local.x, 4), "y": round(cam_local.y, 4), "depth": round(-cam_local.z, 4)}
            if inst.armature is not None:
                arm = inst.armature
                want = bones_req.get(i, {})
                bones = {}
                for label, bone in want.items():
                    pb = arm.pose.bones.get(bone)
                    if pb is None:
                        continue
                    w = arm.matrix_world @ pb.head
                    x, y, z = self.project(w)
                    tw = arm.matrix_world @ pb.tail
                    tx, ty, _ = self.project(tw)
                    bones[label] = {
                        "bone": bone,
                        "world": xyz(CI @ w),
                        "screen": {"x": round(x, 1), "y": round(y, 1), "onScreen": bool(z > 0 and 0 <= x <= W and 0 <= y <= H)},
                        "depth": round(z, 4),
                        "tail": {"world": xyz(CI @ tw), "screen": {"x": round(tx, 1), "y": round(ty, 1)}},
                    }
                rec["bones"] = bones
            out.append(rec)
        cm = decompose_engine(self.cam.matrix_world)
        fwd = CI.to_3x3() @ (self.cam.matrix_world.to_3x3() @ Vector((0, 0, -1)))
        camera = {"position": cm["position"], "rotation": cm["rotation"], "forward": xyz(fwd), "fov": round(math.degrees(self.cam.data.angle_y), 3)}
        lights = [{"id": k, **{kk: v for kk, v in decompose_engine(o.matrix_world).items() if kk != "scale"}} for k, o in self.lights.items()]
        return {"objects": out, "camera": camera, "lights": lights}

    @staticmethod
    def _screen(front, total, W, H):
        if not front:
            return {"onScreen": False, "behindCamera": True}
        xs = [p[0] for p in front]
        ys = [p[1] for p in front]
        x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
        cx0, cx1, cy0, cy1 = max(0, x0), min(W, x1), max(0, y0), min(H, y1)
        area = max(0.0, x1 - x0) * max(0.0, y1 - y0)
        vis = max(0.0, cx1 - cx0) * max(0.0, cy1 - cy0)
        inside = sum(1 for p in front if 0 <= p[0] <= W and 0 <= p[1] <= H)
        return {
            "x": round(x0, 1), "y": round(y0, 1), "width": round(x1 - x0, 1), "height": round(y1 - y0, 1),
            "center": {"x": round((x0 + x1) / 2, 1), "y": round((y0 + y1) / 2, 1)},
            "onScreen": vis > 0,
            "fullyOnScreen": len(front) == total and x0 >= 0 and y0 >= 0 and x1 <= W and y1 <= H,
            "visibleFraction": round(vis / area, 3) if area > 0 else (1.0 if inside else 0.0),
            "depthMin": round(min(p[2] for p in front), 4), "depthMax": round(max(p[2] for p in front), 4),
        }

    def render(self, out):
        self.sc.render.filepath = out
        bpy.ops.render.render(write_still=True)


# ---- modes ----------------------------------------------------------------------------------

def run_render(job):
    s = Scene3D(job)
    emit({"event": "ready", "device": s.device, "engine": s.sc.render.engine})
    for fr in job["frames"]:
        t = time.time()
        s.apply(fr["state"])
        s.render(fr["out"])
        emit({"event": "frame", "frame": fr["frame"], "file": fr["out"], "seconds": round(time.time() - t, 3)})
        if job.get("measure"):
            emit({"event": "measure", "frame": fr["frame"], **s.measure(fr["state"], job.get("bones", {}))})


def run_measure(job):
    s = Scene3D(job)
    s.apply(job["state"])
    emit({"event": "measure", "frame": job["frame"], **s.measure(job["state"], job.get("bones", {}))})


def run_thumbnail(job):
    """Imports one model at the origin, frames it and renders a small preview (asset inspection)."""
    spec = {"id": "model", "asset": job["asset"], "clipDurations": {}}
    job = {**job, "objects": [spec], "lights": [], "camera": {"near": 0.01, "far": 1000}}
    s = Scene3D(job)
    inst = s.instances["model"]
    ident = {"x": 0, "y": 0, "z": 0}
    state = {
        "objects": [{"id": "model", "position": ident, "rotation": ident, "scale": {"x": 1, "y": 1, "z": 1}, "visible": True, "clips": [], "morphs": {}}],
        "lights": [], "world": {"color": "#d0d4da", "strength": 1.0},
        "camera": {"position": {"x": 0, "y": 1, "z": 5}, "rotation": ident, "fov": 30, "lookAt": None},
    }
    s.apply(state)
    b = s.world_bounds(inst)
    info = {"blenderObjects": len(inst.objects), "clipsFound": sorted(inst.clip_actions.keys()),
            "bones": len(inst.armature.data.bones) if inst.armature else 0}
    if b:
        lo, hi = CI @ b[0], CI @ b[1]
        lo, hi = Vector([min(lo[i], hi[i]) for i in range(3)]), Vector([max(lo[i], hi[i]) for i in range(3)])
        center, size = (lo + hi) / 2, hi - lo
        radius = max(size.length / 2, 1e-3)
        dist = radius / math.sin(math.radians(15)) * 1.1
        d = Vector((0.6, 0.35, 1.0)).normalized()
        eye = center + d * dist
        state["camera"] = {"position": {"x": eye.x, "y": eye.y, "z": eye.z}, "rotation": ident, "fov": 30,
                           "lookAt": {"x": center.x, "y": center.y, "z": center.z}, "near": dist / 100, "far": dist * 10}
        s.cam.data.clip_start = dist / 100
        s.cam.data.clip_end = dist * 10
        s.apply(state)
        info["bounds"] = {"min": xyz(lo), "max": xyz(hi), "size": xyz(size)}
    s.render(job["out"])
    emit({"event": "thumbnail", "file": job["out"], **info})


def run_probe(job):
    """Checks that the requested engine can render headless here (EEVEE needs an EGL/OpenGL stack)."""
    job = {**job, "objects": [], "lights": [], "camera": {"near": 0.1, "far": 100}}
    s = Scene3D(job)
    s.render(job["out"])
    emit({"event": "probe", "engine": s.sc.render.engine, "device": s.device, "ok": os.path.exists(job["out"])})


def main():
    argv = sys.argv[sys.argv.index("--") + 1:]
    with open(argv[0]) as f:
        job = json.load(f)
    try:
        {"render": run_render, "measure": run_measure, "thumbnail": run_thumbnail, "probe": run_probe}[job["mode"]](job)
        emit({"event": "done"})
    except JobError as e:
        emit({"event": "error", "code": e.code, "message": str(e), "details": e.details})
        sys.stdout.flush()
        os._exit(2)
    except Exception as e:  # noqa: BLE001
        emit({"event": "error", "code": "RENDER_FAILED", "message": "%s: %s" % (type(e).__name__, e), "details": {"trace": traceback.format_exc()[-2000:]}})
        sys.stdout.flush()
        os._exit(3)


main()
