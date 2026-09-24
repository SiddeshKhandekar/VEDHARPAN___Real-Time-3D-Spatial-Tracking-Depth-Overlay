/**
 * construct_mode.js — Mode 4: Hands-in-Game (Catch & Throw)
 *
 * Thin controller that:
 *   1. Creates / destroys HandRig (visual) and HandPhysics (grab/throw) instances.
 *   2. Routes telemetry frames from the WebSocket to both.
 *   3. Updates the gesture status HUD (#gesture-left / #gesture-right).
 *
 * All drawing, stroke, and force-meter code has been removed.
 */

import { HandRig } from './hand_rig.js';
import { HandPhysics } from './hand_physics.js';

// Gesture labels shown in the HUD strip
const GESTURE_LABELS = { fist: 'FIST ●', open: 'OPEN ○', none: '—' };
const GESTURE_COLORS = { fist: '#ff7233', open: '#00f2fe', none: '#8888bb' };

export class ConstructMode {
    /**
     * @param {THREE.Scene}         scene
     * @param {CANNON.World}        physicsWorld
     * @param {Array}               collidableMeshes  — [{mesh, body}]
     */
    constructor(scene, physicsWorld, collidableMeshes) {
        this._scene = scene;
        this._world = physicsWorld;
        this._collidables = collidableMeshes;

        this._leftRig = null;
        this._rightRig = null;
        this._physics = null;
        this._active = false;

        this._elLeft = document.getElementById('gesture-left');
        this._elRight = document.getElementById('gesture-right');
        this._elHud = document.getElementById('hand-gesture-hud');
    }

    activate() {
        if (this._active) return;
        this._active = true;

        this._leftRig = new HandRig(this._scene);
        this._rightRig = new HandRig(this._scene);
        this._physics = new HandPhysics(this._world, this._collidables);

        this._leftRig.setVisible(true);
        this._rightRig.setVisible(true);
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
        this._setLabel(this._elLeft, '—', 'none');
        this._setLabel(this._elRight, '—', 'none');
    }

    /**
     * Called every animation frame with the latest telemetry frame.
     * @param {object} frame  — { hands: [...], head: {...}, ... }
     */
    update(frame) {
        if (!this._active) return;
        const hands = frame?.hands ?? [];

        // Match hands to left/right by handedness field
        let leftData = null, rightData = null;
        for (const h of hands) {
            if (h.handedness === 'Left') leftData = h;
            else rightData = h;
        }

        this._leftRig?.update(leftData ?? null);
        this._rightRig?.update(rightData ?? null);
        this._physics?.update(leftData, rightData);

        // Update gesture HUD labels
        this._setLabel(this._elLeft, leftData?.gesture ?? 'none', leftData?.gesture ?? 'none');
        this._setLabel(this._elRight, rightData?.gesture ?? 'none', rightData?.gesture ?? 'none');
    }

    _setLabel(el, text, gesture) {
        if (!el) return;
        el.textContent = (el === this._elLeft ? 'LEFT: ' : 'RIGHT: ') + (GESTURE_LABELS[gesture] ?? '—');
        el.style.color = GESTURE_COLORS[gesture] ?? '#8888bb';
        el.style.textShadow = `0 0 8px ${GESTURE_COLORS[gesture] ?? '#8888bb'}`;
    }

    get isActive() { return this._active; }
}
