/**
 * hand_rig.js  —  Mode 4: Mecha Physical Hands
 *
 * Renders one large cyan hand anchored to the mechaWrapper.
 * Hands are ALWAYS visible while active (no tracking gate).
 * When tracking data arrives, finger curl + wrist position animate in real-time.
 * When tracking data is absent, the hand holds an open idle pose.
 */

import * as THREE from 'three';

// ─── Scale & Position ─────────────────────────────────────────────────────────
const HAND_SCALE = 3.0;     // world-unit multiplier
const SHOULDER_X = 6.5;     // lateral offset from mecha centre
const SHOULDER_Y = 0.8;     // height above mechaWrapper origin
const SHOULDER_Z = 1.8;     // forward from mecha (toward camera)
const SWAY_X = 2.0;     // max lateral sway from wrist-X landmark
const SWAY_Y = 1.5;     // max vertical sway from wrist-Y landmark

// ─── Palm geometry (design units × HAND_SCALE) ───────────────────────────────
const WRIST_R = 0.12;   // wrist capsule radius
const WRIST_H = 0.30;   // wrist capsule length
const PALM_W = 0.52;   // width (knuckle-to-knuckle)
const PALM_H = 0.72;   // height (tall, fingers go up from here)
const PALM_D = 0.20;   // depth (thin front-to-back)

// ─── Finger config ────────────────────────────────────────────────────────────
// baseX = X offset relative to palm centre; fan = Z-rot spread; r = prox radius
const FINGERS = [
    { name: 'index', baseX: -0.182, fan: 0.10, r: 0.088, lens: [0.50, 0.35, 0.22] },
    { name: 'middle', baseX: -0.061, fan: 0.03, r: 0.094, lens: [0.57, 0.40, 0.24] },
    { name: 'ring', baseX: 0.061, fan: -0.04, r: 0.083, lens: [0.50, 0.36, 0.22] },
    { name: 'pinky', baseX: 0.178, fan: -0.13, r: 0.067, lens: [0.37, 0.26, 0.16] },
];

// Thumb: 2 phalanges from lateral palm edge at ~54° outward
const THUMB = { r: 0.100, lens: [0.38, 0.28] };
const THUMB_EDGE_X = PALM_W * 0.49;
const THUMB_UP_FRAC = 0.30;            // fraction up palm height
const THUMB_ANGLE_Z = Math.PI * 0.30;  // ≈54° outward from vertical

// ─── Gestures — rotation.x per segment  ──────────────────────────────────────
const CURL = {
    fist: {
        index: [1.50, 1.30, 1.05],
        middle: [1.56, 1.35, 1.10],
        ring: [1.50, 1.30, 1.05],
        pinky: [1.50, 1.30, 1.05],
        thumb: [1.00, 0.80],
    },
    open: {
        index: [0, 0, 0], middle: [0, 0, 0],
        ring: [0, 0, 0], pinky: [0, 0, 0],
        thumb: [0, 0],
    },
    none: {
        index: [0.15, 0.10, 0.06], middle: [0.15, 0.10, 0.06],
        ring: [0.15, 0.10, 0.06], pinky: [0.12, 0.08, 0.05],
        thumb: [0.10, 0.07],
    },
};

// ─── EMA smoother ─────────────────────────────────────────────────────────────
class EMA {
    constructor(a = 0.14) { this.a = a; this.v = null; }
    update(x) { this.v = this.v === null ? x : this.a * x + (1 - this.a) * this.v; return this.v; }
    reset() { this.v = null; }
}

// ─── Material ─────────────────────────────────────────────────────────────────
function mkMat() {
    return new THREE.MeshStandardMaterial({
        color: 0x00e8ff,
        emissive: 0x005566,
        emissiveIntensity: 0.90,
        metalness: 0.20,
        roughness: 0.45,
        side: THREE.DoubleSide,  // needed for scale.x=-1 on left hand
    });
}

// ─── HandRig ──────────────────────────────────────────────────────────────────
export class HandRig {
    /**
     * @param {THREE.Scene}    scene
     * @param {THREE.Object3D} mechaWrapper  — parent group (unscaled mecha root)
     * @param {'left'|'right'} side
     */
    constructor(scene, mechaWrapper, side) {
        this._scene = scene;
        this._mecha = mechaWrapper;
        this._side = side;
        this._sign = side === 'right' ? 1 : -1;
        this._emaX = new EMA();
        this._emaY = new EMA();
        this._active = false;

        const S = HAND_SCALE;
        const mat = mkMat();

        // ── Root: shoulder position ───────────────────────────────────────────
        this.root = new THREE.Group();
        this.root.position.set(this._sign * SHOULDER_X, SHOULDER_Y, SHOULDER_Z);
        this.root.rotation.y = THREE.MathUtils.degToRad(this._sign * -18);
        if (side === 'left') this.root.scale.x = -1;   // mirror for left hand
        this.root.visible = true;   // ALWAYS visible once created
        mechaWrapper.add(this.root);

        // ── Wrist ─────────────────────────────────────────────────────────────
        const wristGeo = new THREE.CapsuleGeometry(S * WRIST_R, S * WRIST_H, 5, 12);
        const wrist = new THREE.Mesh(wristGeo, mat.clone());
        wrist.position.y = S * WRIST_H * 0.5;
        this.root.add(wrist);

        // ── Palm ──────────────────────────────────────────────────────────────
        const palmBaseY = S * WRIST_H;
        const palmGeo = new THREE.BoxGeometry(S * PALM_W, S * PALM_H, S * PALM_D);
        const palm = new THREE.Mesh(palmGeo, mat.clone());
        palm.position.y = palmBaseY + S * PALM_H * 0.5;
        this.root.add(palm);

        // Knuckle ridge horizontal capsule
        const kGeo = new THREE.CapsuleGeometry(S * 0.04, S * PALM_W * 0.82, 3, 8);
        kGeo.applyMatrix4(new THREE.Matrix4().makeRotationZ(Math.PI / 2));
        const knuckle = new THREE.Mesh(kGeo, mat.clone());
        knuckle.position.set(0, palmBaseY + S * PALM_H, -S * PALM_D * 0.2);
        this.root.add(knuckle);

        // ── Finger attachment point ───────────────────────────────────────────
        this._palmTop = new THREE.Object3D();
        this._palmTop.position.y = palmBaseY + S * PALM_H;
        this.root.add(this._palmTop);

        // ── 4 Fingers ─────────────────────────────────────────────────────────
        this._chains = {};
        for (const cfg of FINGERS) {
            this._chains[cfg.name] = this._buildChain(
                S, mat, cfg.baseX, cfg.fan, cfg.r, cfg.lens, this._palmTop
            );
        }

        // ── Thumb ─────────────────────────────────────────────────────────────
        const thumbAnchor = new THREE.Object3D();
        thumbAnchor.position.set(
            S * THUMB_EDGE_X,
            palmBaseY + S * PALM_H * THUMB_UP_FRAC,
            0,
        );
        thumbAnchor.rotation.z = THUMB_ANGLE_Z;
        thumbAnchor.rotation.x = THREE.MathUtils.degToRad(-18);
        this.root.add(thumbAnchor);
        this._chains.thumb = this._buildChain(S, mat, 0, 0, THUMB.r, THUMB.lens, thumbAnchor);

        // ── Grab point (palm centre for physics) ──────────────────────────────
        this.grabPoint = new THREE.Object3D();
        this.grabPoint.position.y = palmBaseY + S * PALM_H * 0.5;
        this.root.add(this.grabPoint);

        // Start in idle pose
        this._applyCurls(CURL.none, 1.0);
    }

    // ── Internal: build a chain of capsule segments ───────────────────────────
    _buildChain(S, mat, baseX, fanZ, baseR, lens, parentObj) {
        const chain = [];
        let parent = parentObj;

        for (let i = 0; i < lens.length; i++) {
            const len = S * lens[i];
            const radius = Math.max(S * baseR * (1 - i * 0.13), S * 0.028);
            const capLen = Math.max(len - radius * 2, 0.002);

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

    // ── Internal: lerp all chains toward target curl angles ───────────────────
    _applyCurls(curlSet, speed) {
        for (const [name, chain] of Object.entries(this._chains)) {
            const angles = curlSet[name] ?? [];
            for (let i = 0; i < chain.length; i++) {
                const target = angles[i] ?? 0;
                chain[i].rotation.x += (target - chain[i].rotation.x) * speed;
            }
        }
    }

    // ─── Public API ───────────────────────────────────────────────────────────

    /**
     * Called every animation frame.
     * @param {object|null} handData  — telemetry hand entry or null
     */
    update(handData) {
        if (handData && handData.landmarks?.length > 0) {
            // Drive wrist position from landmark 0 (wrist)
            const lm0 = handData.landmarks[0];
            const rawX = (lm0.x - 0.5) * 2;    // −1 .. +1
            const rawY = (lm0.y - 0.5) * -2;   // −1 .. +1  (flip Y: up is positive)
            const swX = this._emaX.update(rawX) * SWAY_X * this._sign;
            const swY = this._emaY.update(rawY) * SWAY_Y;
            this.root.position.set(
                this._sign * SHOULDER_X + swX,
                SHOULDER_Y + swY,
                SHOULDER_Z,
            );

            // Drive finger curl
            const gesture = handData.gesture || 'none';
            const curls = CURL[gesture] ?? CURL.none;
            this._applyCurls(curls, 0.18);
        } else {
            // No tracking: gently return to idle open pose
            this._applyCurls(CURL.none, 0.06);
            // Drift back to shoulder rest position
            this.root.position.x += (this._sign * SHOULDER_X - this.root.position.x) * 0.05;
            this.root.position.y += (SHOULDER_Y - this.root.position.y) * 0.05;
            this.root.position.z += (SHOULDER_Z - this.root.position.z) * 0.05;
            this._emaX.reset();
            this._emaY.reset();
        }
    }

    /** World-space palm-centre position for HandPhysics proximity checks. */
    getGrabWorldPos(out = new THREE.Vector3()) {
        this.grabPoint.getWorldPosition(out);
        return out;
    }

    /** Show or hide the hand root group. */
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
