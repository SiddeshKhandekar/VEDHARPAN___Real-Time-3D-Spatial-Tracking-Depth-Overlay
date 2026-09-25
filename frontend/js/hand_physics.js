/**
 * hand_physics.js  —  Mecha Physical Hands grab/throw/punch (Mode 4)
 *
 * Works alongside HandRig. Each hand has:
 *   • A kinematic CANNON.Sphere that follows the HandRig grab point every frame,
 *     acting as a punch/push collider.
 *   • Grab logic: on FIST gesture, snap nearest free DYNAMIC body to palm.
 *   • Throw logic: on FIST→OPEN, apply camera-aim direction × THROW_SPEED.
 */

import * as CANNON from 'cannon-es';
import * as THREE from 'three';

const GRAB_RADIUS = 1.2;    // world units — arm reach
const THROW_SPEED = 28;     // m/s — fast throw along aim direction
const THROW_RISE = 0.25;   // upward bias added to throw vector
const SPIN_SCALE = 0.35;   // angular velocity scale relative to throw speed
const PUNCH_IMPULSE = 14;     // N applied to objects overlapping the palm sphere
const PALM_BODY_R = 0.30;   // kinematic punch body radius

export class HandPhysics {
    /**
     * @param {CANNON.World}   world
     * @param {Array}          dynamicBodies  — physicsWorld.dynamicBodies [{mesh,body}]
     * @param {THREE.Camera}   camera
     */
    constructor(world, dynamicBodies, camera) {
        this._world = world;
        this._bodies = dynamicBodies;
        this._camera = camera;

        // Per-slot state: { cannonBody, grabbed: {body,offset}|null }
        this._slots = [null, null];
        this._rigs = [null, null];   // set by ConstructMode after HandRig creation

        // Create kinematic punch sphere for each hand
        this._palmBodies = [null, null];
        for (let i = 0; i < 2; i++) {
            const body = new CANNON.Body({
                mass: 0,
                type: CANNON.Body.KINEMATIC,
                shape: new CANNON.Sphere(PALM_BODY_R),
                position: new CANNON.Vec3(0, -999, 0), // off-world until first update
                collisionFilterGroup: 2,
                collisionFilterMask: 1,
            });
            world.addBody(body);
            this._palmBodies[i] = body;
        }
    }

    /**
     * Attach HandRig references so we can read grab-point world positions.
     * Called by ConstructMode after both rigs are created.
     */
    attachRigs(leftRig, rightRig) {
        this._rigs[0] = leftRig;
        this._rigs[1] = rightRig;
    }

    /**
     * Call every animation frame.
     * @param {object|null} leftData   — telemetry hand entry or null
     * @param {object|null} rightData  — telemetry hand entry or null
     */
    update(leftData, rightData) {
        this._processSlot(0, leftData);
        this._processSlot(1, rightData);
    }

    _processSlot(slot, handData) {
        const rig = this._rigs[slot];
        if (!rig || !handData) {
            // Hand lost — release anything held
            if (this._slots[slot]) this._release(slot, null);
            if (this._palmBodies[slot]) {
                this._palmBodies[slot].position.set(0, -999, 0);
            }
            return;
        }

        const gesture = handData.gesture || 'none';
        const grabPt = rig.getGrabWorldPos();    // THREE.Vector3

        // Move kinematic punch body to palm position every frame
        const pb = this._palmBodies[slot];
        if (pb) {
            pb.position.set(grabPt.x, grabPt.y, grabPt.z);
            pb.velocity.set(0, 0, 0);

            // Punch: check overlapping dynamic bodies and apply impulse
            this._applyPunchImpulse(slot, grabPt);
        }

        if (gesture === 'fist') {
            if (!this._slots[slot]) {
                // Try to grab the nearest free body
                const target = this._nearestFree(grabPt, slot);
                if (target) {
                    target.body.type = CANNON.Body.KINEMATIC;
                    target.body.velocity.set(0, 0, 0);
                    target.body.angularVelocity.set(0, 0, 0);
                    const off = new CANNON.Vec3(
                        target.body.position.x - grabPt.x,
                        target.body.position.y - grabPt.y,
                        target.body.position.z - grabPt.z,
                    );
                    this._slots[slot] = { body: target.body, offset: off };
                }
            } else {
                // Carry the held body with the palm
                const { body, offset } = this._slots[slot];
                body.position.set(
                    grabPt.x + offset.x,
                    grabPt.y + offset.y,
                    grabPt.z + offset.z,
                );
                body.velocity.set(0, 0, 0);
            }
        } else if (this._slots[slot]) {
            // Hand opened — throw along camera aim
            this._release(slot, this._buildAimVelocity());
        }
    }

    _buildAimVelocity() {
        const dir = new THREE.Vector3();
        this._camera.getWorldDirection(dir);
        dir.y += THROW_RISE;
        dir.normalize();
        return new CANNON.Vec3(
            dir.x * THROW_SPEED,
            dir.y * THROW_SPEED,
            dir.z * THROW_SPEED,
        );
    }

    _release(slot, vel) {
        const state = this._slots[slot];
        if (!state) return;
        const { body } = state;

        body.type = CANNON.Body.DYNAMIC;
        body.wakeUp?.();

        if (vel) {
            body.velocity.copy(vel);
            const speed = THROW_SPEED;
            body.angularVelocity.set(
                (Math.random() - 0.5) * 2 * speed * SPIN_SCALE,
                (Math.random() - 0.5) * 2 * speed * SPIN_SCALE,
                (Math.random() - 0.5) * 2 * speed * SPIN_SCALE,
            );
        } else {
            // Drop with zero velocity
            body.velocity.set(0, 0, 0);
        }

        this._slots[slot] = null;
    }

    _applyPunchImpulse(slot, grabPt) {
        // Only push bodies NOT currently grabbed by either slot
        const ownedBodies = this._slots.filter(Boolean).map(s => s.body);

        for (const { body } of this._bodies) {
            if (!body || ownedBodies.includes(body)) continue;
            if (body.type !== CANNON.Body.DYNAMIC) continue;

            const bp = body.position;
            const dx = bp.x - grabPt.x;
            const dy = bp.y - grabPt.y;
            const dz = bp.z - grabPt.z;
            const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

            if (dist < PALM_BODY_R * 1.8 && dist > 0.001) {
                const scale = PUNCH_IMPULSE / dist;
                body.applyImpulse(
                    new CANNON.Vec3(dx * scale, dy * scale, dz * scale),
                    new CANNON.Vec3(0, 0, 0),
                );
            }
        }
    }

    _nearestFree(grabPt, requestingSlot) {
        const ownedBodies = this._slots
            .filter((s, i) => s && i !== requestingSlot)
            .map(s => s.body);

        let best = null, bestDist = GRAB_RADIUS;
        for (const c of this._bodies) {
            if (!c.body || ownedBodies.includes(c.body)) continue;
            if (c.body.type !== CANNON.Body.DYNAMIC) continue;

            const p = c.body.position;
            const d = Math.sqrt(
                (p.x - grabPt.x) ** 2 +
                (p.y - grabPt.y) ** 2 +
                (p.z - grabPt.z) ** 2,
            );
            if (d < bestDist) { bestDist = d; best = c; }
        }
        return best;
    }

    /** Release all held objects — call on mode exit. */
    releaseAll() {
        for (let i = 0; i < 2; i++) this._release(i, null);

        // Remove palm bodies from world
        this._palmBodies.forEach(b => {
            if (b) {
                this._world.removeBody(b);
            }
        });
        this._palmBodies = [null, null];
    }
}
