import * as THREE from 'three';
import * as CANNON from 'cannon-es';

export class MechaController {
    constructor(scene, physicsWorld, camera, mechaMesh, muzzleFlash, createProjectile) {
        this.scene = scene;
        this.physicsWorld = physicsWorld;
        this.camera = camera;
        this.mesh = mechaMesh;
        this.muzzleFlash = muzzleFlash;
        this.createProjectile = createProjectile;

        // Physics Body for the mecha (Capsule-like approximated by a Sphere for robust trimesh collision)
        const radius = 0.5;
        this.body = new CANNON.Body({
            mass: 80, // kg
            shape: new CANNON.Sphere(radius),
            position: new CANNON.Vec3(0, 5, 2),
            fixedRotation: true // Prevent falling over
        });

        // Add physics body to world
        // Mecha is Group 4, only collides with Environment (Group 1)
        this.body.collisionFilterGroup = 4;
        this.body.collisionFilterMask = 1;
        this.physicsWorld.world.addBody(this.body);
        this.physicsWorld.dynamicBodies.push({ mesh: this.mesh, body: this.body });

        this.speed = 4.0;
        this.jumpForce = 7.0;
        this.canJump = true; // allow first jump once grounded

        this.aimTarget = new THREE.Vector3();

        // Collision listener for jumping — reset canJump when landing
        this.body.addEventListener("collide", (e) => {
            const contact = e.contact;
            // ni points from bj→bi; check both signs since role of bi/bj varies
            if (Math.abs(contact.ni.y) > 0.5) {
                this.canJump = true;
            }
        });

        this.lastShotTime = 0;
        this.shootCooldown = 200; // ms

        // Per-mode ammo pool and cooldown (rounds / cooldownMs)
        const MAX = { 1: 15, 2: 200, 3: 10, 4: 2 };
        const CD = { 1: 120000, 2: 40000, 3: 60000, 4: 180000 };
        this.ammo = {};
        [1, 2, 3, 4].forEach(m => {
            this.ammo[m] = { rounds: MAX[m], max: MAX[m], cooldownMs: CD[m], reloadEnd: 0, isReloading: false };
        });
    }

    update(inputManager, dt) {
        // Move Input Processing
        const moveDir = new THREE.Vector3();

        // Use camera's forward/right vectors for WASD movement
        const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
        forward.y = 0;
        forward.normalize();

        const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
        right.y = 0;
        right.normalize();

        if (inputManager.keys['w']) moveDir.add(forward);
        if (inputManager.keys['s']) moveDir.sub(forward);
        if (inputManager.keys['a']) moveDir.sub(right);
        if (inputManager.keys['d']) moveDir.add(right);

        if (moveDir.lengthSq() > 0) {
            moveDir.normalize();
            this.body.velocity.x = moveDir.x * this.speed;
            this.body.velocity.z = moveDir.z * this.speed;

            // Smoothly rotate mecha to face movement direction
            const angle = Math.atan2(moveDir.x, moveDir.z);
            const targetQuat = new CANNON.Quaternion();
            targetQuat.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), angle);
            this.body.quaternion.slerp(targetQuat, 0.15, this.body.quaternion);
        } else {
            // Apply friction manually if not moving
            this.body.velocity.x *= 0.8;
            this.body.velocity.z *= 0.8;
        }

        // Jump
        if (inputManager.keys[' '] && this.canJump) {
            this.body.velocity.y = 10;
            this.canJump = false;
        }

        // Aiming mode (right-click held): snap mecha to face camera forward (COD-style)
        if (inputManager.aimActive) {
            // Build a look direction from the camera's current forward in XZ plane
            const camForward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
            camForward.y = 0;
            if (camForward.lengthSq() > 0.001) {
                camForward.normalize();
                const angle = Math.atan2(camForward.x, camForward.z);
                const targetQuat = new CANNON.Quaternion();
                targetQuat.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), angle);
                // Rotate body to face aim direction
                this.body.quaternion.slerp(targetQuat, 0.2);
            }
        }

        // Always sync the precise raycasted crosshair coordinates for weapon firing
        if (inputManager.aimTarget) {
            this.aimTarget.copy(inputManager.aimTarget);
        }

        // Tick cooldowns — restore ammo when timer expires
        const now = performance.now();
        [1, 2, 3, 4].forEach(m => {
            const a = this.ammo[m];
            if (a.isReloading && now >= a.reloadEnd) {
                a.isReloading = false;
                a.rounds = a.max;
                window.dispatchEvent(new CustomEvent('ammoUpdate', {
                    detail: { mode: m, rounds: a.rounds, max: a.max, isReloading: false, cooldownMs: a.cooldownMs }
                }));
            }
        });

        // Shoot on left-click (always, not just when aiming)
        if (inputManager.isShooting) {
            this.shoot(inputManager.fireMode || 1);
        }
    }

    shoot(fireMode = 1) {
        const now = performance.now();
        // Per-shot fire rate limiter (still needed for rapid auto)
        const firerate = { 1: 250, 2: 80, 3: 350, 4: 800 };
        if (now - this.lastShotTime < (firerate[fireMode] ?? 250)) return;

        // Ammo check
        const a = this.ammo[fireMode];
        if (!a || a.isReloading || a.rounds <= 0) return;

        this.lastShotTime = now;
        a.rounds--;

        // Trigger cooldown when the last round is fired
        if (a.rounds === 0) {
            a.isReloading = true;
            a.reloadEnd = now + a.cooldownMs;
        }

        // Broadcast ammo state to HUD
        window.dispatchEvent(new CustomEvent('ammoUpdate', {
            detail: { mode: fireMode, rounds: a.rounds, max: a.max, isReloading: a.isReloading, cooldownMs: a.cooldownMs }
        }));

        // Gun barrel position (approximate, local to mecha).
        // Since we wrapped the mecha in an unscaled Group and raised it 2.35 units visually,
        // we adjust the Y spawn point up linearly to match the new visual barrels.
        const barrelLocalPos = new THREE.Vector3(0, 3.35, 2.0);
        const barrelPos = barrelLocalPos.applyMatrix4(this.mesh.matrixWorld);

        // Direction: camera forward projected onto XZ, includes Y pitch
        const camForward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion).normalize();
        const shootDir = (this.aimTarget && this.aimTarget.lengthSq() > 0.1)
            ? new THREE.Vector3().subVectors(this.aimTarget, barrelPos).normalize()
            : camForward;

        this.muzzleFlash.triggerMuzzleFlash(barrelPos, fireMode);
        this.createProjectile(barrelPos, shootDir, fireMode);
    }
}
