/**
 * hand_rig.js  —  Smooth 3D Vertical Human Hands (Mode 4: Construct)
 *
 * Geometry:
 *   Wrist capsule → palm box → 4 finger chains (CapsuleGeometry, 3 segs each) + thumb (2 segs)
 *   Fingers are vertically oriented (pointing UP, like a hand held beside the mecha).
 *
 * Behaviour:
 *   • Hands are HIDDEN until webcam detects the player's hand (tracking activation).
 *   • Wrist X/Y landmark drives lateral/vertical sway.
 *   • Gesture drives smooth finger-curl animation via lerp.
 *   • Left hand is a mirror image of right (scale.x = -1 + DoubleSide material).
 */

import * as THREE from 'three';

// ─── Position & Scale ─────────────────────────────────────────────────────────
const HAND_SCALE = 3.0;    // global multiplier: 1 unit in design = 3 world units
const SHOULDER_X = 6.5;    // world units left/right of mecha centre
const SHOULDER_Y = 0.6;    // world units above mechaWrapper origin
const SHOULDER_Z = 1.6;    // forward from mecha (toward camera)
const SWAY_X = 2.0;    // max lateral sway from wrist-X landmark
const SWAY_Y = 1.5;    // max vertical sway from wrist-Y landmark

// ─── Hand Proportions (design units, multiplied by HAND_SCALE) ────────────────
const WRIST_R = 0.11;   // wrist capsule radius
const WRIST_H = 0.28;   // wrist capsule length

const PALM_W = 0.52;   // palm width
const PALM_H = 0.70;   // palm height (tall, vertical)
const PALM_D = 0.20;   // palm depth (thin front-to-back)

// Finger config: baseX = position along palm width (design units, centred on 0)
//               fan   = outward spread angle in radians (applied as rotation.z on first pivot)
//               r     = radius at proximal phalanx
//               lens  = [proximal, middle, distal] lengths
const FINGERS = [
    { name: 'index', baseX: -0.182, fan: 0.10, r: 0.088, lens: [0.50, 0.35, 0.22] },
    { name: 'middle', baseX: -0.061, fan: 0.03, r: 0.094, lens: [0.57, 0.40, 0.24] },
    { name: 'ring', baseX: 0.061, fan: -0.04, r: 0.083, lens: [0.50, 0.36, 0.22] },
    { name: 'pinky', baseX: 0.178, fan: -0.13, r: 0.067, lens: [0.37, 0.26, 0.16] },
];

// Thumb: 2 phalanges, sprouting from lateral palm edge at ~54° outward
const THUMB = { r: 0.100, lens: [0.38, 0.28] };
const THUMB_EDGE_X = PALM_W * 0.49;
const THUMB_UP_FRAC = 0.30;          // fraction up the palm height
const THUMB_ANGLE_Z = Math.PI * 0.30; // ≈54° outward from vertical

// ─── Curl Angles (rotation.x per segment, positive = curl toward palm front) ──
// Positive X rotation: fingertip pivots toward -Z (away from player camera) — fist
const CURL = {
    fist: {
        index: [1.57, 1.35, 1.10],
        middle: [1.63, 1.40, 1.15],
        ring: [1.57, 1.35, 1.10],
        pinky: [1.57, 1.35, 1.10],
        thumb: [1.05, 0.85],
    },
    open: {
        index: [0, 0, 0], middle: [0, 0, 0], ring: [0, 0, 0], pinky: [0, 0, 0],
        thumb: [0, 0],
    },
    none: {
        index: [0.18, 0.12, 0.07], middle: [0.18, 0.12, 0.07],
        ring: [0.18, 0.12, 0.07], pinky: [0.16, 0.10, 0.06],
        thumb: [0.12, 0.08],
    },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
class EMA {
    constructor(a = 0.15) { this.a = a; this.v = null; }
    update(x) { this.v = this.v === null ? x : this.a * x + (1 - this.a) * this.v; return this.v; }
    reset() { this.v = null; }
}

/** Solid smooth cyan material — no wireframe, DoubleSide for mirrored left hand. */
function mkMat() {
    return new THREE.MeshStandardMaterial({
        color: 0x00e8ff,
        emissive: 0x007090,
        emissiveIntensity: 0.85,
        metalness: 0.25,
        roughness: 0.40,
        side: THREE.DoubleSide,
    });
}

// ─── HandRig ──────────────────────────────────────────────────────────────────
export class HandRig {
    /**
     * @param {THREE.Scene}    scene
     * @param {THREE.Object3D} mechaWrapper  — unscaled mecha root group
     * @param {'left'|'right'} side
     */
    constructor(scene, mechaWrapper, side) {
        this._scene = scene;
        this._mecha = mechaWrapper;
        this._side = side;
        this._sign = side === 'right' ? 1 : -1;
        this._emaX = new EMA();
        this._emaY = new EMA();
        this._tracked = false;

        const S = HAND_SCALE;
        const mat = mkMat();

        // ── Root group: placed at shoulder ────────────────────────────────────
        this.root = new THREE.Group();
        this.root.position.set(this._sign * SHOULDER_X, SHOULDER_Y, SHOULDER_Z);
        // Slight inward tilt for natural look
        this.root.rotation.y = THREE.MathUtils.degToRad(this._sign * -18);
        // Mirror LEFT hand by flipping X
        if (side === 'left') this.root.scale.x = -1;
        this.root.visible = false;   // hidden until webcam detects hand
        mechaWrapper.add(this.root);

        // ── Wrist capsule ─────────────────────────────────────────────────────
        const wristGeo = new THREE.CapsuleGeometry(S * WRIST_R, S * WRIST_H, 5, 12);
        this._wrist = new THREE.Mesh(wristGeo, mat.clone());
        this._wrist.position.y = S * WRIST_H * 0.5;
        this.root.add(this._wrist);

        // ── Palm ──────────────────────────────────────────────────────────────
        // Box with no wireframe. Use many segments so normals look smooth under lighting.
        const palmGeo = new THREE.BoxGeometry(S * PALM_W, S * PALM_H, S * PALM_D, 2, 4, 2);
        this._palmMesh = new THREE.Mesh(palmGeo, mat.clone());
        this._palmBaseY = S * WRIST_H;
        this._palmMesh.position.y = this._palmBaseY + S * PALM_H * 0.5;
        this.root.add(this._palmMesh);

        // Knuckle ridge at top of palm (slight bump)
        const kGeo = new THREE.CapsuleGeometry(S * 0.045, S * PALM_W * 0.80, 3, 8);
        kGeo.applyMatrix4(new THREE.Matrix4().makeRotationZ(Math.PI / 2));
        const knuckle = new THREE.Mesh(kGeo, mat.clone());
        knuckle.position.set(0, this._palmBaseY + S * PALM_H - S * 0.01, -S * PALM_D * 0.15);
        this.root.add(knuckle);

        // ── Finger attachment root ────────────────────────────────────────────
        this._palmTop = new THREE.Object3D();
        this._palmTop.position.y = this._palmBaseY + S * PALM_H;
        this.root.add(this._palmTop);

        // ── Fingers ───────────────────────────────────────────────────────────
        this._chains = {};
        for (const cfg of FINGERS) {
            this._chains[cfg.name] = this._buildChain(S, mat, cfg.baseX, cfg.fan, cfg.r, cfg.lens, this._palmTop);
        }

        // ── Thumb ─────────────────────────────────────────────────────────────
        const thumbAnchor = new THREE.Object3D();
        thumbAnchor.position.set(
            S * THUMB_EDGE_X,
            this._palmBaseY + S * PALM_H * THUMB_UP_FRAC,
            0,
        );
        thumbAnchor.rotation.z = THUMB_ANGLE_Z;    // spread outward
        thumbAnchor.rotation.x = THREE.MathUtils.degToRad(-18);  // slight tilt forward
        this.root.add(thumbAnchor);
        this._chains.thumb = this._buildChain(S, mat, 0, 0, THUMB.r, THUMB.lens, thumbAnchor);

        // ── Grab point (palm centre, used by HandPhysics) ─────────────────────
        this.grabPoint = new THREE.Object3D();
        this.grabPoint.position.y = this._palmBaseY + S * PALM_H * 0.5;
        this.root.add(this.grabPoint);
    }

    /**
     * Build a finger bone chain. Each segment is a CapsuleGeometry capsule
     * oriented along +Y, tapered toward the tip.
     */
    _buildChain(S, mat, baseX, fanZ, baseR, lens, parentObj) {
        const chain = [];
        let parent = parentObj;

        for (let i = 0; i < lens.length; i++) {
            const len = S * lens[i];
            const radius = Math.max(S * baseR * (1 - i * 0.14), S * 0.028);
            const capLen = Math.max(len - radius * 2, 0.002);

            const pivot = new THREE.Object3D();
            if (i === 0) {
                pivot.position.set(S * baseX, 0, 0);
                pivot.rotation.z = fanZ;
            } else {
                pivot.position.y = chain[i - 1]._segLen;
            }

            // Capsule: centre at local origin, extends along Y
            const geo = new THREE.CapsuleGeometry(radius, capLen, 4, 10);
            const mesh = new THREE.Mesh(geo, mat.clone());
            mesh.position.y = len * 0.5;   // shift so base of capsule is at pivot origin
            pivot.add(mesh);

            pivot._segLen = len;
            chain.push(pivot);
            parent.add(pivot);
            parent = pivot;
        }
        return chain;
    }

    /**
     * Called every animation frame.
     * @param {object|null} handData  — WS hand entry, or null if not detected
     */
    update(handData) {
        // ── Activate / deactivate based on tracking presence ──────────────────
        if (!handData) {
            if (this._tracked) {
                this.root.visible = false;
                this._tracked = false;
                this._emaX.reset();
                this._emaY.reset();
            }
            return;
        }
        if (!this._tracked) {
            this.root.visible = true;
            this._tracked = true;
        }

        const gesture = handData.gesture || 'none';
        const lms = handData.landmarks;

        // ── Wrist-driven sway ─────────────────────────────────────────────────
        if (lms && lms.length > 0) {
            const rawX = (lms[0].x - 0.5) * 2;    // −1 .. +1
            const rawY = (lms[0].y - 0.5) * -2;   // −1 .. +1 (flip: up = positive)
            // Apply sign only to X sway so both hands sway outward/inward correctly
            const swX = this._emaX.update(rawX) * SWAY_X * this._sign;
            const swY = this._emaY.update(rawY) * SWAY_Y;
            this.root.position.set(
                this._sign * SHOULDER_X + swX,
                SHOULDER_Y + swY,
                SHOULDER_Z,
            );
        }

        // ── Finger curl animation ─────────────────────────────────────────────
        const curls = CURL[gesture] || CURL.none;
        for (const [name, chain] of Object.entries(this._chains)) {
            const angles = curls[name] ?? [];
            for (let i = 0; i < chain.length; i++) {
                const target = angles[i] ?? 0;
                chain[i].rotation.x += (target - chain[i].rotation.x) * 0.18;
            }
        }
    }

    /** World-space palm-centre position for HandPhysics proximity checks. */
    getGrabWorldPos(out = new THREE.Vector3()) {
        this.grabPoint.getWorldPosition(out);
        return out;
    }

    setVisible(v) {
        // Only allow hiding externally; showing is controlled by tracking
        if (!v) this.root.visible = false;
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
