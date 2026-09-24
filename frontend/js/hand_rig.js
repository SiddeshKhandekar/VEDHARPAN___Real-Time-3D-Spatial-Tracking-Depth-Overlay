/**
 * hand_rig.js — Live 3D hand renderer for Mode 4 (Catch & Throw).
 *
 * Renders one hand as:
 *   • 21 joint spheres  — InstancedMesh (single draw call)
 *   • 20 bone segments  — LineSegments with BufferGeometry (in-place update)
 *   • Invisible grab sphere centred on the palm (landmark 0)
 *
 * Usage:
 *   const rig = new HandRig(scene);
 *   rig.update(handData);   // handData = hand entry from WS payload
 *   rig.setVisible(bool);
 *   rig.dispose();
 */

import * as THREE from 'three';

// MediaPipe 21-joint connection pairs (standard graph)
const CONNECTIONS = [
    [0, 1], [1, 2], [2, 3], [3, 4],
    [0, 5], [5, 6], [6, 7], [7, 8],
    [0, 9], [9, 10], [10, 11], [11, 12],
    [0, 13], [13, 14], [14, 15], [15, 16],
    [0, 17], [17, 18], [18, 19], [19, 20],
    [5, 9], [9, 13], [13, 17],
];
const N_JOINTS = 21;
const N_BONES = CONNECTIONS.length;

// EMA helper — one instance per axis per landmark (21 × 3 = 63 per hand)
class EMA {
    constructor(alpha = 0.25) { this.a = alpha; this.v = null; }
    update(x) { this.v = this.v === null ? x : this.a * x + (1 - this.a) * this.v; return this.v; }
    reset() { this.v = null; }
}

const COLORS = {
    fist: new THREE.Color(1.0, 0.45, 0.1),
    open: new THREE.Color(0.0, 0.95, 1.0),
    none: new THREE.Color(0.4, 0.4, 0.9),
};

export class HandRig {
    /**
     * @param {THREE.Scene} scene
     * @param {number}  worldScale  - multiplier mapping normalised [-1,1] coords to world units
     */
    constructor(scene, worldScale = 4.0) {
        this._scene = scene;
        this._scale = worldScale;

        // EMA filters: 21 landmarks × {x,y,z}
        this._ema = Array.from({ length: N_JOINTS }, () => ({
            x: new EMA(), y: new EMA(), z: new EMA(),
        }));

        // Joint spheres — InstancedMesh
        const jGeo = new THREE.SphereGeometry(0.045, 6, 6);
        const jMat = new THREE.MeshBasicMaterial({ color: COLORS.none });
        this._joints = new THREE.InstancedMesh(jGeo, jMat, N_JOINTS);
        this._joints.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        scene.add(this._joints);

        // Bone lines — LineSegments (2 vertices per connection)
        const bGeo = new THREE.BufferGeometry();
        const bPos = new Float32Array(N_BONES * 2 * 3); // 2 endpoints × xyz
        bGeo.setAttribute('position', new THREE.BufferAttribute(bPos, 3));
        bGeo.getAttribute('position').setUsage(THREE.DynamicDrawUsage);
        const bMat = new THREE.LineBasicMaterial({ color: 0x00d4ff, transparent: true, opacity: 0.7 });
        this._bones = new THREE.LineSegments(bGeo, bMat);
        this._bonePos = bPos;
        scene.add(this._bones);

        // Grab sphere (invisible, used by HandPhysics for proximity checks)
        this.grabSphere = new THREE.Mesh(
            new THREE.SphereGeometry(0.35, 6, 6),
            new THREE.MeshBasicMaterial({ visible: false }),
        );
        this.grabSphere.position.set(0, -100, 0); // off-screen until first update
        scene.add(this.grabSphere);

        this._dummy = new THREE.Object3D();
        this._positions = new Array(N_JOINTS).fill(null).map(() => new THREE.Vector3());
        this._visible = true;
        this._gesture = 'none';
    }

    /** Called every frame with the hand entry from the WS payload. */
    update(handData) {
        const lms = handData?.landmarks;
        if (!lms || lms.length < N_JOINTS) return;

        this._gesture = handData.gesture || 'none';
        const color = COLORS[this._gesture] || COLORS.none;

        // 1. EMA-smooth & store the 21 world positions
        for (let i = 0; i < N_JOINTS; i++) {
            const lm = lms[i];
            const sx = this._ema[i].x.update(lm.x) * this._scale;
            const sy = this._ema[i].y.update(lm.y) * -this._scale; // flip Y (image → world)
            const sz = this._ema[i].z.update(lm.z) * this._scale;
            this._positions[i].set(sx, sy, sz);
        }

        // 2. Update joint InstancedMesh
        this._joints.material.color.copy(color);
        for (let i = 0; i < N_JOINTS; i++) {
            this._dummy.position.copy(this._positions[i]);
            this._dummy.updateMatrix();
            this._joints.setMatrixAt(i, this._dummy.matrix);
        }
        this._joints.instanceMatrix.needsUpdate = true;

        // 3. Update bone positions in-place
        for (let b = 0; b < N_BONES; b++) {
            const [a, c] = CONNECTIONS[b];
            const pa = this._positions[a], pb = this._positions[c];
            const off = b * 6;
            this._bonePos[off] = pa.x; this._bonePos[off + 1] = pa.y; this._bonePos[off + 2] = pa.z;
            this._bonePos[off + 3] = pb.x; this._bonePos[off + 4] = pb.y; this._bonePos[off + 5] = pb.z;
        }
        this._bones.geometry.getAttribute('position').needsUpdate = true;

        // 4. Move grab sphere to wrist/palm centre (landmark 0)
        this.grabSphere.position.copy(this._positions[0]);
    }

    setVisible(v) {
        this._joints.visible = v;
        this._bones.visible = v;
        // grabSphere intentionally always invisible to renderer
        this._visible = v;
    }

    resetEMA() { this._ema.forEach(f => { f.x.reset(); f.y.reset(); f.z.reset(); }); }

    dispose() {
        [this._joints, this._bones, this.grabSphere].forEach(obj => {
            this._scene.remove(obj);
            obj.geometry?.dispose();
            obj.material?.dispose();
        });
    }
}
