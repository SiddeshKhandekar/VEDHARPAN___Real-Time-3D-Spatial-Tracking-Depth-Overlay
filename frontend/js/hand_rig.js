/**
 * hand_rig.js  —  Mecha-Scale Human Hands (Mode 4: Construct)
 *
 * Renders two massive cyan glowing human hands flanking the mecha.
 * Each hand has: wrist stub → palm → 5 finger chains (thumb + 4 fingers, 3 segments each).
 *
 * Design goals:
 *   • Human proportions (anatomically correct fan angles, thumb offset)
 *   • Mecha-scale size (palm ~1.8 units tall, matching the robot's torso)
 *   • Cyan glowing aesthetic: semi-transparent solid fill + bright wireframe overlay
 *   • WebCam gesture drives finger curl animation
 *   • Wrist X/Y landmark sways the arm laterally/vertically
 */

import * as THREE from 'three';

// ─── Scale & Positioning ──────────────────────────────────────────────────────
// "As big as mecha" — mechaModel is scaled 0.6 and is ~6 units tall in local space,
// so its visual footprint in world units is roughly 3.6 units tall.
// Palm is made 1.8 units tall at the base to match.

const HAND_SCALE = 3.2;          // global scale multiplier applied to all geometry
const SHOULDER_X = 7.0;          // horizontal distance from mecha centre to hand root
const SHOULDER_Y = 1.0;          // height offset relative to mechaWrapper origin
const SHOULDER_Z = 1.5;          // forward offset (towards camera)
const ARM_REACH_Z = 2.2;         // how far forward the palm sits from the root
const SWAY_X = 2.0;              // max lateral sway driven by landmark wrist X
const SWAY_Y = 1.5;              // max vertical sway driven by landmark wrist Y

// ─── Hand Geometry Dimensions (in HAND_SCALE units) ──────────────────────────
const PALM_W = 0.58;   // wide palm
const PALM_H = 0.14;   // thin (flat hand)
const PALM_D = 0.72;   // depth front-to-back

// Finger dimensions [proximal, middle, distal] segment lengths
const FINGER_SEGS = {
    thumb: { w: 0.18, segs: [0.40, 0.32] },          // 2 segments
    index: { w: 0.15, segs: [0.52, 0.38, 0.24] },
    middle: { w: 0.16, segs: [0.58, 0.42, 0.26] },    // tallest
    ring: { w: 0.15, segs: [0.52, 0.38, 0.24] },
    pinky: { w: 0.12, segs: [0.38, 0.28, 0.18] },
};

// X offsets of finger bases on the palm (measured from palm centre, scaled)
// Thumb is handled separately on the lateral edge
const FINGER_BASE_X = {
    index: -0.195,
    middle: -0.065,
    ring: 0.065,
    pinky: 0.195,
};

// Outward fan angles (Y-axis rotation applied to finger root, degrees)
const FINGER_FAN_Y = {
    index: 8,
    middle: 1,
    ring: -5,
    pinky: -14,
};

// ─── Curl presets (X-rotation per segment, in radians) ───────────────────────
const CURL = {
    fist: {
        thumb: [Math.PI * 0.55, Math.PI * 0.45],
        index: [Math.PI * 0.50, Math.PI * 0.42, Math.PI * 0.35],
        middle: [Math.PI * 0.52, Math.PI * 0.44, Math.PI * 0.37],
        ring: [Math.PI * 0.50, Math.PI * 0.42, Math.PI * 0.35],
        pinky: [Math.PI * 0.50, Math.PI * 0.42, Math.PI * 0.35],
    },
    open: {
        thumb: [0, 0],
        index: [0, 0, 0],
        middle: [0, 0, 0],
        ring: [0, 0, 0],
        pinky: [0, 0, 0],
    },
    none: {
        thumb: [Math.PI * 0.12, Math.PI * 0.08],
        index: [Math.PI * 0.12, Math.PI * 0.08, Math.PI * 0.05],
        middle: [Math.PI * 0.14, Math.PI * 0.09, Math.PI * 0.05],
        ring: [Math.PI * 0.12, Math.PI * 0.08, Math.PI * 0.05],
        pinky: [Math.PI * 0.10, Math.PI * 0.07, Math.PI * 0.04],
    },
};

// ─── Materials ────────────────────────────────────────────────────────────────
// Clone per-hand so dispose is independent
function makeMaterials() {
    const solid = new THREE.MeshStandardMaterial({
        color: 0x00e5ff,
        emissive: 0x00aaff,
        emissiveIntensity: 1.2,
        transparent: true,
        opacity: 0.22,
        side: THREE.DoubleSide,
        depthWrite: false,
    });
    const wire = new THREE.MeshBasicMaterial({
        color: 0x00f2fe,
        wireframe: true,
        transparent: true,
        opacity: 0.95,
    });
    return { solid, wire };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
class EMA {
    constructor(a = 0.15) { this.a = a; this.v = null; }
    update(x) { this.v = this.v === null ? x : this.a * x + (1 - this.a) * this.v; return this.v; }
    reset() { this.v = null; }
}

/** Create a segment group with solid fill + wireframe overlay. */
function makeBox(w, h, d, mats) {
    const geo = new THREE.BoxGeometry(w, h, d);
    const group = new THREE.Group();
    group.add(new THREE.Mesh(geo, mats.solid.clone()));
    group.add(new THREE.Mesh(geo, mats.wire.clone()));
    return group;
}

// ─── HandRig ──────────────────────────────────────────────────────────────────
export class HandRig {
    /**
     * @param {THREE.Scene}    scene
     * @param {THREE.Object3D} mechaWrapper  — unscaled mecha root
     * @param {'left'|'right'} side
     */
    constructor(scene, mechaWrapper, side) {
        this._scene = scene;
        this._mecha = mechaWrapper;
        this._side = side;
        this._sign = side === 'left' ? -1 : 1;
        this._mats = makeMaterials();
        this._emaX = new EMA();
        this._emaY = new EMA();

        const S = HAND_SCALE;

        // ── Hand root pivot (attached to mechaWrapper) ────────────────────────
        this.root = new THREE.Group();
        this.root.position.set(
            this._sign * SHOULDER_X,
            SHOULDER_Y,
            SHOULDER_Z,
        );
        // Mirror left hand horizontally so thumb is on correct side
        if (side === 'left') this.root.scale.x = -1;
        mechaWrapper.add(this.root);

        // ── Wrist cylinder (thin stub connecting to arm) ──────────────────────
        const wristGeo = new THREE.CylinderGeometry(
            PALM_W * S * 0.35, PALM_W * S * 0.38, S * 0.30, 8
        );
        wristGeo.rotateX(Math.PI / 2);
        const wristGrp = new THREE.Group();
        wristGrp.position.set(0, 0, ARM_REACH_Z - S * 0.15);
        wristGrp.add(new THREE.Mesh(wristGeo, this._mats.solid.clone()));
        wristGrp.add(new THREE.Mesh(wristGeo, this._mats.wire.clone()));
        this.root.add(wristGrp);

        // ── Palm block ────────────────────────────────────────────────────────
        this._palmPivot = new THREE.Object3D();
        this._palmPivot.position.set(0, 0, ARM_REACH_Z + S * PALM_D * 0.5);
        this.root.add(this._palmPivot);

        const palmGrp = makeBox(S * PALM_W, S * PALM_H, S * PALM_D, this._mats);
        this._palmPivot.add(palmGrp);

        // Knuckle row — flat bar at front top edge of palm
        const knuckleGrp = makeBox(S * PALM_W * 0.92, S * 0.06, S * 0.05, this._mats);
        knuckleGrp.position.set(0, S * (PALM_H * 0.5 + 0.03), -S * PALM_D * 0.5 + S * 0.025);
        this._palmPivot.add(knuckleGrp);

        // ── Finger chains ─────────────────────────────────────────────────────
        this._fingerPivots = {};   // { fingerName: [pivot0, pivot1, pivot2] }

        // --- 4 normal fingers ---
        for (const [name, segs] of Object.entries(FINGER_SEGS)) {
            if (name === 'thumb') continue;
            const chain = [];
            const baseX = S * FINGER_BASE_X[name];
            const baseZ = -S * PALM_D * 0.5; // front edge of palm

            let parent = this._palmPivot;
            let localZ = baseZ;  // starting Z in parent's space

            for (let si = 0; si < segs.segs.length; si++) {
                const len = S * segs.segs[si];
                const w = S * segs.w;

                const pivot = new THREE.Object3D();
                if (si === 0) {
                    pivot.position.set(baseX, 0, localZ);
                    // Fan angle on Y (outward spread)
                    pivot.rotation.y = THREE.MathUtils.degToRad(FINGER_FAN_Y[name]);
                } else {
                    pivot.position.set(0, 0, -chain[si - 1]._segLen);
                }

                const segGrp = makeBox(w, w, len, this._mats);
                segGrp.position.set(0, 0, -len * 0.5);  // geometry extends forward (−Z)
                pivot.add(segGrp);

                // End-cap joint ball
                const jointGeo = new THREE.SphereGeometry(w * 0.55, 6, 6);
                const jointGrp = new THREE.Group();
                jointGrp.position.set(0, 0, -len);
                jointGrp.add(new THREE.Mesh(jointGeo, this._mats.solid.clone()));
                jointGrp.add(new THREE.Mesh(jointGeo, this._mats.wire.clone()));
                pivot.add(jointGrp);

                pivot._segLen = len;
                chain.push(pivot);
                parent.add(pivot);
                parent = pivot;
            }
            this._fingerPivots[name] = chain;
        }

        // --- Thumb (2 segments, on lateral edge, angled outward) ---
        {
            const thumbData = FINGER_SEGS.thumb;
            const chain = [];

            // Thumb root: on the lateral edge of palm, angled out ~55° on Y and ~30° down on Z
            const thumbRoot = new THREE.Object3D();
            thumbRoot.position.set(
                S * (PALM_W * 0.5 + 0.04),   // lateral edge
                0,
                S * PALM_D * 0.15,            // slightly back from front edge
            );
            thumbRoot.rotation.y = THREE.MathUtils.degToRad(-55);
            thumbRoot.rotation.z = THREE.MathUtils.degToRad(-25);
            this._palmPivot.add(thumbRoot);

            let parent = thumbRoot;
            for (let si = 0; si < thumbData.segs.length; si++) {
                const len = S * thumbData.segs[si];
                const w = S * thumbData.w;

                const pivot = new THREE.Object3D();
                if (si > 0) pivot.position.set(0, 0, -chain[si - 1]._segLen);

                const segGrp = makeBox(w, w, len, this._mats);
                segGrp.position.set(0, 0, -len * 0.5);
                pivot.add(segGrp);

                // Joint ball
                const jGeo = new THREE.SphereGeometry(w * 0.55, 6, 6);
                const jGrp = new THREE.Group();
                jGrp.position.set(0, 0, -len);
                jGrp.add(new THREE.Mesh(jGeo, this._mats.solid.clone()));
                jGrp.add(new THREE.Mesh(jGeo, this._mats.wire.clone()));
                pivot.add(jGrp);

                pivot._segLen = len;
                chain.push(pivot);
                parent.add(pivot);
                parent = pivot;
            }
            this._fingerPivots.thumb = chain;
        }

        // ── Grab point (palm tip, used by HandPhysics) ────────────────────────
        this.grabPoint = new THREE.Object3D();
        this.grabPoint.position.set(0, 0, -S * PALM_D * 0.5);
        this._palmPivot.add(this.grabPoint);

        this._gesture = 'none';
        this.root.visible = true;
    }

    /**
     * Call every frame with the hand entry from the WS payload (or null if lost).
     * @param {object|null} handData
     */
    update(handData) {
        if (!handData) return;

        const gesture = handData.gesture || 'none';
        const lms = handData.landmarks;

        // ── Wrist lateral/vertical sway ───────────────────────────────────────
        if (lms && lms.length > 0) {
            const rawX = (lms[0].x - 0.5) * 2;   // −1..+1
            const rawY = (lms[0].y - 0.5) * -2;   // −1..+1 (flip y, up = positive)

            const swX = this._emaX.update(rawX) * SWAY_X * this._sign;
            const swY = this._emaY.update(rawY) * SWAY_Y;

            this.root.position.set(
                this._sign * SHOULDER_X + swX,
                SHOULDER_Y + swY,
                SHOULDER_Z,
            );
        }

        // ── Finger curl animation (lerp toward target per gesture) ────────────
        const curls = CURL[gesture] || CURL.none;
        this._gesture = gesture;

        for (const [name, chain] of Object.entries(this._fingerPivots)) {
            const targetAngles = curls[name] || [];
            for (let si = 0; si < chain.length; si++) {
                const target = targetAngles[si] ?? 0;
                chain[si].rotation.x += (target - chain[si].rotation.x) * 0.18;
            }
        }
    }

    /** Get palm tip world position (for HandPhysics grab checks). */
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
                if (Array.isArray(obj.material)) obj.material.forEach(m => m.dispose());
                else obj.material.dispose();
            }
        });
    }
}
