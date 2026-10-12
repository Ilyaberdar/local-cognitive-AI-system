"""Local Cognitive — 30-second identity film, built procedurally in Blender 5.2.

Run inside Blender (the MCP for Blender addon, or Blender's own text editor):

    import runpy; runpy.run_path("/…/marketing/blender/build_cinematic.py", run_name="__lc__")["build"]()

Everything lives in LC_* collections and LC_* data, so a rebuild replaces the film and touches
nothing else in the file. Random choices use fixed seeds: the same script makes the same film.
Story (30 fps, 900 frames):
  01 Awakening      1–180   particles in the dark converge into the computational core
  02 Local          181–360 the core opens into layers; light pulses run through; RUN AI LOCALLY
  03 Orchestration  361–570 through the core into a network of agents, tools and a GPU server
  04 Synthesis      571–750 candidates pass verification rings; failures break up; one is VERIFIED
  05 Brand          751–900 everything converges into the Local Cognitive logo and lockup
"""
import math
import random

import bmesh
import bpy
from mathutils import Euler, Matrix, Vector

FPS, FRAMES = 30, 900
SEQ = {"awake": (1, 180), "local": (181, 360), "orch": (361, 570), "synth": (571, 750), "brand": (751, 900)}
PAL = {
    "bg": (0.0025, 0.0035, 0.0065, 1),
    "cyan": (0.22, 0.78, 1.0, 1),
    "ice": (0.72, 0.9, 1.0, 1),
    "blue": (0.16, 0.38, 1.0, 1),
    "violet": (0.52, 0.38, 1.0, 1),
    "steel": (0.06, 0.07, 0.085, 1),
    "white": (1, 1, 1, 1),
}


# ---------------------------------------------------------------- helpers

ALIASES = {"Fac": "Factor"}  # socket names Blender 5 renamed

def collection(name, parent=None):
    """An LC collection, emptied, linked under the scene (or under `parent`)."""
    col = bpy.data.collections.get(name) or bpy.data.collections.new(name)
    for ob in list(col.objects):
        bpy.data.objects.remove(ob, do_unlink=True)
    host = parent or bpy.context.scene.collection
    if col.name not in host.children:
        host.children.link(col)
    return col


def link(col, ob):
    for c in list(ob.users_collection):
        c.objects.unlink(ob)
    col.objects.link(ob)
    return ob


def node(tree, kind, **props):
    n = tree.nodes.new(kind)
    for k, v in props.items():
        setattr(n, k, v)
    return n


def sock(n, name, out=False):
    """A socket by name; for nodes with same-named sockets of several types, the enabled one."""
    group = n.outputs if out else n.inputs
    found = [s for s in group if s.name in (name, ALIASES.get(name)) and getattr(s, "enabled", True)]
    if not found:
        raise KeyError(f"{n.bl_idname}: no {'output' if out else 'input'} {name!r} in {[s.name for s in group]}")
    return found[0]


def connect(tree, a, b):
    tree.links.new(a, b)


def keyframe(target, path, frame, value, index=-1, interpolation="BEZIER"):
    if index >= 0:
        getattr(target, path)[index] = value
    else:
        setattr(target, path, value)
    target.keyframe_insert(path, frame=frame, index=index)
    anim = getattr(target, "animation_data", None) or getattr(getattr(target, "id_data", None), "animation_data", None)
    if anim and anim.action:
        for fc in fcurves_of(anim.action):
            for kp in fc.keyframe_points:
                if abs(kp.co[0] - frame) < 0.01:
                    kp.interpolation = interpolation
                    kp.handle_left_type = kp.handle_right_type = "AUTO_CLAMPED"


def fcurves_of(action):
    """F-curves of an action (Blender 5 keeps them in layers / strips / channelbags)."""
    if hasattr(action, "fcurves") and action.fcurves is not None:
        try:
            return list(action.fcurves)
        except TypeError:
            pass
    curves = []
    for layer in getattr(action, "layers", []):
        for strip in layer.strips:
            for bag in getattr(strip, "channelbags", []):
                curves.extend(bag.fcurves)
    return curves


def driver(target, path, expression, index=-1):
    fc = target.driver_add(path, index) if index >= 0 else target.driver_add(path)
    fc.driver.type = "SCRIPTED"
    fc.driver.expression = expression
    return fc


# ---------------------------------------------------------------- materials

def material(name):
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    mat.use_nodes = True
    mat.node_tree.nodes.clear()
    return mat


def mat_emission(name, color, strength):
    mat = material(name)
    t = mat.node_tree
    em = node(t, "ShaderNodeEmission")
    sock(em, "Color").default_value = color
    sock(em, "Strength").default_value = strength
    out = node(t, "ShaderNodeOutputMaterial")
    connect(t, sock(em, "Emission", True), sock(out, "Surface"))
    return mat


def mat_metal(name, base=PAL["steel"], roughness=0.28, rim=None, rim_strength=0.0):
    """Dark brushed metal with an optional emissive fresnel rim (the light catching its edges)."""
    mat = material(name)
    t = mat.node_tree
    bsdf = node(t, "ShaderNodeBsdfPrincipled")
    sock(bsdf, "Base Color").default_value = base
    sock(bsdf, "Metallic").default_value = 1.0
    sock(bsdf, "Roughness").default_value = roughness
    out = node(t, "ShaderNodeOutputMaterial")
    if rim:
        fres = node(t, "ShaderNodeLayerWeight")
        sock(fres, "Blend").default_value = 0.18
        ramp = node(t, "ShaderNodeMath", operation="POWER")
        connect(t, sock(fres, "Facing", True), ramp.inputs[0])
        ramp.inputs[1].default_value = 3.0
        mult = node(t, "ShaderNodeMath", operation="MULTIPLY")
        connect(t, sock(ramp, "Value", True), mult.inputs[0])
        mult.inputs[1].default_value = rim_strength
        sock(bsdf, "Emission Color").default_value = rim
        connect(t, sock(mult, "Value", True), sock(bsdf, "Emission Strength"))
    connect(t, sock(bsdf, "BSDF", True), sock(out, "Surface"))
    return mat


def mat_pane(name, grid=2.5, grid_strength=0.15, rim=PAL["cyan"], rim_strength=0.0):
    """Thin glass: see-through, a clear reflection at grazing angles, a faint etched grid that catches
    the light, and a cold rim. No refraction, so what is inside stays sharp."""
    mat = material(name)
    t = mat.node_tree
    clear = node(t, "ShaderNodeBsdfTransparent")
    gloss = node(t, "ShaderNodeBsdfGlossy")
    sock(gloss, "Roughness").default_value = 0.04
    sock(gloss, "Color").default_value = (0.8, 0.9, 1.0, 1)
    fres = node(t, "ShaderNodeLayerWeight")
    sock(fres, "Blend").default_value = 0.35
    shine = node(t, "ShaderNodeMath", operation="MULTIPLY_ADD")
    connect(t, sock(fres, "Fresnel", True), shine.inputs[0])
    shine.inputs[1].default_value = 0.1
    shine.inputs[2].default_value = 0.005
    glass = node(t, "ShaderNodeMixShader")
    connect(t, sock(shine, "Value", True), glass.inputs[0])
    connect(t, sock(clear, "BSDF", True), glass.inputs[1])
    connect(t, sock(gloss, "BSDF", True), glass.inputs[2])
    # Etched grid: thin lines where the object coordinate crosses a multiple of 1/grid.
    coord = node(t, "ShaderNodeTexCoord")
    lines = node(t, "ShaderNodeVectorMath", operation="FRACTION")
    scaled = node(t, "ShaderNodeVectorMath", operation="SCALE")
    connect(t, sock(coord, "Object", True), scaled.inputs[0])
    sock(scaled, "Scale").default_value = grid
    connect(t, sock(scaled, "Vector", True), lines.inputs[0])
    sep = node(t, "ShaderNodeSeparateXYZ")
    connect(t, sock(lines, "Vector", True), sep.inputs[0])
    near = None
    for axis in ("X", "Y", "Z"):
        edge = node(t, "ShaderNodeMath", operation="PINGPONG")
        connect(t, sock(sep, axis, True), edge.inputs[0])
        edge.inputs[1].default_value = 0.5
        thin = node(t, "ShaderNodeMath", operation="LESS_THAN")
        connect(t, sock(edge, "Value", True), thin.inputs[0])
        thin.inputs[1].default_value = 0.006
        if near is None:
            near = sock(thin, "Value", True)
        else:
            both = node(t, "ShaderNodeMath", operation="MAXIMUM")
            connect(t, near, both.inputs[0])
            connect(t, sock(thin, "Value", True), both.inputs[1])
            near = sock(both, "Value", True)
    glow = node(t, "ShaderNodeMath", operation="MULTIPLY_ADD")
    connect(t, near, glow.inputs[0])
    glow.inputs[1].default_value = grid_strength
    rimw = node(t, "ShaderNodeMath", operation="MULTIPLY")
    connect(t, sock(fres, "Facing", True), rimw.inputs[0])
    rimw.inputs[1].default_value = rim_strength
    connect(t, sock(rimw, "Value", True), glow.inputs[2])
    em = node(t, "ShaderNodeEmission")
    sock(em, "Color").default_value = rim
    connect(t, sock(glow, "Value", True), sock(em, "Strength"))
    add = node(t, "ShaderNodeAddShader")
    connect(t, glass.outputs[0], add.inputs[0])
    connect(t, sock(em, "Emission", True), add.inputs[1])
    out = node(t, "ShaderNodeOutputMaterial")
    connect(t, add.outputs[0], sock(out, "Surface"))
    mat.use_backface_culling = False
    mat.surface_render_method = "BLENDED"  # smooth see-through glass; dithering leaves speckle at low samples
    return mat


def mat_circuit(name, color=PAL["cyan"], strength=6.0, bands=18.0, speed=0.35):
    """Thin emissive lines with light pulses running along them (a wave texture on object space,
    its phase driven by the frame)."""
    mat = material(name)
    t = mat.node_tree
    coord = node(t, "ShaderNodeTexCoord")
    wave = node(t, "ShaderNodeTexWave", wave_type="RINGS")
    sock(wave, "Scale").default_value = bands
    sock(wave, "Distortion").default_value = 2.0
    sock(wave, "Detail").default_value = 2.0
    connect(t, sock(coord, "Object", True), sock(wave, "Vector"))
    phase = sock(wave, "Phase Offset")
    d = phase.driver_add("default_value")
    d.driver.expression = f"frame*{speed}"
    ramp = node(t, "ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].position = 0.72
    ramp.color_ramp.elements[0].color = (0.04, 0.04, 0.04, 1)
    ramp.color_ramp.elements[1].position = 0.95
    ramp.color_ramp.elements[1].color = (1, 1, 1, 1)
    connect(t, sock(wave, "Fac", True), sock(ramp, "Fac"))
    mult = node(t, "ShaderNodeMath", operation="MULTIPLY")
    connect(t, sock(ramp, "Color", True), mult.inputs[0])
    mult.inputs[1].default_value = strength
    em = node(t, "ShaderNodeEmission")
    sock(em, "Color").default_value = color
    connect(t, sock(mult, "Value", True), sock(em, "Strength"))
    out = node(t, "ShaderNodeOutputMaterial")
    connect(t, sock(em, "Emission", True), sock(out, "Surface"))
    return mat


def mat_particle(name, strength=5.0, a=(0.12, 0.62, 1.0, 1), b=(0.5, 0.3, 1.0, 1)):
    """Particles tinted between cyan and violet by their own random `lc_tint`, bright enough to bloom
    but not so bright that the view transform bleaches them white."""
    mat = material(name)
    t = mat.node_tree
    attr = node(t, "ShaderNodeAttribute", attribute_type="INSTANCER", attribute_name="lc_tint")
    mix = node(t, "ShaderNodeMix", data_type="RGBA")
    sock(mix, "A").default_value = a
    sock(mix, "B").default_value = b
    connect(t, sock(attr, "Fac", True), sock(mix, "Factor"))
    em = node(t, "ShaderNodeEmission")
    sock(em, "Strength").default_value = strength
    connect(t, sock(mix, "Result", True), sock(em, "Color"))
    out = node(t, "ShaderNodeOutputMaterial")
    connect(t, sock(em, "Emission", True), sock(out, "Surface"))
    return mat


def reveal(mat, f0, f1, edge=PAL["cyan"], scale=2.2, per_object=False, sweep=0.0, front_glow=24.0, band=0.03):
    """Materialise a surface between frames f0 and f1: it appears patch by patch out of nothing,
    with a thin glowing front where it is being formed (the particles' light settling into it)."""
    t = mat.node_tree
    out = next(n for n in t.nodes if n.type == "OUTPUT_MATERIAL")
    shader = out.inputs["Surface"].links[0].from_socket
    if per_object:
        info = node(t, "ShaderNodeObjectInfo")
        pattern = sock(info, "Random", True)
    elif sweep:
        # A level front rising from the bottom (object z from -sweep to +sweep), slightly uneven.
        coord = node(t, "ShaderNodeTexCoord")
        sep = node(t, "ShaderNodeSeparateXYZ")
        connect(t, sock(coord, "Object", True), sep.inputs[0])
        noise = node(t, "ShaderNodeTexNoise")
        sock(noise, "Scale").default_value = scale
        connect(t, sock(coord, "Object", True), sock(noise, "Vector"))
        wobble = node(t, "ShaderNodeMath", operation="MULTIPLY_ADD")
        connect(t, sock(noise, "Fac", True), wobble.inputs[0])
        wobble.inputs[1].default_value = 0.08 * sweep
        connect(t, sock(sep, "Z", True), wobble.inputs[2])
        level = node(t, "ShaderNodeMapRange")
        connect(t, sock(wobble, "Value", True), sock(level, "Value"))
        sock(level, "From Min").default_value = -sweep
        sock(level, "From Max").default_value = 1.25 * sweep
        pattern = sock(level, "Result", True)
    else:
        coord = node(t, "ShaderNodeTexCoord")
        noise = node(t, "ShaderNodeTexNoise")
        sock(noise, "Scale").default_value = scale
        sock(noise, "Detail").default_value = 3.0
        connect(t, sock(coord, "Object", True), sock(noise, "Vector"))
        pattern = sock(noise, "Fac", True)
    progress = node(t, "ShaderNodeValue")
    keyframe(progress.outputs[0], "default_value", f0, 0.0, interpolation="LINEAR")
    keyframe(progress.outputs[0], "default_value", f1, 1.0, interpolation="LINEAR")
    lo, hi = (0.0, 1.0) if per_object or sweep else (0.25, 0.75)  # the noise rarely leaves 0.25–0.75
    front = node(t, "ShaderNodeMapRange")
    connect(t, progress.outputs[0], sock(front, "Value"))
    sock(front, "To Min").default_value = lo - 0.05
    sock(front, "To Max").default_value = hi + 0.05
    solid = node(t, "ShaderNodeMath", operation="LESS_THAN")
    connect(t, pattern, solid.inputs[0])
    connect(t, sock(front, "Result", True), solid.inputs[1])
    ahead = node(t, "ShaderNodeMath", operation="ADD")
    connect(t, sock(front, "Result", True), ahead.inputs[0])
    ahead.inputs[1].default_value = band
    glow = node(t, "ShaderNodeMath", operation="LESS_THAN")
    connect(t, pattern, glow.inputs[0])
    connect(t, sock(ahead, "Value", True), glow.inputs[1])
    band = node(t, "ShaderNodeMath", operation="SUBTRACT")
    connect(t, sock(glow, "Value", True), band.inputs[0])
    connect(t, sock(solid, "Value", True), band.inputs[1])
    clear = node(t, "ShaderNodeBsdfTransparent")
    mix = node(t, "ShaderNodeMixShader")
    connect(t, sock(solid, "Value", True), mix.inputs[0])
    connect(t, sock(clear, "BSDF", True), mix.inputs[1])
    connect(t, shader, mix.inputs[2])
    em = node(t, "ShaderNodeEmission")
    sock(em, "Color").default_value = edge
    strength = node(t, "ShaderNodeMath", operation="MULTIPLY")
    connect(t, sock(band, "Value", True), strength.inputs[0])
    strength.inputs[1].default_value = front_glow
    connect(t, sock(strength, "Value", True), sock(em, "Strength"))
    add = node(t, "ShaderNodeAddShader")
    connect(t, mix.outputs[0], add.inputs[0])
    connect(t, sock(em, "Emission", True), add.inputs[1])
    connect(t, add.outputs[0], out.inputs["Surface"])
    return mat


# ---------------------------------------------------------------- scene setup

def setup_render(preview=True):
    s = bpy.context.scene
    s.render.fps, s.frame_start, s.frame_end = FPS, 1, FRAMES
    s.render.resolution_x, s.render.resolution_y = 1920, 1080
    s.render.engine = "BLENDER_EEVEE"
    s.view_settings.view_transform = "AgX"
    s.view_settings.look = "AgX - Medium High Contrast"
    s.view_settings.exposure = 0.0
    e = s.eevee
    e.taa_render_samples = 24 if preview else 96
    e.use_raytracing = True
    e.use_shadows = True
    e.volumetric_samples = 48 if preview else 96
    e.volumetric_start, e.volumetric_end = 0.5, 60.0
    e.volumetric_tile_size = "4" if preview else "2"  # coarser tiles show as a grid in the haze
    e.use_volumetric_shadows = True
    s.render.use_motion_blur = True
    s.render.motion_blur_shutter = 0.45


def setup_world():
    s = bpy.context.scene
    world = bpy.data.worlds.get("LC_World") or bpy.data.worlds.new("LC_World")
    s.world = world
    world.use_nodes = True
    t = world.node_tree
    t.nodes.clear()
    bg = node(t, "ShaderNodeBackground")
    sock(bg, "Color").default_value = PAL["bg"]
    sock(bg, "Strength").default_value = 1.0
    vol = node(t, "ShaderNodeVolumePrincipled")
    sock(vol, "Color").default_value = (0.55, 0.7, 1.0, 1)
    sock(vol, "Density").default_value = 0.012
    sock(vol, "Anisotropy").default_value = 0.35
    out = node(t, "ShaderNodeOutputWorld")
    connect(t, sock(bg, "Background", True), sock(out, "Surface"))
    connect(t, sock(vol, "Volume", True), sock(out, "Volume"))


def setup_compositor():
    s = bpy.context.scene
    g = bpy.data.node_groups.get("LC_Compositor")
    if g:
        bpy.data.node_groups.remove(g)
    g = bpy.data.node_groups.new("LC_Compositor", "CompositorNodeTree")
    g.interface.new_socket("Image", in_out="OUTPUT", socket_type="NodeSocketColor")
    rl = node(g, "CompositorNodeRLayers")
    bloom = node(g, "CompositorNodeGlare")
    sock(bloom, "Type").default_value = "Bloom"
    sock(bloom, "Quality").default_value = "High"
    sock(bloom, "Threshold").default_value = 1.2
    sock(bloom, "Strength").default_value = 0.55
    sock(bloom, "Size").default_value = 0.85
    # A faint horizontal flare on the brightest points only (the spark, the heart, the glints).
    flare = node(g, "CompositorNodeGlare")
    sock(flare, "Type").default_value = "Streaks"
    sock(flare, "Quality").default_value = "High"
    sock(flare, "Threshold").default_value = 6.0
    sock(flare, "Strength").default_value = 0.35
    sock(flare, "Streaks").default_value = 2
    sock(flare, "Streaks Angle").default_value = 0.0
    sock(flare, "Fade").default_value = 0.88
    lens = node(g, "CompositorNodeLensdist")
    for name, value in (("Dispersion", 0.012), ("Distortion", -0.012)):
        try:
            sock(lens, name).default_value = value
        except KeyError:
            pass
    out = node(g, "NodeGroupOutput")
    connect(g, sock(rl, "Image", True), sock(bloom, "Image"))
    connect(g, sock(bloom, "Image", True), sock(flare, "Image"))
    connect(g, sock(flare, "Image", True), sock(lens, "Image"))
    connect(g, sock(lens, "Image", True), out.inputs[0])
    s.compositing_node_group = g
    s.render.use_compositing = True


def setup_camera(col):
    cam_data = bpy.data.cameras.get("LC_Camera") or bpy.data.cameras.new("LC_Camera")
    cam = bpy.data.objects.new("LC_Camera", cam_data)
    link(col, cam)
    target = bpy.data.objects.new("LC_CameraTarget", None)
    link(col, target)
    cam_data.lens = 50
    cam_data.clip_start, cam_data.clip_end = 0.05, 400
    cam_data.dof.use_dof = True
    cam_data.dof.focus_object = target
    cam_data.dof.aperture_fstop = 2.2
    track = cam.constraints.new("TRACK_TO")
    track.target = target
    track.track_axis, track.up_axis = "TRACK_NEGATIVE_Z", "UP_Y"
    bpy.context.scene.camera = cam
    return cam, target


# ---------------------------------------------------------------- 01 the computational core

def build_core(col):
    rng = random.Random(7)
    root = bpy.data.objects.new("LC_Core", None)
    link(col, root)

    # The heart: a small, very bright source the whole film keeps returning to.
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.17, segments=48, ring_count=24)
    heart = link(col, bpy.context.active_object)
    heart.name = "LC_Core_Heart"
    bpy.ops.object.shade_smooth()
    heart.data.materials.append(mat_emission("LC_M_Heart", (0.45, 0.8, 1.0, 1), 0.0))
    heart.parent = root

    # Lattice: a geodesic frame of thin struts with glowing joints.
    bpy.ops.mesh.primitive_ico_sphere_add(radius=0.78, subdivisions=2)
    lattice = link(col, bpy.context.active_object)
    lattice.name = "LC_Core_Lattice"
    wire = lattice.modifiers.new("Struts", "WIREFRAME")
    wire.thickness = 0.012
    wire.use_replace = True
    lattice.data.materials.append(mat_metal("LC_M_Strut", rim=PAL["cyan"], rim_strength=4.0))
    lattice.parent = root
    # Joints sit on the vertices of an unmodified copy (the struts' own vertices are the wireframe's).
    joints = bpy.data.objects.new("LC_Core_Joints", lattice.data.copy())
    link(col, joints)
    joints.parent = lattice
    joints.instance_type = "VERTS"
    joints.show_instancer_for_render = False
    joints.show_instancer_for_viewport = False
    bpy.ops.mesh.primitive_ico_sphere_add(radius=0.022, subdivisions=1)
    joint = link(col, bpy.context.active_object)
    joint.name = "LC_Core_Joint"
    joint.data.materials.append(mat_emission("LC_M_Joint", PAL["ice"], 9.0))
    joint.parent = joints

    # Gimbal rings with circuits running round them.
    rings = []
    for i, (radius, minor, tilt) in enumerate(((1.18, 0.012, (70, 0, 0)), (1.36, 0.009, (20, 60, 0)), (1.55, 0.007, (110, 25, 40)))):
        bpy.ops.mesh.primitive_torus_add(major_radius=radius, minor_radius=minor, major_segments=192, minor_segments=10)
        ring = link(col, bpy.context.active_object)
        ring.name = f"LC_Core_Ring{i + 1}"
        ring.rotation_euler = Euler([math.radians(a) for a in tilt])
        ring.data.materials.append(mat_circuit(f"LC_M_Ring{i + 1}", PAL["cyan"] if i != 1 else PAL["violet"], 7.0, 14 + 6 * i, 0.25 + 0.1 * i))
        ring.parent = root
        driver(ring, "rotation_euler", f"{math.radians(tilt[2])}+frame*{0.012 * (1 if i % 2 == 0 else -1) * (1 + i * 0.4):.4f}", 2)
        rings.append(ring)

    # Shell: a broken geodesic of separate panels, some missing, so the light inside shows through.
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=3, radius=1.95)
    faces = list(bm.faces)
    keep = [f for f in faces if rng.random() > 0.7]
    bmesh.ops.delete(bm, geom=[f for f in faces if f not in keep], context="FACES")
    bmesh.ops.split_edges(bm, edges=list(bm.edges))
    for f in bm.faces:
        c = f.calc_center_median()
        for v in f.verts:
            v.co = c + (v.co - c) * 0.8
    mesh = bpy.data.meshes.new("LC_Core_Shell")
    bm.to_mesh(mesh)
    bm.free()
    shell = bpy.data.objects.new("LC_Core_Shell", mesh)
    link(col, shell)
    solid = shell.modifiers.new("Thickness", "SOLIDIFY")
    solid.thickness = 0.03
    bev = shell.modifiers.new("Edge", "BEVEL")
    bev.width, bev.segments = 0.006, 2
    shell.data.materials.append(mat_metal("LC_M_Panel", base=(0.035, 0.04, 0.05, 1), roughness=0.22, rim=PAL["blue"], rim_strength=2.5))
    shell.parent = root
    driver(shell, "rotation_euler", "frame*-0.004", 2)
    driver(lattice, "rotation_euler", "frame*0.006", 2)
    driver(lattice, "rotation_euler", "frame*0.003", 0)

    # Circuits: arcs traced over a sphere between the lattice and the rings.
    curve = bpy.data.curves.new("LC_Core_Circuits", "CURVE")
    curve.dimensions = "3D"
    curve.bevel_depth = 0.0035
    curve.bevel_resolution = 2
    for _ in range(26):
        axis = Vector((rng.uniform(-1, 1), rng.uniform(-1, 1), rng.uniform(-1, 1))).normalized()
        start = axis.orthogonal().normalized()
        arc = math.radians(rng.uniform(35, 140))
        radius = rng.uniform(0.95, 1.08)
        spline = curve.splines.new("POLY")
        steps = 40
        spline.points.add(steps - 1)
        for k in range(steps):
            rot = Matrix.Rotation(arc * k / (steps - 1), 4, axis)
            p = (rot @ start) * radius
            spline.points[k].co = (p.x, p.y, p.z, 1)
    circuits = bpy.data.objects.new("LC_Core_Circuits", curve)
    link(col, circuits)
    circuits.data.materials.append(mat_circuit("LC_M_Circuit", PAL["ice"], 9.0, 26, 0.6))
    circuits.parent = root
    driver(circuits, "rotation_euler", "frame*0.009", 2)

    # Light from inside: the core lights its own structure and the air around it.
    light = bpy.data.lights.get("LC_CoreLight") or bpy.data.lights.new("LC_CoreLight", "POINT")
    light.color = PAL["cyan"][:3]
    light.shadow_soft_size = 0.2
    lob = bpy.data.objects.new("LC_CoreLight", light)
    link(col, lob)
    lob.parent = root

    # Nothing exists yet: each layer materialises as the particles reach it, inside out.
    reveal(heart.active_material, 95, 150, PAL["ice"], 7.0)
    reveal(lattice.active_material, 100, 150, PAL["cyan"], 3.0)
    reveal(joint.active_material, 110, 160, PAL["ice"], per_object=True)
    for i, ring in enumerate(rings):
        reveal(ring.active_material, 115 + 10 * i, 160 + 5 * i, PAL["cyan"], 4.0)
    reveal(shell.active_material, 125, 178, PAL["cyan"], 1.6)
    reveal(circuits.active_material, 135, 178, PAL["ice"], 3.0)
    return root, heart, light


def animate_awakening(heart, core_light, root):
    a0, a1 = SEQ["awake"]
    em = next(n for n in heart.active_material.node_tree.nodes if n.type == "EMISSION")
    strength = sock(em, "Strength")
    keyframe(strength, "default_value", a0, 0.0)
    keyframe(strength, "default_value", 95, 1.0)
    keyframe(strength, "default_value", 150, 5.0)
    keyframe(strength, "default_value", 172, 14.0)
    keyframe(core_light, "energy", a0, 0.0)
    keyframe(core_light, "energy", 100, 40.0)
    keyframe(core_light, "energy", 175, 900.0)


def build_spark(col):
    """The first thing in the film: one point of light in the dark, which the particles answer."""
    bpy.ops.mesh.primitive_ico_sphere_add(radius=0.045, subdivisions=2)
    spark = link(col, bpy.context.active_object)
    spark.name = "LC_Spark"
    mat = mat_emission("LC_M_Spark", (0.5, 0.85, 1.0, 1), 0.0)
    spark.data.materials.append(mat)
    strength = sock(next(n for n in mat.node_tree.nodes if n.type == "EMISSION"), "Strength")
    for frame, value in ((1, 0.0), (6, 0.0), (10, 160.0), (26, 30.0), (70, 8.0), (100, 0.0)):
        keyframe(strength, "default_value", frame, value)


# ---------------------------------------------------------------- 01 the machine (a glass cube)

MACHINE = 2.7  # half the cube's edge: the core (radius 1.95) sits well inside it


def build_machine(col, name="LC_Machine", half=MACHINE, location=(0, 0, 0), draw=(40, 112), glass=(115, 170), seed=3):
    """Your machine: a glass cube whose edges are drawn in light, then its panes form. Everything the
    film says about privacy happens against these walls."""
    rng = random.Random(seed)
    root = bpy.data.objects.new(name, None)
    root.location = location
    link(col, root)
    bpy.ops.mesh.primitive_cube_add(size=2 * half)
    pane = link(col, bpy.context.active_object)
    pane.name = f"{name}_Glass"
    pane.data.materials.append(mat_pane(f"LC_M_{name}_Glass"))
    pane.parent = root
    pane.location = (0, 0, 0)
    reveal(pane.active_material, glass[0], glass[1], PAL["cyan"], 1.2, sweep=half, front_glow=6.0, band=0.012)
    edge_mat = mat_emission(f"LC_M_{name}_Edge", (0.3, 0.75, 1.0, 1), 4.0)
    corners = [Vector((x, y, z)) * half for x in (-1, 1) for y in (-1, 1) for z in (-1, 1)]
    edges = [(a, b) for i, a in enumerate(corners) for b in corners[i + 1:] if abs((a - b).length - 2 * half) < 1e-6]
    near = min(corners, key=lambda c: (c - Vector((half, -3 * half, half))).length)
    # Edges grow outward from the corner nearest the camera, each from its end nearer that corner.
    edges.sort(key=lambda e: min((e[0] - near).length, (e[1] - near).length))
    span = draw[1] - draw[0] - 22
    for i, (a, b) in enumerate(edges):
        if (b - near).length < (a - near).length:
            a, b = b, a
        curve = bpy.data.curves.new(f"{name}_Edge{i}", "CURVE")
        curve.dimensions = "3D"
        curve.bevel_depth = 0.009
        curve.bevel_resolution = 2
        curve.use_fill_caps = True
        sp = curve.splines.new("POLY")
        sp.points.add(1)
        sp.points[0].co = (*a, 1)
        sp.points[1].co = (*b, 1)
        ob = bpy.data.objects.new(f"{name}_Edge{i}", curve)
        link(col, ob)
        ob.parent = root
        ob.data.materials.append(edge_mat)
        start = draw[0] + round(span * i / (len(edges) - 1)) + rng.randint(-3, 3)
        keyframe(curve, "bevel_factor_end", draw[0] - 1, 0.0)
        keyframe(curve, "bevel_factor_end", start, 0.0)
        keyframe(curve, "bevel_factor_end", start + 22, 1.0)
    # Corner nodes light up as their edges arrive.
    node_mat = mat_emission(f"LC_M_{name}_Node", PAL["ice"], 0.0)
    for c in corners:
        bpy.ops.mesh.primitive_ico_sphere_add(radius=0.05, subdivisions=2, location=c)
        dot = link(col, bpy.context.active_object)
        dot.name = f"{name}_Node"
        dot.data.materials.append(node_mat)
        dot.parent = root
    glow = sock(next(n for n in node_mat.node_tree.nodes if n.type == "EMISSION"), "Strength")
    keyframe(glow, "default_value", draw[0], 0.0)
    keyframe(glow, "default_value", draw[0] + 12, 30.0)
    keyframe(glow, "default_value", draw[1], 12.0)
    return root


# ---------------------------------------------------------------- 01 particles converging

def gn_group(name):
    old = bpy.data.node_groups.get(name)
    if old:
        bpy.data.node_groups.remove(old)
    g = bpy.data.node_groups.new(name, "GeometryNodeTree")
    g.interface.new_socket("Geometry", in_out="INPUT", socket_type="NodeSocketGeometry")
    g.interface.new_socket("Geometry", in_out="OUTPUT", socket_type="NodeSocketGeometry")
    return g


class Fields:
    """Small builders for geometry-node math, so a field reads close to its formula."""

    def __init__(self, g):
        self.g = g

    def rand_vec(self, seed, lo=-1.0, hi=1.0):
        r = node(self.g, "FunctionNodeRandomValue", data_type="FLOAT_VECTOR")
        sock(r, "Min").default_value = (lo, lo, lo)
        sock(r, "Max").default_value = (hi, hi, hi)
        sock(r, "Seed").default_value = seed
        return sock(r, "Value", True)

    def rand(self, seed, lo, hi):
        r = node(self.g, "FunctionNodeRandomValue", data_type="FLOAT")
        sock(r, "Min").default_value = lo
        sock(r, "Max").default_value = hi
        sock(r, "Seed").default_value = seed
        return sock(r, "Value", True)

    def f(self, op, a, b=None, c=None):
        n = node(self.g, "ShaderNodeMath", operation=op)
        for i, v in enumerate((a, b, c)):
            if v is None:
                continue
            if isinstance(v, (int, float)):
                n.inputs[i].default_value = v
            else:
                connect(self.g, v, n.inputs[i])
        return n.outputs[0]

    def clamp01(self, v):
        return self.f("MINIMUM", self.f("MAXIMUM", v, 0.0), 1.0)

    def smooth(self, t):
        return self.f("MULTIPLY", self.f("MULTIPLY", t, t), self.f("SUBTRACT", 3.0, self.f("MULTIPLY", t, 2.0)))

    def v(self, op, a, b=None, scale=None):
        n = node(self.g, "ShaderNodeVectorMath", operation=op)
        for i, x in enumerate((a, b)):
            if x is None:
                continue
            if isinstance(x, tuple):
                n.inputs[i].default_value = x
            else:
                connect(self.g, x, n.inputs[i])
        if scale is not None:
            if isinstance(scale, (int, float)):
                sock(n, "Scale").default_value = scale
            else:
                connect(self.g, scale, sock(n, "Scale"))
        return sock(n, "Value" if op in ("DOT_PRODUCT", "LENGTH", "DISTANCE") else "Vector", True)

    def instance(self, points, radius, mat, scale):
        ico = node(self.g, "GeometryNodeMeshIcoSphere")
        sock(ico, "Radius").default_value = radius
        sock(ico, "Subdivisions").default_value = 1
        setmat = node(self.g, "GeometryNodeSetMaterial")
        sock(setmat, "Material").default_value = mat
        connect(self.g, sock(ico, "Mesh", True), sock(setmat, "Geometry"))
        inst = node(self.g, "GeometryNodeInstanceOnPoints")
        connect(self.g, points, sock(inst, "Points"))
        connect(self.g, sock(setmat, "Geometry", True), sock(inst, "Instance"))
        connect(self.g, scale, sock(inst, "Scale"))
        return sock(inst, "Instances", True)

    def tint(self, geometry, seed, skew):
        store = node(self.g, "GeometryNodeStoreNamedAttribute", data_type="FLOAT", domain="POINT")
        sock(store, "Name").default_value = "lc_tint"
        connect(self.g, geometry, sock(store, "Geometry"))
        connect(self.g, self.f("POWER", self.rand(seed, 0.0, 1.0), skew), sock(store, "Value"))
        return sock(store, "Geometry", True)


def gn_converge(targets, density=220.0, t0=0.6, t1=5.6):
    """Points that appear in the dark, swirl in, and settle on the surfaces of the core: each lands
    on its own spot of a panel, strut or ring (and moves with it), then is absorbed into it as the
    surface materialises. Everything is a field of the point and the scene time."""
    g = gn_group("LC_GN_Converge")
    F = Fields(g)
    sec = sock(node(g, "GeometryNodeInputSceneTime"), "Seconds", True)
    info = node(g, "GeometryNodeCollectionInfo", transform_space="RELATIVE")
    sock(info, "Collection").default_value = targets
    real = node(g, "GeometryNodeRealizeInstances")
    connect(g, sock(info, "Instances", True), sock(real, "Geometry"))
    dist = node(g, "GeometryNodeDistributePointsOnFaces", distribute_method="RANDOM")
    sock(dist, "Density").default_value = density
    sock(dist, "Seed").default_value = 11
    connect(g, sock(real, "Geometry", True), sock(dist, "Mesh"))
    target = sock(node(g, "GeometryNodeInputPosition"), "Position", True)
    # Start: a wide, flattened cloud far around the core.
    start = F.v("SCALE", F.v("NORMALIZE", F.rand_vec(1)), scale=F.rand(2, 6.0, 22.0))
    start = F.v("MULTIPLY", start, (1.0, 1.0, 0.55))
    # Progress: staggered by a per-point delay, eased; the cloud turns as it falls in.
    delay = F.rand(5, 0.0, 0.45)
    speed = 1.7
    t = F.clamp01(F.f("MULTIPLY", F.f("SUBTRACT", F.f("DIVIDE", F.f("SUBTRACT", sec, t0), t1 - t0), delay), speed))
    ease = F.smooth(t)
    rot = node(g, "ShaderNodeVectorRotate", rotation_type="Z_AXIS")
    connect(g, start, sock(rot, "Vector"))
    connect(g, F.f("MULTIPLY", F.f("SUBTRACT", 1.0, ease), F.rand(6, 2.2, 4.4)), sock(rot, "Angle"))
    mix = node(g, "ShaderNodeMix", data_type="VECTOR")
    connect(g, ease, sock(mix, "Factor"))
    connect(g, sock(rot, "Vector", True), sock(mix, "A"))
    connect(g, target, sock(mix, "B"))
    setpos = node(g, "GeometryNodeSetPosition")
    connect(g, sock(dist, "Points", True), sock(setpos, "Geometry"))
    connect(g, sock(mix, "Result", True), sock(setpos, "Position"))
    # Size: each point lights up at its own moment, and is absorbed soon after it lands.
    arrive = F.f("MULTIPLY_ADD", delay, t1 - t0, t0 + (t1 - t0) / speed)
    wave = F.f("MULTIPLY_ADD", F.v("LENGTH", start), 2.4 / 22.0, F.rand(7, 0.35, 0.65))
    appear = F.clamp01(F.f("MULTIPLY", F.f("SUBTRACT", sec, wave), 2.5))
    absorbed = F.clamp01(F.f("DIVIDE", F.f("SUBTRACT", sec, F.f("ADD", arrive, 0.15)), 0.5))
    size = F.f("MULTIPLY", F.f("MULTIPLY", appear, F.f("SUBTRACT", 1.0, absorbed)), F.rand(8, 0.35, 1.3))
    pts = F.tint(sock(setpos, "Geometry", True), 9, 2.4)
    connect(g, F.instance(pts, 0.011, mat_particle("LC_M_Particle"), size), node(g, "NodeGroupOutput").inputs[0])
    return g


def gn_dust(count=2200):
    """Faint motes that drift through the whole film, mostly out of focus: depth, not information."""
    g = gn_group("LC_GN_Dust")
    F = Fields(g)
    sec = sock(node(g, "GeometryNodeInputSceneTime"), "Seconds", True)
    pts = node(g, "GeometryNodePoints")
    sock(pts, "Count").default_value = count
    base = F.v("MULTIPLY", F.rand_vec(21), (18.0, 18.0, 8.0))
    drift = F.v("SCALE", F.rand_vec(22, -0.06, 0.06), scale=sec)
    connect(g, F.v("ADD", base, drift), sock(pts, "Position"))
    flicker = F.f("ADD", 0.75, F.f("MULTIPLY", 0.25, F.f("SINE", F.f("MULTIPLY_ADD", sec, F.rand(23, 0.6, 2.0), F.rand(24, 0.0, 6.3)))))
    size = F.f("MULTIPLY", flicker, F.rand(25, 0.3, 1.2))
    geo = F.tint(sock(pts, "Points", True), 26, 1.6)
    connect(g, F.instance(geo, 0.012, mat_particle("LC_M_Dust", 1.6), size), node(g, "NodeGroupOutput").inputs[0])
    return g


def build_particles(col, targets):
    def host(name, group):
        ob = bpy.data.objects.new(name, bpy.data.meshes.new(name + "_Host"))
        link(col, ob)
        ob.modifiers.new(group.name, "NODES").node_group = group
        return ob
    host("LC_Particles", gn_converge(targets))
    dust = host("LC_Dust", gn_dust())
    driver(dust, "rotation_euler", "frame*0.0009", 2)
    # The dark stays empty around the spark at first; the dust is lit by the awakening.
    glow = sock(next(n for n in bpy.data.materials["LC_M_Dust"].node_tree.nodes if n.type == "EMISSION"), "Strength")
    keyframe(glow, "default_value", 1, 0.0)
    keyframe(glow, "default_value", 40, 0.0)
    keyframe(glow, "default_value", 130, 1.6)


# ---------------------------------------------------------------- lights

def build_lights(col):
    def area(name, location, color, power, size, rotation):
        data = bpy.data.lights.get(name) or bpy.data.lights.new(name, "AREA")
        data.color, data.energy, data.size = color[:3], power, size
        data.volume_factor = 0.35  # light the haze softly: a strong factor shows as a blob at the frame edge
        ob = bpy.data.objects.new(name, data)
        ob.location = location
        ob.rotation_euler = Euler([math.radians(a) for a in rotation])
        link(col, ob)
        return data
    rim_cyan = area("LC_Rim_Cyan", (-5.5, 6.5, 3.0), PAL["cyan"], 0.0, 5.0, (-60, 0, 215))
    rim_violet = area("LC_Rim_Violet", (6.0, 5.0, -1.5), PAL["violet"], 0.0, 4.0, (-95, 0, 130))
    top = area("LC_Top", (0.0, -1.0, 7.0), PAL["ice"], 0.0, 6.0, (8, 0, 0))
    for data, peak in ((rim_cyan, 900.0), (rim_violet, 650.0), (top, 120.0)):
        keyframe(data, "energy", 1, 0.0)
        keyframe(data, "energy", 120, peak * 0.15)
        keyframe(data, "energy", 180, peak)


def animate_camera_awakening(cam, target):
    keyframe(cam, "location", 1, (4.0, -52.0, 12.0))
    keyframe(cam, "location", 110, (7.0, -32.0, 8.0))
    keyframe(cam, "location", 180, (9.0, -21.5, 6.8))
    keyframe(target, "location", 1, (0.0, 0.0, 0.0))
    keyframe(cam.data, "lens", 1, 50.0)
    keyframe(cam.data, "lens", 180, 55.0)


# ---------------------------------------------------------------- edit (sound and picture)

# Accent sounds (scripts/sfx.mjs) placed on the picture: (file, first frame, volume). The riser ends
# abruptly where the core ignites, and the impact lands on that frame.
CUES_01 = [
    ("bed-1.mp3", 1, 0.18),
    ("01-spark-1.mp3", 9, 0.8),
    ("01-wave-2.mp3", 18, 0.6),
    ("01-riser-1.mp3", 99, 0.4),
    ("01-impact-1.mp3", 168, 0.45),
]


def build_edit(frames, cues, renders="//renders/s01/", output="//renders/draft_s01.mp4"):
    """A separate LC_Edit scene: the rendered frames, the sounds on their frames, a fade out, written
    to one H.264/AAC file by rendering that scene (the frames already carry the film's view transform)."""
    import os
    edit = bpy.data.scenes.get("LC_Edit")
    if edit:
        bpy.data.scenes.remove(edit)
    edit = bpy.data.scenes.new("LC_Edit")
    edit.render.fps = FPS
    edit.render.resolution_x, edit.render.resolution_y, edit.render.resolution_percentage = 1920, 1080, 100
    edit.frame_start, edit.frame_end = frames
    edit.view_settings.view_transform = "Standard"
    se = edit.sequence_editor_create()
    folder = bpy.path.abspath(renders)
    files = sorted(f for f in os.listdir(folder) if f.endswith(".png"))[: frames[1] - frames[0] + 1]
    picture = se.strips.new_image("Picture", os.path.join(folder, files[0]), 1, frames[0], fit_method="ORIGINAL")
    for name in files[1:]:
        picture.elements.append(name)
    picture.frame_final_end = frames[1] + 1  # holds the last rendered frame if the edit runs longer
    fade = 30
    keyframe(picture, "color_multiply", frames[1] - fade, 1.0)
    keyframe(picture, "color_multiply", frames[1], 0.0)
    for channel, (name, frame, volume) in enumerate(cues, start=2):
        sound = se.strips.new_sound(name, bpy.path.abspath("//audio/sfx/" + name), channel, frame)
        if sound.frame_final_end > frames[1]:
            sound.frame_final_end = frames[1]
        keyframe(sound, "volume", max(frame, sound.frame_final_end - fade), volume)
        keyframe(sound, "volume", sound.frame_final_end, 0.0)
        if name.startswith("bed"):
            keyframe(sound, "volume", frame, 0.0)
            keyframe(sound, "volume", frame + 45, volume)
    r = edit.render
    r.image_settings.media_type = "VIDEO"
    r.image_settings.file_format = "FFMPEG"
    r.ffmpeg.format, r.ffmpeg.codec = "MPEG4", "H264"
    r.ffmpeg.constant_rate_factor, r.ffmpeg.ffmpeg_preset = "HIGH", "BEST"
    r.ffmpeg.audio_codec, r.ffmpeg.audio_bitrate, r.ffmpeg.audio_mixrate = "AAC", 256, 48000
    r.filepath = output
    r.use_sequencer = True
    return edit


# ---------------------------------------------------------------- build

def reset():
    """Forget the previous build's animation: Blender reuses actions across data with the same names,
    so keys from an older build would otherwise survive in the new one."""
    for ids in (bpy.data.objects, bpy.data.materials, bpy.data.lights, bpy.data.cameras, bpy.data.curves, bpy.data.worlds):
        for idb in ids:
            if idb.name.startswith("LC_"):
                idb.animation_data_clear()
                if getattr(idb, "node_tree", None):
                    idb.node_tree.animation_data_clear()
    for action in list(bpy.data.actions):
        if action.users == 0:
            bpy.data.actions.remove(action)


def build(preview=True):
    reset()
    setup_render(preview)
    setup_world()
    setup_compositor()
    root_col = collection("LC_Film")
    env = collection("LC_Environment", root_col)
    cams = collection("LC_Camera", root_col)
    core_col = collection("LC_Core", root_col)
    particles = collection("LC_Particles", root_col)
    lights = collection("LC_Lighting", root_col)
    cam, target = setup_camera(cams)
    root, heart, core_light = build_core(core_col)
    build_machine(collection("LC_Machine", root_col))
    build_spark(particles)
    build_particles(particles, core_col)
    build_lights(lights)
    animate_awakening(heart, core_light, root)
    animate_camera_awakening(cam, target)
    bpy.context.scene.frame_set(150)
    print("built", sorted(o.name for o in root_col.all_objects)[:60])
