/**
 * hand_physics.js — Grab & throw physics for Mode 4 (Catch & Throw).
 *
 * Each HandPhysics instance tracks up to 2 hand rigs and lets each one:
 *   • GRAB the nearest physics body when a FIST is closed within grab radius
 *   • THROW that body when the hand opens, applying backend palm_velocity × multiplier
 *
 * Usage:
 *   const hp = new HandPhysics(physicsWorld, collidableMeshes);
 *   hp.update(leftHandData, rightHandData);
 *   hp.releaseAll();   // on mode exit
 */

import * as CANNON from 'cannon-es';

const GRAB_RADIUS = 0.35;   // world units — roughly palm width
const THROW_MULT = 18;     // amplify backend palm_velocity to produce fast throws
const MAX_SPEED = 30;     // m/s clamp to prevent physics explosion
const SPIN_SCALE = 0.3;    // angular velocity = spin_scale × throw_speed

export class HandPhysics {
    /**
     * @param {CANNON.World}          world
     * @param {Array<{mesh, body}>}   collidables  — same array scene.js maintains
     */
    constructor(world, collidables) {
        this._world = world;
        this._collidables = collidables;

        // State per hand slot: { body, offset }
        this._grabbed = [null, null];
    }

    /**
     * Call once per animation frame.
     * @param {object|null} leftData   — hand entry (gesture, landmarks, palm_velocity) or null
     * @param {object|null} rightData  — hand entry or null
     */
    update(leftData, rightData) {
        this._processHand(0, leftData);
        this._processHand(1, rightData);
    }

    _processHand(slot, handData) {
        if (!handData) { this._releaseSlot(slot); return; }

        const gesture = handData.gesture || 'none';
        const lms = handData.landmarks;
        const palmVel = handData.palm_velocity || [0, 0, 0];

        // Palm position = wrist landmark (index 0) already world-mapped by HandRig,
        // but we only have the raw normalised value here — scale the same way HandRig does.
        const SCALE = 4.0;
        if (!lms || lms.length < 1) { this._releaseSlot(slot); return; }
        const palm = new CANNON.Vec3(
            lms[0].x * SCALE,
            lms[0].y * -SCALE,
            lms[0].z * SCALE,
        );

        if (gesture === 'fist') {
            if (!this._grabbed[slot]) {
                // Try to grab the nearest unowned body within grab radius
                const target = this._nearestFreeBody(palm, slot);
                if (target) {
                    target.body.type = CANNON.Body.KINEMATIC;
                    target.body.velocity.set(0, 0, 0);
                    target.body.angularVelocity.set(0, 0, 0);
                    const offset = new CANNON.Vec3();
                    target.body.position.vsub(palm, offset);
                    this._grabbed[slot] = { body: target.body, offset };
                }
            } else {
                // Move held body with palm
                const { body, offset } = this._grabbed[slot];
                body.position.set(
                    palm.x + offset.x,
                    palm.y + offset.y,
                    palm.z + offset.z,
                );
                body.velocity.set(0, 0, 0);
            }
        } else if (this._grabbed[slot]) {
            // Hand opened — throw!
            this._throw(slot, palmVel);
        }
    }

    _throw(slot, palmVel) {
        const state = this._grabbed[slot];
        if (!state) return;
        const { body } = state;

        // Switch back to dynamic physics
        body.type = CANNON.Body.DYNAMIC;

        // Compute throw velocity and clamp
        let vx = palmVel[0] * THROW_MULT;
        let vy = palmVel[1] * THROW_MULT;
        let vz = palmVel[2] * THROW_MULT;
        const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
        if (speed > MAX_SPEED) {
            const s = MAX_SPEED / speed;
            vx *= s; vy *= s; vz *= s;
        }

        body.velocity.set(vx, vy, vz);

        // Add random tumble proportional to throw speed
        const actualSpeed = Math.min(speed, MAX_SPEED);
        const spinAmp = actualSpeed * SPIN_SCALE;
        body.angularVelocity.set(
            (Math.random() - 0.5) * 2 * spinAmp,
            (Math.random() - 0.5) * 2 * spinAmp,
            (Math.random() - 0.5) * 2 * spinAmp,
        );

        // Wake sleeping bodies
        body.wakeUp?.();

        this._grabbed[slot] = null;
    }

    _releaseSlot(slot) {
        if (this._grabbed[slot]) {
            this._throw(slot, [0, 0, 0]); // release with zero velocity (just drop)
        }
    }

    _nearestFreeBody(palm, requestingSlot) {
        const ownedBodies = this._grabbed
            .filter((g, i) => g && i !== requestingSlot)
            .map(g => g.body);

        let best = null, bestDist = GRAB_RADIUS;
        for (const c of this._collidables) {
            if (!c.body || ownedBodies.includes(c.body)) continue;
            const bp = c.body.position;
            const d = Math.sqrt(
                (bp.x - palm.x) ** 2 + (bp.y - palm.y) ** 2 + (bp.z - palm.z) ** 2
            );
            if (d < bestDist) { bestDist = d; best = c; }
        }
        return best;
    }

    /** Release everything — call when Mode 4 deactivates. */
    releaseAll() {
        this._grabbed.forEach((_, i) => this._releaseSlot(i));
    }
}
