/**
 * construct_mode.js — Mode 4: Mecha Physical Hands (Catch, Throw, Punch)
 *
 * Thin controller that:
 *   1. Creates/destroys a HandRig (visual) per side, anchored to mechaWrapper.
 *   2. Creates/destroys HandPhysics for grab/throw/punch logic.
 *   3. Routes telemetry frames (gesture + landmark data) to both rigs.
 *   4. Updates the gesture status HUD strip.
 *
 * No projectile fire(), no drawing, no stroke buffer.
 */

import { HandRig } from './hand_rig.js';
import { HandPhysics } from './hand_physics.js';

const GESTURE_LABELS = { fist: 'FIST ●', open: 'OPEN ○', none: '—' };
const GESTURE_COLORS = { fist: '#ff7233', open: '#00f2fe', none: '#8888bb' };

export class ConstructMode {
    /**
     * @param {THREE.Scene}    scene
     * @param {CANNON.World}   physicsWorld       — raw CANNON.World
     * @param {Array}          dynamicBodies      — physicsWorld.dynamicBodies [{mesh,body}]
     * @param {THREE.Camera}   camera             — for throw aim direction
     * @param {THREE.Object3D} mechaWrapper       — anchor for hand rigs
     */
    constructor(scene, physicsWorld, dynamicBodies, camera, mechaWrapper = null) {
        this._scene = scene;
        this._world = physicsWorld;
        this._bodies = dynamicBodies;
        this._camera = camera;
        this._mecha = mechaWrapper;  // may be null until GLTF loads

        this._leftRig = null;
        this._rightRig = null;
        this._physics = null;
        this._active = false;

        this._elLeft = document.getElementById('gesture-left');
        this._elRight = document.getElementById('gesture-right');
        this._elHud = document.getElementById('hand-gesture-hud');
    }

    /** Inject mechaWrapper after GLTF assets load (lazy because GLTF loads after init). */
    setMechaWrapper(wrapper) {
        this._mecha = wrapper;
    }

    activate() {
        if (this._active) return;
        if (!this._mecha) {
            console.warn('[ConstructMode] mechaWrapper not set — cannot activate hands');
            return;
        }
        this._active = true;

        // Create rigs anchored to mechaWrapper
        this._leftRig = new HandRig(this._scene, this._mecha, 'left');
        this._rightRig = new HandRig(this._scene, this._mecha, 'right');

        this._leftRig.setVisible(true);
        this._rightRig.setVisible(true);

        // Create physics layer, attach rigs so it can read grab-point positions
        this._physics = new HandPhysics(this._world, this._bodies, this._camera);
        this._physics.attachRigs(this._leftRig, this._rightRig);

        this._elHud?.classList.remove('hidden');
    }

    deactivate() {
        if (!this._active) return;
        this._active = false;

        this._physics?.releaseAll();
        this._leftRig?.dispose();
        this._rightRig?.dispose();

        this._leftRig = null;
        this._rightRig = null;
        this._physics = null;

        this._elHud?.classList.add('hidden');
        this._setLabel(this._elLeft, 'none');
        this._setLabel(this._elRight, 'none');
    }

    /**
     * Called every animation frame with the latest telemetry frame.
     * @param {object} frame  — { hands: [...], head: {...} }
     */
    update(frame) {
        if (!this._active) return;
        const hands = frame?.hands ?? [];

        // Split by handedness
        let leftData = null, rightData = null;
        for (const h of hands) {
            if (h.handedness === 'Left') leftData = h;
            else rightData = h;
        }

        this._leftRig?.update(leftData);
        this._rightRig?.update(rightData);
        this._physics?.update(leftData, rightData);

        // HUD
        this._setLabel(this._elLeft, leftData?.gesture ?? 'none');
        this._setLabel(this._elRight, rightData?.gesture ?? 'none');
    }

    _setLabel(el, gesture) {
        if (!el) return;
        const prefix = el === this._elLeft ? 'LEFT: ' : 'RIGHT: ';
        el.textContent = prefix + (GESTURE_LABELS[gesture] ?? '—');
        el.style.color = GESTURE_COLORS[gesture] ?? '#8888bb';
        el.style.textShadow = `0 0 8px ${GESTURE_COLORS[gesture] ?? '#8888bb'}`;
    }

    get isActive() { return this._active; }
}
