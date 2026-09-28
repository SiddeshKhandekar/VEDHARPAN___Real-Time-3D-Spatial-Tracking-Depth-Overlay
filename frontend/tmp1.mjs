/**
 * hand_rig.js  —  Mode 4: Mecha Physical Hands
 *
 * Key improvements in this version:
 *
 *  1. ORIENTATION-INDEPENDENT FINGER CURL
 *     `boneCurl(lms, a, b, c)` computes the included 3-D angle between bone
 *     vectors a→b and b→c using the dot-product of normalised vectors.  This
 *     works at any hand orientation (flat, vertical, inverted, rotated 360°).
 *
 *  2. HIGHER-QUALITY GEOMETRY
 *     CapsuleGeometry radial segments: 4 → 8 (smooth cylinders)
 *     Palm box subdivisions: 3×4×2 (better lighting gradient)
 *     Wrist capsule radial segments: 5 → 10
 *
 *  3. ALWAYS-VISIBLE DESIGN
 *     Hands are visible as soon as activate() creates them; they hold an idle
 *     open pose until webcam data arrives, then mirror live.
 *
 *  MediaPipe landmark indices used:
 *    0          = Wrist
 *    1–4        = Thumb   (CMC→MCP→IP→TIP)
 *    5–8        = Index   (MCP→PIP→DIP→TIP)
 *    9–12       = Middle  (MCP→PIP→DIP→TIP)
 *    13–16      = Ring    (MCP→PIP→DIP→TIP)
 *    17–20      = Pinky   (MCP→PIP→DIP→TIP)
 */

import * as THREE from 'three';

// ─── World-space positioning ────────────────────────────────────────────────────
const HAND_SCALE = 3.2;    // uniform scale applied to all design-unit dimensions
const SHOULDER_X = 6.5;    // lateral rest distance from mecha centre (world units)
const SHOULDER_Y = 0.8;    // height above mechaWrapper origin
const SHOULDER_Z = 1.8;    // forward offset (mecha forward = +Z)
const SWAY_X = 3.5;    // max lateral sway around SHOULDER_X baseline
const SWAY_Y = 2.2;    // max vertical sway around SHOULDER_Y

// ─── Palm geometry (design units; all multiplied by HAND_SCALE) ───────────────
const WRIST_R = 0.12;
const WRIST_H = 0.30;
const PALM_W = 0.52;
const PALM_H = 0.74;
const PALM_D = 0.22;

// ─── Four-finger layout ───────────────────────────────────────────────────────
//   baseX = X offset from palm centre (design units, rightward = positive)
//   fan   = Z-rotation spread (radians, outward)
//   r     = proximal-phalanx radius (design units)
//   lens  = [proximal, middle, distal] segment lengths
const FINGERS = [
    { name: 'index', baseX: -0.182, fan: 0.10, r: 0.086, lens: [0.50, 0.34, 0.22] },
    { name: 'middle', baseX: -0.061, fan: 0.03, r: 0.092, lens: [0.57, 0.40, 0.24] },
    { name: 'ring', baseX: 0.061, fan: -0.04, r: 0.082, lens: [0.50, 0.36, 0.22] },
    { name: 'pinky', baseX: 0.178, fan: -0.13, r: 0.066, lens: [0.37, 0.26, 0.16] },
];

// ─── Thumb (3 segments) ───────────────────────────────────────────────────────
const THUMB_SEGS = [
    { r: 0.115, len: 0.30 },
    { r: 0.100, len: 0.36 },
    { r: 0.082, len: 0.25 },
];
const THUMB_EDGE_X = PALM_W * 0.50;
const THUMB_UP_FRAC = 0.22;
const THUMB_OUT_Z = Math.PI * 0.32;          // ~58° outward
const THUMB_FWD_X = THREE.MathUtils.degToRad(-22);

// ─── Curl / lerp constants ────────────────────────────────────────────────────
const MAX_CURL = 1.52;   // radians — max segment rotation when fully closed
const IDLE_CURL = 0.12;   // relaxed open pose angle
const THUMB_MAX = 1.10;
const THUMB_IDLE = 0.08;
const LERP_LIVE = 0.20;   // lerp speed when tracking (per-frame)
const LERP_IDLE = 0.06;   // lerp speed when drifting to idle

// ─── EMA filter ───────────────────────────────────────────────────────────────
class EMA {
    constructor(a = 0.16) { this.a = a; this.v = null; }
    update(x) {
        this.v = (this.v === null) ? x : this.a * x + (1 - this.a) * this.v;
        return this.v;
    }
    reset() { this.v = null; }
}

// ─── Material ─────────────────────────────────────────────────────────────────
function mkMat() {
    return new THREE.MeshStandardMaterial({
        color: 0x00e8ff,
        emissive: 0x004d66,
        emissiveIntensity: 0.90,
        metalness: 0.22,
        roughness: 0.44,
        side: THREE.DoubleSide,
    });
}

// ─── Orientation-independent bone-angle curl ──────────────────────────────────
/**
 * Returns the curl amount [0, 1] at the joint b, formed by bones a→b and b→c.
 * Uses the 3-D included angle between the two bone vectors:
 *   0 = perfectly straight (no curl)
 *   1 = maximally folded (180° — unlikely in practice, but useful as ceiling)
 *
 * Works correctly at ANY hand orientation because it uses all three coordinates
 * (x, y, z) from MediaPipe, not just screen-Y.
 *
 * @param {object[]} lms  — array of {x,y,z} landmark objects (21 items)
 * @param {number}   a    — proximal landmark index (e.g. MCP)
 * @param {number}   b    — middle  landmark index  (e.g. PIP)
 * @param {number}   c    — distal  landmark index  (e.g. DIP or TIP)
 */
function boneCurl(lms, a, b, c) {
    const ax = lms[b].x - lms[a].x, ay = lms[b].y - lms[a].y, az = lms[b].z - lms[a].z;
    const bx = lms[c].x - lms[b].x, by = lms[c].y - lms[b].y, bz = lms[c].z - lms[b].z;
    const magA = Math.sqrt(ax * ax + ay * ay + az * az);
    const magB = Math.sqrt(bx * bx + by * by + bz * bz);
    if (magA < 1e-7 || magB < 1e-7) return 0;
    const dot = ax * bx + ay * by + az * bz;
    const cosA = Math.max(-1, Math.min(1, dot / (magA * magB)));
    return Math.acos(cosA) / Math.PI;   // 0 = straight, 1 = fully folded
}

function lerp(cur, tgt, t) { return cur + (tgt - cur) * t; }

// ─── HandRig ──────────────────────────────────────────────────────────────────
export class HandRig {
    /**
     * @param {THREE.Scene}    scene
     * @param {THREE.Object3D} mechaWrapper   — unscaled mecha root group
     * @param {'left'|'right'} side
     */
    constructor(scene, mechaWrapper, side) {
        this._scene = scene;
        this._mecha = mechaWrapper;
        this._side = side;
        this._sign = side === 'right' ? 1 : -1;
        this._emaX = new EMA(0.16);
        this._emaY = new EMA(0.16);
        this._emaZ = new EMA(0.12);   // z / depth smoother
        const S = HAND_SCALE;

        // ── Root ─────────────────────────────────────────────────────────
        this.root = new THREE.Group();
        this.root.position.set(this._sign * SHOULDER_X, SHOULDER_Y, SHOULDER_Z);
        this.root.rotation.y = THREE.MathUtils.degToRad(this._sign * -15);
        if (side === 'left') this.root.scale.x = -1;
        this.root.visible = true;
        mechaWrapper.add(this.root);

        const mat = mkMat();

        // ── Wrist (smooth 10-sided capsule) ───────────────────────────────
        const wGeo = new THREE.CapsuleGeometry(S * WRIST_R, S * WRIST_H, 6, 10);
        const wMesh = new THREE.Mesh(wGeo, mat.clone());
        wMesh.position.y = S * WRIST_H * 0.5;
        this.root.add(wMesh);

        // ── Palm (subdivided box for smooth shading) ──────────────────────
        this._palmBaseY = S * WRIST_H;
        const pGeo = new THREE.BoxGeometry(S * PALM_W, S * PALM_H, S * PALM_D, 3, 4, 2);
        const pMesh = new THREE.Mesh(pGeo, mat.clone());
        pMesh.position.y = this._palmBaseY + S * PALM_H * 0.5;
        this.root.add(pMesh);

        // Knuckle ridge (horizontal pill across top of palm)
        const kGeo = new THREE.CapsuleGeometry(S * 0.042, S * PALM_W * 0.80, 4, 8);
        kGeo.applyMatrix4(new THREE.Matrix4().makeRotationZ(Math.PI / 2));
        const kMesh = new THREE.Mesh(kGeo, mat.clone());
        kMesh.position.set(0, this._palmBaseY + S * PALM_H, -S * PALM_D * 0.18);
        this.root.add(kMesh);

        // ── Finger pivot at top of palm ───────────────────────────────────
        this._palmTop = new THREE.Object3D();
        this._palmTop.position.y = this._palmBaseY + S * PALM_H;
        this.root.add(this._palmTop);

        // ── 4 Fingers ─────────────────────────────────────────────────────
        this._chains = {};
        for (const cfg of FINGERS) {
            this._chains[cfg.name] = this._buildChain(
                S, mat, cfg.baseX, cfg.fan, cfg.r, cfg.lens, this._palmTop,
            );
        }

        // ── Thumb ─────────────────────────────────────────────────────────
        const tAnchor = new THREE.Object3D();
        tAnchor.position.set(
            S * THUMB_EDGE_X,
            this._palmBaseY + S * PALM_H * THUMB_UP_FRAC,
            0,
        );
        tAnchor.rotation.z = THUMB_OUT_Z;
        tAnchor.rotation.x = THUMB_FWD_X;
        this.root.add(tAnchor);
        this._chains.thumb = this._buildThumbChain(S, mat, tAnchor);

        // ── Grab point for HandPhysics ────────────────────────────────────
        this.grabPoint = new THREE.Object3D();
        this.grabPoint.position.y = this._palmBaseY + S * PALM_H * 0.5;
        this.root.add(this.grabPoint);

        // Start with relaxed idle pose
        this._setAllAngles(IDLE_CURL, THUMB_IDLE, 1.0);
    }

    // ── Build standard 3-segment finger chain ─────────────────────────────────
    _buildChain(S, mat, baseX, fanZ, baseR, lens, parentObj) {
        const chain = [];
        let parent = parentObj;
        for (let i = 0; i < lens.length; i++) {
            const len = S * lens[i];
            const radius = Math.max(S * baseR * (1 - i * 0.13), S * 0.026);
            const capLen = Math.max(len - radius * 2, 0.001);

            const pivot = new THREE.Object3D();
            if (i === 0) {
                pivot.position.set(S * baseX, 0, 0);
                pivot.rotation.z = fanZ;
            } else {
                pivot.position.y = chain[i - 1]._segLen;
            }

            // 8 radial segments for smooth circular cross-section
            const geo = new THREE.CapsuleGeometry(radius, capLen, 5, 8);
            const mesh = new THREE.Mesh(geo, mat.clone());
            mesh.position.y = len * 0.5;
            pivot.add(mesh);

            pivot._segLen = len;
            chain.push(pivot);
            parent.add(pivot);
            parent = pivot;
        }
        return chain;
    }

    // ── Build thumb chain (3 segments direct from anchor) ─────────────────────
    _buildThumbChain(S, mat, anchor) {
        const chain = [];
        let parent = anchor;
        for (let i = 0; i < THUMB_SEGS.length; i++) {
            const { r, len: dLen } = THUMB_SEGS[i];
            const len = S * dLen;
            const radius = S * r;
            const capLen = Math.max(len - radius * 2, 0.001);

            const pivot = new THREE.Object3D();
            if (i > 0) pivot.position.y = chain[i - 1]._segLen;

            const geo = new THREE.CapsuleGeometry(radius, capLen, 5, 8);
            const mesh = new THREE.Mesh(geo, mat.clone());
            mesh.position.y = len * 0.5;
            pivot.add(mesh);

            pivot._segLen = len;
            chain.push(pivot);
            parent.add(pivot);
            parent = pivot;
        }
        return chain;
    }

    // ── Apply flat angle to every segment (for idle / reset) ──────────────────
    _setAllAngles(fingerAngle, thumbAngle, speed) {
        for (const [name, chain] of Object.entries(this._chains)) {
            const target = name === 'thumb' ? thumbAngle : fingerAngle;
            for (const seg of chain) {
                seg.rotation.x = lerp(seg.rotation.x, target, speed);
            }
        }
    }

    // ── Apply a curlMap {fingerName: [seg0, seg1, seg2, ...]} ─────────────────
    _applyFingerMap(curlMap, speed) {
        for (const [name, chain] of Object.entries(this._chains)) {
            const angles = curlMap[name];
            if (!angles) continue;
            for (let i = 0; i < chain.length; i++) {
                chain[i].rotation.x = lerp(chain[i].rotation.x, angles[i] ?? 0, speed);
            }
        }
    }

    // ─── Public API ───────────────────────────────────────────────────────────

    /**
     * Call every animation frame.
     * @param {object|null} handData  — { landmarks:[{x,y,z}×21], gesture, ... }
     */
    update(handData) {
        const lms = handData?.landmarks;

        if (lms && lms.length >= 21) {
            // ── Wrist position with EMA smoothing ─────────────────────────
            // rawX: high = hand on right side (in the already-mirrored coord).
            // No _sign multiplication on sway: the handedness routing ensures
            // the correct rig receives the correct data.
            const rawX = lms[0].x;                       // already [−1, +1] after backend
            const rawY = lms[0].y;                       // already [−1, +1]
            const rawZ = lms[0].z;

            const swX = this._emaX.update(rawX) * SWAY_X;
            const swY = this._emaY.update(rawY) * SWAY_Y;
            // Z depth: closer hand (negative z in MediaPipe) → push hand slightly forward
            const swZ = this._emaZ.update(rawZ) * 0.8;

            this.root.position.set(
                this._sign * SHOULDER_X + swX,
                SHOULDER_Y + swY,
                SHOULDER_Z - swZ,   // – because closer = negative z landmark
            );

            // ── Orientation-independent per-segment curl ───────────────────
            //
            // boneCurl(lms, a, b, c) = angle at joint b [0..1]
            //
            // Finger layout: MCP=base, PIP=middle-knuckle, DIP=upper-knuckle, TIP=tip
            //   Prox = MCP→PIP (seg 0)
            //   Mid  = PIP→DIP (seg 1)
            //   Dist = DIP→TIP (seg 2)

            // Index  (5=MCP, 6=PIP, 7=DIP, 8=TIP)
            const idxP = boneCurl(lms, 0, 5, 6) * MAX_CURL;
            const idxM = boneCurl(lms, 5, 6, 7) * MAX_CURL;
            const idxD = boneCurl(lms, 6, 7, 8) * MAX_CURL;

            // Middle (9=MCP, 10=PIP, 11=DIP, 12=TIP)
            const midP = boneCurl(lms, 0, 9, 10) * MAX_CURL;
            const midM = boneCurl(lms, 9, 10, 11) * MAX_CURL;
            const midD = boneCurl(lms, 10, 11, 12) * MAX_CURL;

            // Ring   (13=MCP, 14=PIP, 15=DIP, 16=TIP)
            const rngP = boneCurl(lms, 0, 13, 14) * MAX_CURL;
            const rngM = boneCurl(lms, 13, 14, 15) * MAX_CURL;
            const rngD = boneCurl(lms, 14, 15, 16) * MAX_CURL;

            // Pinky  (17=MCP, 18=PIP, 19=DIP, 20=TIP)
            const pnkP = boneCurl(lms, 0, 17, 18) * MAX_CURL;
            const pnkM = boneCurl(lms, 17, 18, 19) * MAX_CURL;
            const pnkD = boneCurl(lms, 18, 19, 20) * MAX_CURL;

            // Thumb  (1=CMC, 2=MCP, 3=IP, 4=TIP)
            const th0 = boneCurl(lms, 1, 2, 3) * THUMB_MAX;
            const th1 = boneCurl(lms, 2, 3, 4) * THUMB_MAX;
            const th2 = boneCurl(lms, 1, 3, 4) * THUMB_MAX * 0.7;   // distal

            const curlMap = {
                index: [idxP, idxM, idxD],
                middle: [midP, midM, midD],
                ring: [rngP, rngM, rngD],
                pinky: [pnkP, pnkM, pnkD],
                thumb: [th0, th1, th2],
            };

            this._applyFingerMap(curlMap, LERP_LIVE);

        } else {
            // ── No tracking: gentle drift back to idle open pose ───────────
            this._setAllAngles(IDLE_CURL, THUMB_IDLE, LERP_IDLE);
            this.root.position.x = lerp(this.root.position.x, this._sign * SHOULDER_X, LERP_IDLE);
            this.root.position.y = lerp(this.root.position.y, SHOULDER_Y, LERP_IDLE);
            this.root.position.z = lerp(this.root.position.z, SHOULDER_Z, LERP_IDLE);
            this._emaX.reset();
            this._emaY.reset();
            this._emaZ.reset();
        }
    }

    /** World-space palm-centre — used by HandPhysics every frame. */
    getGrabWorldPos(out = new THREE.Vector3()) {
        this.grabPoint.getWorldPosition(out);
        return out;
    }

    setVisible(v) { this.root.visible = v; }

    resetEMA() {
        this._emaX.reset();
        this._emaY.reset();
        this._emaZ.reset();
    }

    dispose() {
        this._mecha.remove(this.root);
        this.root.traverse(obj => {
            obj.geometry?.dispose();
            if (obj.material) {
                Array.isArray(obj.material)
                    ? obj.material.forEach(m => m.dispose())
                    : obj.material.dispose();
            }
        });
    }
}
