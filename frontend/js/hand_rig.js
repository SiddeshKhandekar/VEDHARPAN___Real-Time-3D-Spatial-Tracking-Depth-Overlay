/**
 * hand_rig.js  —  Mecha Physical Hands (Mode 4)
 *
 * Creates two full 3D mecha arms anchored to the mechaWrapper.
 * Each arm = shoulder pivot → forearm tube → palm block → 4 finger chains (3 segments each).
 *
 * Gesture input drives finger curl animation.
 * Wrist X/Y landmark data swings the arm laterally/vertically within reach bounds.
 * No landmark-to-world-space mapping — all positions are relative to mechaWrapper.
 */

import * as THREE from 'three';

// ─── Constants ────────────────────────────────────────────────────────────────

// Side 'left' = -1, 'right' = +1
const SHOULDER_OFFSET = { x: 1.8, y: 0.6, z: 0.2 };  // from mechaWrapper origin
const ARM_REACH_Z = 1.5;   // how far forward the idle arm extends (Z toward camera)
const SWAY_X = 1.2;   // max lateral sway driven by landmark X
const SWAY_Y = 0.8;   // max vertical sway driven by landmark Y

// Geometry sizes
const ARM_TUBE_RADIUS = 0.09;
const ARM_TUBE_LENGTH = 0.9;
const PALM_W = 0.30, PALM_H = 0.12, PALM_D = 0.36;
const FINGER_W = 0.055, FINGER_H = 0.055, FINGER_L = 0.20;
const KNUCKLE_GAP = 0.09;   // lateral gap between finger bases

// Curl angles (radians) per segment per gesture
const CURL = {
    fist: [Math.PI * 0.45, Math.PI * 0.40, Math.PI * 0.35],
    open: [0, 0, 0],
    none: [Math.PI * 0.15, Math.PI * 0.10, Math.PI * 0.05],
};

// Visual style
const MAT_ARM = new THREE.MeshStandardMaterial({ color: 0x1a2a3a, metalness: 0.9, roughness: 0.3, emissive: 0x001020, emissiveIntensity: 0.4 });
const MAT_TRIM = new THREE.MeshStandardMaterial({ color: 0x00e5ff, metalness: 0.6, roughness: 0.2, emissive: 0x00a0c0, emissiveIntensity: 0.8 });

// Simple EMA filter
class EMA {
    constructor(a = 0.18) { this.a = a; this.v = null; }
    update(x) { this.v = this.v === null ? x : this.a * x + (1 - this.a) * this.v; return this.v; }
    reset() { this.v = null; }
}

// ─── HandRig ──────────────────────────────────────────────────────────────────

export class HandRig {
    /**
     * @param {THREE.Scene}    scene
     * @param {THREE.Object3D} mechaWrapper   — the unscaled mecha root from scene.js
     * @param {'left'|'right'} side
     */
    constructor(scene, mechaWrapper, side) {
        this._scene = scene;
        this._mecha = mechaWrapper;
        this._side = side;
        this._sign = side === 'left' ? -1 : 1;
        this._gesture = 'none';

        // EMA for wrist sway
        this._emaX = new EMA();
        this._emaY = new EMA();

        // ── Shoulder pivot (all geometry hangs from here) ──────────────────────
        this.root = new THREE.Object3D();
        this.root.position.set(
            this._sign * SHOULDER_OFFSET.x,
            SHOULDER_OFFSET.y,
            SHOULDER_OFFSET.z,
        );
        mechaWrapper.add(this.root);

        // ── Forearm tube ───────────────────────────────────────────────────────
        const armGeo = new THREE.CylinderGeometry(ARM_TUBE_RADIUS, ARM_TUBE_RADIUS * 1.2, ARM_TUBE_LENGTH, 8);
        armGeo.rotateX(Math.PI / 2);
        this._armMesh = new THREE.Mesh(armGeo, MAT_ARM.clone());
        this._armMesh.position.set(0, 0, ARM_REACH_Z - ARM_TUBE_LENGTH * 0.5);
        this.root.add(this._armMesh);

        // Cyan wristband trim ring
        const ringGeo = new THREE.TorusGeometry(ARM_TUBE_RADIUS * 1.4, 0.018, 6, 16);
        const ring = new THREE.Mesh(ringGeo, MAT_TRIM.clone());
        ring.rotation.x = Math.PI / 2;
        ring.position.set(0, 0, ARM_REACH_Z - ARM_TUBE_LENGTH + 0.05);
        this.root.add(ring);

        // ── Palm block ─────────────────────────────────────────────────────────
        this._palmPivot = new THREE.Object3D();
        this._palmPivot.position.set(0, 0, ARM_REACH_Z);
        this.root.add(this._palmPivot);

        const palmGeo = new THREE.BoxGeometry(PALM_W, PALM_H, PALM_D);
        this._palmMesh = new THREE.Mesh(palmGeo, MAT_ARM.clone());
        this._palmPivot.add(this._palmMesh);

        // Knuckle trim strip along front of palm
        const knuckleGeo = new THREE.BoxGeometry(PALM_W * 0.9, 0.025, 0.04);
        const knuckleTrim = new THREE.Mesh(knuckleGeo, MAT_TRIM.clone());
        knuckleTrim.position.set(0, PALM_H * 0.5, -PALM_D * 0.5 + 0.02);
        this._palmPivot.add(knuckleTrim);

        // ── Finger chains (4 fingers, 3 segments each) ────────────────────────
        this._fingers = [];
        const fingerXOffsets = [-0.105, -0.035, 0.035, 0.105];

        for (let f = 0; f < 4; f++) {
            const chain = [];
            let parent = this._palmPivot;
            let zBase = -PALM_D * 0.5;   // start at front edge of palm

            for (let s = 0; s < 3; s++) {
                const pivot = new THREE.Object3D();
                pivot.position.set(f === 0 ? fingerXOffsets[f] : 0, 0, s === 0 ? zBase : -FINGER_L);
                parent.add(pivot);

                const geo = new THREE.BoxGeometry(FINGER_W, FINGER_H, FINGER_L);
                const mesh = new THREE.Mesh(geo, s === 0 ? MAT_ARM.clone() : MAT_ARM.clone());
                mesh.position.set(0, 0, -FINGER_L * 0.5);
                pivot.add(mesh);

                // Cyan joint dot at segment root
                const dotGeo = new THREE.BoxGeometry(FINGER_W * 1.1, FINGER_H * 1.1, 0.025);
                const dot = new THREE.Mesh(dotGeo, MAT_TRIM.clone());
                pivot.add(dot);

                chain.push(pivot);
                parent = pivot;
            }

            // Position each finger correctly at f=0 and from finger root for others
            this._fingers.push(chain);
        }

        // Reposition each finger base X on the palm
        for (let f = 0; f < 4; f++) {
            this._fingers[f][0].position.x = fingerXOffsets[f];
        }

        // ── Public grab sphere position (align with palm centre) ──────────────
        // Used by HandPhysics without being rendered
        this.grabPoint = new THREE.Object3D();
        this._palmPivot.add(this.grabPoint);
        this.grabPoint.position.set(0, 0, -PALM_D * 0.4);

        this._visible = true;
        this._curGesture = 'none';
    }

    /**
     * Call every frame with the hand entry from the WS payload (or null).
     * @param {object|null} handData  — { gesture, landmarks, palm_velocity }
     */
    update(handData) {
        if (!handData) return;

        const gesture = handData.gesture || 'none';
        const lms = handData.landmarks;

        // ── Wrist-driven arm sway ─────────────────────────────────────────────
        if (lms && lms.length > 0) {
            // MediaPipe wrist: x=[0,1] centre=0.5, y=[0,1] centre=0.5
            const rawX = (lms[0].x - 0.5) * 2;   // -1..+1, mirrored
            const rawY = (lms[0].y - 0.5) * -2;  // -1..+1, up = positive

            const swX = this._emaX.update(rawX) * SWAY_X * this._sign;
            const swY = this._emaY.update(rawY) * SWAY_Y;

            this.root.position.set(
                this._sign * SHOULDER_OFFSET.x + swX,
                SHOULDER_OFFSET.y + swY,
                SHOULDER_OFFSET.z,
            );
        }

        // ── Finger curl animation ─────────────────────────────────────────────
        if (gesture !== this._curGesture) {
            this._curGesture = gesture;
        }
        const targetCurls = CURL[gesture] || CURL.none;

        for (let f = 0; f < 4; f++) {
            for (let s = 0; s < 3; s++) {
                const pivot = this._fingers[f][s];
                // Lerp toward target curl angle (smooth animation)
                pivot.rotation.x += (targetCurls[s] - pivot.rotation.x) * 0.2;
            }
        }
    }

    /**
     * Get the world-space position of the grab point (palm tip).
     * Used by HandPhysics.
     */
    getGrabWorldPos(out = new THREE.Vector3()) {
        this.grabPoint.getWorldPosition(out);
        return out;
    }

    setVisible(v) {
        this.root.visible = v;
        this._visible = v;
    }

    resetEMA() {
        this._emaX.reset();
        this._emaY.reset();
    }

    dispose() {
        this._mecha.remove(this.root);
        this.root.traverse(obj => {
            if (obj.geometry) obj.geometry.dispose();
            if (obj.material) obj.material.dispose();
        });
    }
}
