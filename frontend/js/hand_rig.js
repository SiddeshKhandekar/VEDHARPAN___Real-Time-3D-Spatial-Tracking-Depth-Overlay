/**
 * hand_rig.js  —  Mode 4: Mecha Physical Hands
 *
 * Full landmark-driven mirroring:
 *   • Hand position driven by wrist (LM 0) with correct sign logic.
 *   • Per-finger curl computed from the 21 MediaPipe landmark coordinates
 *     — each segment curl is derived from the real tip/joint positions, not
 *     just a gesture bucket.
 *   • Thumb is a large, clearly visible 3-segment structure on the lateral edge.
 *   • Hands are always visible once created; no tracking gate.
 *
 * MediaPipe landmark indices used:
 *   0  = Wrist
 *   1-4  = Thumb  (CMC, MCP, IP, TIP)
 *   5-8  = Index  (MCP, PIP, DIP, TIP)
 *   9-12 = Middle (MCP, PIP, DIP, TIP)
 *   13-16= Ring   (MCP, PIP, DIP, TIP)
 *   17-20= Pinky  (MCP, PIP, DIP, TIP)
 */

import * as THREE from 'three';

// ─── Position constants ────────────────────────────────────────────────────────
const HAND_SCALE = 3.2;      // world-unit multiplier
const SHOULDER_X = 6.5;      // lateral offset from mecha centre (world units)
const SHOULDER_Y = 0.8;      // height above mechaWrapper origin
const SHOULDER_Z = 1.8;      // forward from mecha origin

// Sway range — how far outside SHOULDER_X the hand can travel in each direction
const SWAY_X = 3.5;      // lateral (world units, symmetric around SHOULDER_X)
const SWAY_Y = 2.2;      // vertical

// ─── Palm geometry (design units, will be × HAND_SCALE) ───────────────────────
const WRIST_R = 0.12;
const WRIST_H = 0.30;
const PALM_W = 0.52;
const PALM_H = 0.74;
const PALM_D = 0.22;

// ─── 4 Finger configuration ───────────────────────────────────────────────────
// baseX  = X position relative to palm centre (design units)
// fan    = Z-rotation spread (radians, outward)
// r      = proximal phalanx radius
// lens   = [proximal, middle, distal] lengths
const FINGERS = [
    { name: 'index', baseX: -0.182, fan: 0.10, r: 0.086, lens: [0.50, 0.34, 0.22] },
    { name: 'middle', baseX: -0.061, fan: 0.03, r: 0.092, lens: [0.57, 0.40, 0.24] },
    { name: 'ring', baseX: 0.061, fan: -0.04, r: 0.082, lens: [0.50, 0.36, 0.22] },
    { name: 'pinky', baseX: 0.178, fan: -0.13, r: 0.066, lens: [0.37, 0.26, 0.16] },
];

// ─── Thumb configuration ──────────────────────────────────────────────────────
// 3 segments: metacarpal → proximal → distal
const THUMB_SEGS = [
    { r: 0.115, len: 0.30 },    // metacarpal (thick base)
    { r: 0.100, len: 0.36 },    // proximal phalanx
    { r: 0.082, len: 0.25 },    // distal phalanx (tip)
];
const THUMB_EDGE_X = PALM_W * 0.50;   // at the palm's side edge
const THUMB_UP_FRAC = 0.22;            // fraction up the palm height
const THUMB_OUT_ANGLE = Math.PI * 0.32;  // ≈58° outward from vertical (Z rotation)
const THUMB_FWD_ANGLE = THREE.MathUtils.degToRad(-22);  // X tilt (slightly forward)

// ─── Curl limits (rotation.x, radians) ───────────────────────────────────────
const MAX_CURL = 1.52;   // fully folded finger segment
const IDLE_CURL = 0.12;   // relaxed slight bend
const THUMB_MAX = 1.10;   // thumb curls less than fingers
const THUMB_IDLE = 0.08;

// ─── EMA smoother ─────────────────────────────────────────────────────────────
class EMA {
    constructor(a = 0.14) { this.a = a; this.v = null; }
    update(x) {
        this.v = this.v === null ? x : this.a * x + (1 - this.a) * this.v;
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
        side: THREE.DoubleSide,  // required for scale.x=-1 on left hand
    });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Compute how much a finger is curled (0=open, 1=fully closed)
 * from MediaPipe normalised landmarks.
 *
 * Strategy: measure how far below the MCP the TIP has fallen.
 *   When extended: tip.y « mcp.y  → low curl
 *   When closed:   tip.y ≈ mcp.y  → high curl
 *
 * @param {object[]} lms   — array of {x,y,z} landmark objects
 * @param {number}   mcp   — MCP landmark index
 * @param {number}   pip   — PIP landmark index
 * @param {number}   tip   — TIP landmark index
 * @param {number}   range — expected y-delta when finger is fully open (~0.30)
 */
function fingerCurl(lms, mcp, pip, tip, range = 0.28) {
    // Proximal bend: how much has PIP dropped below MCP?
    const proxBend = Math.max(lms[pip].y - lms[mcp].y, 0) / range;
    // Full bend: how much has TIP dropped below MCP?
    const fullBend = Math.max(lms[tip].y - lms[mcp].y, 0) / range;
    // Average — this gives a smooth 0..1 curl amount
    return Math.min((proxBend + fullBend) * 0.5, 1.0);
}

/** Lerp a number toward target at given speed. */
function lerp(cur, tgt, t) { return cur + (tgt - cur) * t; }

// ─── HandRig ──────────────────────────────────────────────────────────────────
export class HandRig {
    /**
     * @param {THREE.Scene}    scene
     * @param {THREE.Object3D} mechaWrapper  — parent group
     * @param {'left'|'right'} side
     */
    constructor(scene, mechaWrapper, side) {
        this._scene = scene;
        this._mecha = mechaWrapper;
        this._side = side;
        this._sign = side === 'right' ? 1 : -1;
        this._emaX = new EMA(0.14);
        this._emaY = new EMA(0.14);

        const S = HAND_SCALE;
        const mat = mkMat();

        // ── Root: shoulder rest position ──────────────────────────────────────
        this.root = new THREE.Group();
        this.root.position.set(this._sign * SHOULDER_X, SHOULDER_Y, SHOULDER_Z);
        this.root.rotation.y = THREE.MathUtils.degToRad(this._sign * -15);
        // Mirror left hand by flipping X scale (DoubleSide on mat handles normals)
        if (side === 'left') this.root.scale.x = -1;
        this.root.visible = true;   // always visible once created
        mechaWrapper.add(this.root);

        // ── Wrist ─────────────────────────────────────────────────────────────
        const wristGeo = new THREE.CapsuleGeometry(S * WRIST_R, S * WRIST_H, 5, 12);
        const wrist = new THREE.Mesh(wristGeo, mat.clone());
        wrist.position.y = S * WRIST_H * 0.5;
        this.root.add(wrist);

        // ── Palm ──────────────────────────────────────────────────────────────
        this._palmBaseY = S * WRIST_H;
        const palmGeo = new THREE.BoxGeometry(S * PALM_W, S * PALM_H, S * PALM_D);
        const palm = new THREE.Mesh(palmGeo, mat.clone());
        palm.position.y = this._palmBaseY + S * PALM_H * 0.5;
        this.root.add(palm);

        // Knuckle ridge (horizontal capsule at top of palm)
        const kGeo = new THREE.CapsuleGeometry(S * 0.042, S * PALM_W * 0.80, 3, 8);
        kGeo.applyMatrix4(new THREE.Matrix4().makeRotationZ(Math.PI / 2));
        const knuckle = new THREE.Mesh(kGeo, mat.clone());
        knuckle.position.set(0, this._palmBaseY + S * PALM_H, -S * PALM_D * 0.18);
        this.root.add(knuckle);

        // ── Finger pivot (top of palm) ────────────────────────────────────────
        this._palmTop = new THREE.Object3D();
        this._palmTop.position.y = this._palmBaseY + S * PALM_H;
        this.root.add(this._palmTop);

        // ── 4 Fingers ─────────────────────────────────────────────────────────
        this._chains = {};
        for (const cfg of FINGERS) {
            this._chains[cfg.name] = this._buildChain(
                S, mat, cfg.baseX, cfg.fan, cfg.r, cfg.lens, this._palmTop
            );
        }

        // ── Thumb: 3 segments from lateral palm edge ──────────────────────────
        const thumbAnchor = new THREE.Object3D();
        thumbAnchor.position.set(
            S * THUMB_EDGE_X,
            this._palmBaseY + S * PALM_H * THUMB_UP_FRAC,
            0,
        );
        thumbAnchor.rotation.z = THUMB_OUT_ANGLE;   // outward spread
        thumbAnchor.rotation.x = THUMB_FWD_ANGLE;   // slight forward tilt
        this.root.add(thumbAnchor);

        this._chains.thumb = this._buildThumbChain(S, mat, thumbAnchor);

        // ── Grab point (palm centre, for HandPhysics) ─────────────────────────
        this.grabPoint = new THREE.Object3D();
        this.grabPoint.position.y = this._palmBaseY + S * PALM_H * 0.5;
        this.root.add(this.grabPoint);

        // Start in idle pose
        this._setAllAngles(IDLE_CURL, THUMB_IDLE, 1.0);
    }

    // ── Build a standard finger bone chain (CapsuleGeometry, Y-axis) ─────────
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

            const geo = new THREE.CapsuleGeometry(radius, capLen, 4, 10);
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

    // ── Build the thumb chain (3 segments) ────────────────────────────────────
    _buildThumbChain(S, mat, anchor) {
        const chain = [];
        let parent = anchor;

        for (let i = 0; i < THUMB_SEGS.length; i++) {
            const seg = THUMB_SEGS[i];
            const len = S * seg.len;
            const radius = S * seg.r;
            const capLen = Math.max(len - radius * 2, 0.001);

            const pivot = new THREE.Object3D();
            if (i > 0) pivot.position.y = chain[i - 1]._segLen;

            const geo = new THREE.CapsuleGeometry(radius, capLen, 4, 10);
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

    // ── Internal: set all segments to a flat rotation at `speed` lerp rate ───
    _setAllAngles(fingerAngle, thumbAngle, speed) {
        for (const [name, chain] of Object.entries(this._chains)) {
            const target = name === 'thumb' ? thumbAngle : fingerAngle;
            for (const seg of chain) {
                seg.rotation.x = lerp(seg.rotation.x, target, speed);
            }
        }
    }

    // ── Internal: apply per-finger curl from a curlMap {fingerName: [seg0,seg1,seg2]} ─
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
     * Drive the hand from a telemetry hand entry.
     * Called every animation frame by ConstructMode.
     *
     * @param {object|null} handData  — { landmarks: [{x,y,z}×21], gesture, ... }
     */
    update(handData) {
        const lms = handData?.landmarks;

        if (lms && lms.length >= 21) {
            // ── Position: map wrist landmark to shoulder sway ──────────────
            // After backend mirroring, lm.x is:
            //   high  when hand is physically on the right side of the user
            //   low   when hand is on the left side
            // So for both rigs: rawX > 0 should sway rightward in world space.
            // We do NOT multiply by _sign here — the handedness routing in
            // construct_mode already ensures the correct rig receives the data.
            const rawX = (lms[0].x - 0.5) * 2;    // −1..+1
            const rawY = (lms[0].y - 0.5) * -2;   // −1..+1 (flip: up = +)

            const swX = this._emaX.update(rawX) * SWAY_X;
            const swY = this._emaY.update(rawY) * SWAY_Y;

            this.root.position.set(
                this._sign * SHOULDER_X + swX,
                SHOULDER_Y + swY,
                SHOULDER_Z,
            );

            // ── Per-finger curl from landmark geometry ─────────────────────
            // fingerCurl(lms, MCP_idx, PIP_idx, TIP_idx) → 0=open, 1=closed
            const curlIdx = fingerCurl(lms, 5, 6, 8);
            const curlMid = fingerCurl(lms, 9, 10, 12);
            const curlRng = fingerCurl(lms, 13, 14, 16);
            const curlPnk = fingerCurl(lms, 17, 18, 20);

            // Thumb: measure how far TIP has moved toward wrist (XY distance)
            const tTip = lms[4];
            const tMcp = lms[2];
            const tWrist = lms[0];
            const tipToWrist = Math.sqrt(
                (tTip.x - tWrist.x) ** 2 + (tTip.y - tWrist.y) ** 2
            );
            const mcpToWrist = Math.sqrt(
                (tMcp.x - tWrist.x) ** 2 + (tMcp.y - tWrist.y) ** 2
            );
            // When thumb is fully extended: tipToWrist is large (> mcpToWrist)
            // When thumb curls into fist: tipToWrist shrinks toward mcpToWrist
            const curlThumb = Math.min(
                Math.max(1.0 - (tipToWrist - mcpToWrist * 0.6) / (mcpToWrist * 0.8), 0),
                1.0
            );

            // Build per-segment angle map (0=open, 1=full curl)
            // Distribute curl: proximal gets full amount, middle 0.85×, distal 0.70×
            const curlMap = {
                index: [curlIdx * MAX_CURL, curlIdx * MAX_CURL * 0.85, curlIdx * MAX_CURL * 0.70],
                middle: [curlMid * MAX_CURL, curlMid * MAX_CURL * 0.85, curlMid * MAX_CURL * 0.70],
                ring: [curlRng * MAX_CURL, curlRng * MAX_CURL * 0.85, curlRng * MAX_CURL * 0.70],
                pinky: [curlPnk * MAX_CURL, curlPnk * MAX_CURL * 0.85, curlPnk * MAX_CURL * 0.70],
                thumb: [curlThumb * THUMB_MAX, curlThumb * THUMB_MAX * 0.80, curlThumb * THUMB_MAX * 0.65],
            };

            this._applyFingerMap(curlMap, 0.20);

        } else {
            // ── No tracking: drift back to idle rest pose ──────────────────
            this._setAllAngles(IDLE_CURL, THUMB_IDLE, 0.06);
            this.root.position.x = lerp(this.root.position.x, this._sign * SHOULDER_X, 0.06);
            this.root.position.y = lerp(this.root.position.y, SHOULDER_Y, 0.06);
            this.root.position.z = lerp(this.root.position.z, SHOULDER_Z, 0.06);
            this._emaX.reset();
            this._emaY.reset();
        }
    }

    /** World-space palm-centre position — used by HandPhysics every frame. */
    getGrabWorldPos(out = new THREE.Vector3()) {
        this.grabPoint.getWorldPosition(out);
        return out;
    }

    setVisible(v) {
        this.root.visible = v;
    }

    resetEMA() {
        this._emaX.reset();
        this._emaY.reset();
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
