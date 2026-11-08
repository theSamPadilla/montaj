"""A talk clip as a glTF 2.0 binary the Montaj app's add_clips takes (numpy and stdlib only).

In code: write_glb(path, duration, morphs, bones, skeleton=None, name='talk') -> info; skeleton_of(model.json) -> skeleton;
move_bytes(morphs, bones, name) -> the app move's estimated JSON size; write_clips(stem, duration, morphs, bones, skeleton, name,
pauses) -> one file, or several cut at pauses when one move would pass the app's cap (MOVES_CAP_BYTES).

morphs: {shape key: [[t, w], ...]} and bones: {bone: [[t, [rx, ry, rz]], ...]}, as face.build's clip holds them: a bone's value is
its turn in the app's move-track terms (library/model3d/motion.js header: Euler degrees, order ZYX, an offset from rest in the
parent's axes; applyPose sets the bone's local rotation to quatZYX(value) x qRest). Keys are piecewise linear.

The file:
- a stub mesh 'talk_face' (one triangle) with one morph target per shape key, named in mesh.extras.targetNames (GLTFLoader's
  morphTargetDictionary). Every target is the same accessor: vertex 0 moved STUB_DELTA m along +Z, so none is empty. The shape
  keys play on one 'weights' channel, LINEAR, at the union of every key's times (each key's own linear interpolation there, which
  is exact for piecewise-linear keys).
- the skeleton: the bones the clip keys, every bone that rests turned (a rest rotation) and every bone above them, named as the app builds them (library/model3d/bone-name.js:
  '.' to '_'), each node at its head less its parent's head, unrotated: the app's bind pose (library/model3d/build.js builds every
  bone unrotated at its head, then turns it by its rest rotation). They hang under 'talk_root', whose transform is the inverse
  of the placement add_clips will apply (retarget.js placement: S(scale) T(-centre) Rz(yaw) A, A three's Y-up to Blender's Z-up),
  so each node's world, placed, is the engine bone's exactly. Each bone that is keyed, or rests turned, plays a rotation channel
  (LINEAR): its local rotation quatZYX(value) x qRest. retarget.js then takes 'name' mode (the rests agree) and keysFromTargets
  gives back value = eulerZYX(local x qRest^-1) (import.js keysFromTargets): the clip's own values, at the importer's samples.
- one animation, `name`.

The placement is the model's rig.json `place` when add_clips would read that file (model-routes.cjs readRig: format 1, its
skeleton fingerprint the model's, frames present), else none (retarget then turns by the facing and scales by bone length, which
are 0 and 1 for the model's own skeleton).
"""
import hashlib, json, math, os, struct

import numpy as np

STUB_DELTA = 1e-4  # m: each morph target moves the stub's first vertex this far, so no importer drops a target as empty
ROOT_NODE = 'talk_root'
MESH_NODE = 'talk_face'

# The bones face.build keys and the chain above them, from the app's MakeHuman base-body rig (CC0; NOTICE), as its importer
# stores it (montaj-app library/test/fixtures/model3d/mh-adult-skeleton.json), for a clip written without a target model.
REFERENCE_ROWS = [
    ['hips', None, [0.004756, -0.023766, 0.856877]],
    ['spine', 'hips', [0, -0.019587, 0.976728]],
    ['mixamorig_Spine1', 'spine', [0, -0.014223, 1.069714]],
    ['chest', 'mixamorig_Spine1', [0, -0.01224, 1.187795]],
    ['mixamorig_LeftShoulder', 'chest', [0.061064, -0.017592, 1.309696]],
    ['neck', 'chest', [0, 0.001126, 1.332935]],
    ['head', 'neck', [0.000389, -0.023232, 1.393912]],
    ['mixamorig_RightShoulder', 'chest', [-0.05187, -0.014409, 1.308511]],
]
REFERENCE = {'rows': REFERENCE_ROWS, 'place': None}

# A move's keys as the app writes them (import.js keysFromTargets, retarget.js clipMorphs): [t, w, "linear"] and
# [t, [x, y, z], "linear"], t to 5 decimals, w to 4, turns to 3. Measured through add_clips' retarget on face.build's clips
# (2026-11-08, four golden clips): 23.7 bytes a shape key's key and 39 a turn's; the move keeps 1.01 keys a shape key's clip key
# (its 30 fps samples, thinned) and fewer than one a turn's clip key. The estimate takes the clip's own keys at these sizes.
MORPH_KEY_BYTES = 24.5
TRACK_KEY_BYTES = 40
MOVES_CAP_BYTES = 512 * 1024  # what one add_clips call may add (montaj-app desktop/src/model3d-library-add.cjs), all its files together
FILL = 0.85  # a piece is cut to at most this share of the cap


# ---- quaternions [x, y, z, w], as three and motion.js ----
def quat_zyx(deg):
    """Euler degrees [rx, ry, rz], order 'ZYX' (R = Rz Ry Rx), to quaternions; motion.js quatZYX (three's formula). deg: (..., 3)."""
    r = np.radians(np.asarray(deg, dtype=np.float64)) / 2
    c, s = np.cos(r), np.sin(r)
    c1, c2, c3, s1, s2, s3 = c[..., 0], c[..., 1], c[..., 2], s[..., 0], s[..., 1], s[..., 2]
    return np.stack([s1 * c2 * c3 - c1 * s2 * s3, c1 * s2 * c3 + s1 * c2 * s3, c1 * c2 * s3 - s1 * s2 * c3, c1 * c2 * c3 + s1 * s2 * s3], -1)


def qmul(a, b):
    ax, ay, az, aw = np.moveaxis(np.asarray(a, dtype=np.float64), -1, 0)
    bx, by, bz, bw = np.moveaxis(np.asarray(b, dtype=np.float64), -1, 0)
    return np.stack([aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx,
                     aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz], -1)


def euler_zyx(q):
    """A quaternion to Euler degrees, order 'ZYX'; motion.js eulerZYX (three's setFromRotationMatrix)."""
    x, y, z, w = (float(v) for v in q)
    m11, m21 = 1 - 2 * (y * y + z * z), 2 * (x * y + w * z)
    m31, m32, m33 = 2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)
    m12, m22 = 2 * (x * y - w * z), 1 - 2 * (x * x + z * z)
    ry = math.degrees(math.asin(-min(1, max(-1, m31))))
    if abs(m31) < 0.9999999:
        return [math.degrees(math.atan2(m32, m33)), ry, math.degrees(math.atan2(m21, m11))]
    return [0.0, ry, math.degrees(math.atan2(-m12, m22))]


def _mat_quat(m):
    """A 3x3 rotation matrix to a unit quaternion [x, y, z, w]."""
    t = np.trace(m)
    if t > 0:
        s = math.sqrt(t + 1) * 2
        q = [(m[2, 1] - m[1, 2]) / s, (m[0, 2] - m[2, 0]) / s, (m[1, 0] - m[0, 1]) / s, s / 4]
    else:
        i = int(np.argmax(np.diag(m)))
        j, k = (i + 1) % 3, (i + 2) % 3
        s = math.sqrt(1 + m[i, i] - m[j, j] - m[k, k]) * 2
        q = [0.0] * 4
        q[i] = s / 4
        q[j] = (m[j, i] + m[i, j]) / s
        q[k] = (m[k, i] + m[i, k]) / s
        q[3] = (m[k, j] - m[j, k]) / s
    q = np.array(q)
    return q / np.linalg.norm(q)


# three's Y-up to Blender's Z-up ([x, y, z] -> [x, -z, y]): retarget.js axes, import.js the same.
A = np.array([[1., 0, 0], [0, 0, -1], [0, 1, 0]])


def root_trs(place):
    """talk_root's translation, rotation and scale: the inverse of retarget.js placement(place) (S T(-c) Rz(yaw) A), so a node's
    world, placed, is its engine position. place None: the identity placement (A alone)."""
    s, c, yaw = 1.0, np.zeros(3), 0.0
    if place:
        s, c, yaw = float(place['scale']), np.asarray(place['centre'], dtype=np.float64), float(place['yaw'])
    rz = np.array([[math.cos(yaw), -math.sin(yaw), 0], [math.sin(yaw), math.cos(yaw), 0], [0, 0, 1]])
    ri = (rz @ A).T  # R^-1; P^-1 = T(R^-1 c) R^-1 S^-1
    return ri @ c, _mat_quat(ri), 1.0 / s


# ---- the model's skeleton, as add_clips reads it ----
def _js_num(x):
    """A number as JavaScript's JSON.stringify writes it."""
    if isinstance(x, bool) or isinstance(x, int):
        return json.dumps(x)
    if not math.isfinite(x):
        return 'null'
    if x == 0:
        return '0'
    if x == int(x) and abs(x) < 1e21:
        return str(int(x))
    r = repr(x)
    mant, _, ex = r.partition('e')
    if not ex:
        return r
    e = int(ex)
    if -7 < e < 21:  # JS writes these as plain decimals
        neg = mant.startswith('-')
        digits = mant.lstrip('-').replace('.', '')
        point = len(mant.lstrip('-').split('.')[0]) + e
        if point <= 0:
            s = '0.' + '0' * -point + digits
        elif point >= len(digits):
            s = digits + '0' * (point - len(digits))
        else:
            s = digits[:point] + '.' + digits[point:]
        return ('-' if neg else '') + s
    return f"{mant}e{'+' if e > 0 else '-'}{abs(e)}"


def js_stringify(v):
    """JSON.stringify(v) for parsed JSON (dicts keep their order; JS would put integer-like keys first, none here)."""
    if v is None:
        return 'null'
    if isinstance(v, bool):
        return 'true' if v else 'false'
    if isinstance(v, (int, float)):
        return _js_num(v)
    if isinstance(v, str):
        return json.dumps(v, ensure_ascii=False)
    if isinstance(v, list):
        return '[' + ','.join(js_stringify(x) for x in v) + ']'
    if isinstance(v, dict):
        return '{' + ','.join(json.dumps(str(k), ensure_ascii=False) + ':' + js_stringify(x) for k, x in v.items()) + '}'
    raise TypeError(f'not JSON: {type(v).__name__}')


def skeleton_key(rows):
    """model-routes.cjs skeletonKey: sha256 of JSON.stringify(model.skeleton)."""
    return hashlib.sha256(js_stringify(rows).encode('utf-8')).hexdigest()


def _finite(x):
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)


def read_place(dirname, rows):
    """The placement add_clips passes retarget (model-routes.cjs readRig), or None: rig.json's place when the file is format 1,
    recorded for this skeleton and holds a rest frame."""
    try:
        with open(os.path.join(dirname, 'rig.json')) as f:
            r = json.load(f)
    except (OSError, ValueError):
        return None
    if not (isinstance(r, dict) and r.get('format') == 1 and r.get('skeleton') == skeleton_key(rows) and isinstance(r.get('frames'), dict)):
        return None
    if not any(isinstance(q, list) and len(q) == 4 and all(_finite(v) for v in q) and math.hypot(*q) > 0 for q in r['frames'].values()):
        return None
    p = r.get('place')
    if (isinstance(p, dict) and _finite(p.get('scale')) and p['scale'] > 0 and isinstance(p.get('centre'), list) and len(p['centre']) == 3
            and all(_finite(v) for v in p['centre']) and _finite(p.get('yaw'))):
        return {'scale': p['scale'], 'centre': p['centre'], 'yaw': p['yaw']}
    return None


def skeleton_of(model_path):
    """A model.json's skeleton rows and the placement add_clips would use: {'rows', 'place'}."""
    with open(model_path) as f:
        model = json.load(f)
    rows = model.get('skeleton') if isinstance(model, dict) else None
    if not (isinstance(rows, list) and len(rows) > 1):
        raise ValueError(f'{model_path}: no skeleton (clips need a rigged model)')
    return {'rows': rows, 'place': read_place(os.path.dirname(os.path.abspath(model_path)), rows)}


# ---- keys ----
def _keys(k):
    a = sorted(((float(t), v) for t, v in k), key=lambda x: x[0])
    t = np.array([x[0] for x in a])
    v = np.array([x[1] for x in a], dtype=np.float64)
    return t, v


def _span(t, v, duration):
    """Keys held out to 0 and `duration` (the move holds its end keys; three's clip lasts to its last key)."""
    if t[0] > 0:
        t, v = np.concatenate([[0.], t]), np.concatenate([v[:1], v])
    if t[-1] < duration:
        t, v = np.concatenate([t, [duration]]), np.concatenate([v, v[-1:]])
    return t, v


def _interp(tq, t, v):
    if v.ndim == 1:
        return np.interp(tq, t, v)
    return np.stack([np.interp(tq, t, v[:, i]) for i in range(v.shape[1])], 1)


def _chain(rows, keyed):
    """The rows the file carries, in skeleton order: the keyed bones and every bone above them ('root' left out)."""
    by = {r[0]: r for r in rows}
    want = set()
    for b in keyed:
        while b is not None and b in by and b != 'root' and b not in want:
            want.add(b)
            b = by[b][1]
    return [r for r in rows if r[0] in want]


def _rest_quat(row):
    rot = row[3].get('rot') if len(row) > 3 and isinstance(row[3], dict) else None
    if isinstance(rot, list) and len(rot) == 3 and any(rot):
        return quat_zyx(rot)
    return None


# ---- the file ----
def _pad(b, fill=b'\0'):
    return b + fill * (-len(b) % 4)


def write_glb(path, duration, morphs=None, bones=None, skeleton=None, name='talk'):
    """Writes the clip (see the module doc). skeleton: skeleton_of(model.json), or None for REFERENCE. -> {'bytes', 'morphs',
    'bones' (the keyed bones written), 'dropped' (keyed bones the skeleton lacks), 'nodes', 'place', 'firstValues' ({bone: its
    value at 0}: what an additive layer takes off every key, motion.js Layers: it plays the change since the move's time 0)}."""
    duration = float(duration)
    if not duration > 0:
        raise ValueError('duration must be > 0')
    morphs = {k: v for k, v in (morphs or {}).items() if v}
    bones = {k: v for k, v in (bones or {}).items() if v}
    sk = skeleton if skeleton is not None else REFERENCE
    rows = [r for r in sk['rows'] if isinstance(r, list) and len(r) >= 3]
    by = {r[0]: r for r in rows}
    dropped = sorted(b for b in bones if b not in by or b == 'root')
    keyed = [b for b in bones if b not in dropped]

    bin_ = bytearray()
    views, accs = [], []

    def acc(arr, typ, minmax=False):
        a = np.ascontiguousarray(arr, dtype='<f4')
        views.append({'buffer': 0, 'byteOffset': len(bin_), 'byteLength': a.nbytes})
        bin_.extend(_pad(a.tobytes()))
        n = a.shape[0]
        d = {'bufferView': len(views) - 1, 'componentType': 5126, 'count': n, 'type': typ}
        if minmax:
            flat = a.reshape(n, -1)
            d['min'] = [float(x) for x in flat.min(0)]
            d['max'] = [float(x) for x in flat.max(0)]
        accs.append(d)
        return len(accs) - 1

    nodes = [{'name': ROOT_NODE}]
    scene_nodes = [0]
    channels, samplers = [], []

    # The skeleton: bind pose under talk_root.
    t_, q_, s_ = root_trs(sk.get('place'))
    nodes[0].update({'translation': [float(x) for x in t_], 'rotation': [float(x) for x in q_], 'scale': [s_] * 3})
    # A bone that rests turned is carried too, its rest held: one the file leaves out rides its parent in retarget, and its
    # rest then comes back as a track of minus that rest (import.js keysFromTargets takes qRest off every bone's turn).
    chain = _chain(rows, keyed + [r[0] for r in rows if _rest_quat(r) is not None])
    index = {}
    for r in chain:
        b, parent, head = r[0], r[1], r[2]
        ph = by[parent][2] if parent in index else [0, 0, 0]
        index[b] = len(nodes)
        nodes.append({'name': b.replace('.', '_'), 'translation': [float(head[k]) - float(ph[k]) for k in range(3)]})
        if parent in index:
            nodes[index[parent]].setdefault('children', []).append(index[b])
        else:
            nodes[0].setdefault('children', []).append(index[b])
    for r in chain:
        b, rq = r[0], _rest_quat(r)
        if b not in bones and rq is None:
            continue
        if b in bones:
            t, v = _span(*_keys(bones[b]), duration)
            q = quat_zyx(v)
        else:
            t, q = np.array([0., duration]), np.zeros((2, 4)) + quat_zyx([0, 0, 0])
        if rq is not None:
            q = qmul(q, rq)
        # Neighbours on the same hemisphere: glTF LINEAR slerps the short way, as the Euler values would turn.
        for i in range(1, len(q)):
            if np.dot(q[i], q[i - 1]) < 0:
                q[i] = -q[i]
        samplers.append({'input': acc(t[:, None], 'SCALAR', True), 'output': acc(q, 'VEC4'), 'interpolation': 'LINEAR'})
        channels.append({'sampler': len(samplers) - 1, 'target': {'node': index[b], 'path': 'rotation'}})

    # The stub mesh and its weights.
    names = sorted(morphs)
    if names:
        pos = np.array([[0, 0, 0], [0.01, 0, 0], [0, 0.01, 0]], dtype=np.float64)
        delta = np.zeros((3, 3))
        delta[0, 2] = STUB_DELTA
        pa, da = acc(pos, 'VEC3', True), acc(delta, 'VEC3', True)
        mesh = {'name': MESH_NODE, 'primitives': [{'attributes': {'POSITION': pa}, 'targets': [{'POSITION': da} for _ in names]}],
                'weights': [0.0] * len(names), 'extras': {'targetNames': names}}
        nodes.append({'name': MESH_NODE, 'mesh': 0})
        scene_nodes.append(len(nodes) - 1)
        tk = {n: _span(*_keys(morphs[n]), duration) for n in names}
        tu = np.unique(np.concatenate([tk[n][0] for n in names]))
        w = np.stack([np.interp(tu, *tk[n]) for n in names], 1)
        samplers.append({'input': acc(tu[:, None], 'SCALAR', True), 'output': acc(w.reshape(-1, 1), 'SCALAR'), 'interpolation': 'LINEAR'})
        channels.append({'sampler': len(samplers) - 1, 'target': {'node': len(nodes) - 1, 'path': 'weights'}})

    if not channels:
        raise ValueError('the clip keys nothing this skeleton has')
    j = {'asset': {'version': '2.0', 'generator': 'montaj talk'}, 'scene': 0, 'scenes': [{'nodes': scene_nodes}], 'nodes': nodes,
         'animations': [{'name': name, 'channels': channels, 'samplers': samplers}],
         'buffers': [{'byteLength': len(bin_)}], 'bufferViews': views, 'accessors': accs}
    if names:
        j['meshes'] = [mesh]
    jb = _pad(json.dumps(j, separators=(',', ':')).encode(), b' ')
    total = 12 + 8 + len(jb) + 8 + len(bin_)
    with open(path, 'wb') as f:
        f.write(b'glTF' + struct.pack('<II', 2, total))
        f.write(struct.pack('<I', len(jb)) + b'JSON' + jb)
        f.write(struct.pack('<I', len(bin_)) + b'BIN\0' + bytes(bin_))
    first = {b: [round(float(x), 4) for x in _interp(np.array([0.]), *_keys(bones[b]))[0]] for b in keyed if b in index}
    return {'bytes': total, 'morphs': names, 'bones': [b for b in keyed if b in index], 'dropped': dropped, 'nodes': len(nodes),
            'place': sk.get('place'), 'firstValues': first}


# ---- size, and cutting a long clip ----
def move_bytes(morphs=None, bones=None, name='talk'):
    """The JSON size of the move add_clips makes of this clip, estimated from its keys (see MORPH_KEY_BYTES)."""
    n = 80 + len(name)
    for k, v in (morphs or {}).items():
        n += len(k) + 6 + MORPH_KEY_BYTES * len(v)
    for k, v in (bones or {}).items():
        n += len(k) + 6 + TRACK_KEY_BYTES * len(v)
    return int(math.ceil(n))


def slice_keys(keys, a, b):
    """Keys on [a, b], shifted to start at 0: those inside, and each end's linear value (exact for piecewise-linear keys)."""
    t, v = _keys(keys)
    inner = (t > a + 1e-9) & (t < b - 1e-9)
    tq = np.concatenate([[a], t[inner], [b]])
    vq = _interp(tq, t, v)
    r = (lambda x: [round(float(y), 4) for y in x]) if v.ndim > 1 else (lambda x: round(float(x), 4))
    return [[round(float(x - a), 5), r(y)] for x, y in zip(tq, vq)]


def _cut(keys_of, a, b):
    return {k: slice_keys(v, a, b) for k, v in keys_of.items() if v}


def pieces(duration, morphs=None, bones=None, pauses=(), cap=MOVES_CAP_BYTES, fill=FILL, name='talk'):
    """[(start, end)]: the whole clip when its move fits fill x cap, else pieces cut in the middle of pauses, each as long as fits.
    pauses: [[from, to]] seconds of silence (gaps between the report's phrases). A stretch with no pause that fits is cut where it
    must, at the longest length that fits."""
    duration = float(duration)
    limit = cap * fill
    if move_bytes(morphs, bones, name) <= limit:
        return [(0.0, duration)]
    cuts = sorted({round((float(p0) + float(p1)) / 2, 3) for p0, p1 in pauses if 0 < (float(p0) + float(p1)) / 2 < duration})
    size = lambda a, b: move_bytes(_cut(morphs or {}, a, b), _cut(bones or {}, a, b), name)
    out, a = [], 0.0
    while size(a, duration) > limit:
        ok = [c for c in cuts if c > a + 1e-6 and size(a, c) <= limit]
        if ok:
            b = ok[-1]
        else:  # no pause fits: the longest stretch that does, to 10 ms
            lo, hi = a, duration
            while hi - lo > 0.01:
                mid = (lo + hi) / 2
                lo, hi = (mid, hi) if size(a, mid) <= limit else (lo, mid)
            b = round(lo, 3)
            if b <= a:
                raise ValueError(f'the clip at {a:.3f} s keys too much to fit {cap} bytes in any stretch')
        out.append((a, b))
        a = b
    out.append((a, duration))
    return out


def write_clips(stem, duration, morphs=None, bones=None, skeleton=None, name='talk', pauses=(), cap=MOVES_CAP_BYTES):
    """The clip as one GLB (<stem>.glb, animation `name`), or, when its move would pass fill x cap, as several (<stem>-1.glb,
    <stem>-2.glb ..., animations name_1, name_2 ...) cut at pauses (see pieces). ONE add_clips CALL PER FILE: the cap is on what one
    call adds, so two pieces in one call would pass it. Each file's move plays from its `start` (timeline seconds from the clip's
    start). -> [{'call' (1, 2 ...: its own add_clips call), 'path', 'name', 'start', 'duration', 'moveBytes', **write_glb's}]."""
    ps = pieces(duration, morphs, bones, pauses, cap, name=name)
    out = []
    for i, (a, b) in enumerate(ps):
        one = len(ps) == 1
        m, bn = (morphs, bones) if one else (_cut(morphs or {}, a, b), _cut(bones or {}, a, b))
        path, nm = (f'{stem}.glb', name) if one else (f'{stem}-{i + 1}.glb', f'{name}_{i + 1}')
        info = write_glb(path, b - a, m, bn, skeleton, nm)
        out.append({'call': i + 1, 'path': path, 'name': nm, 'start': round(a, 3), 'duration': round(b - a, 3), 'moveBytes': move_bytes(m, bn, nm), **info})
    return out
