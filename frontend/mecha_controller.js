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
        this.physicsWorld.world.addBody(this.body);
        this.physicsWorld.dynamicBodies.push({ mesh: this.mesh, body: this.body });

        this.speed = 4.0;
        this.jumpForce = 7.0;
        this.canJump = false;

        this.aimTarget = new THREE.Vector3();

        // Collision listener for jumping
        this.body.addEventListener("collide", (e) => {
            const contact = e.contact;
            if (contact.ni.y > 0.5) {
                this.canJump = true;
            }
        });

        this.lastShotTime = 0;
        this.shootCooldown = 200; // ms
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

        // Aiming: face the aim target when right-click is held
        if (inputManager.aimActive && inputManager.aimTarget) {
            this.aimTarget.copy(inputManager.aimTarget);
            const lookAtVec = new THREE.Vector3().copy(this.aimTarget);
            lookAtVec.y = this.mesh.position.y;
            const m = new THREE.Matrix4();
            m.lookAt(this.mesh.position, lookAtVec, new THREE.Vector3(0, 1, 0));
            const targetQuat = new THREE.Quaternion().setFromRotationMatrix(m);
            this.body.quaternion.slerp(new CANNON.Quaternion(targetQuat.x, targetQuat.y, targetQuat.z, targetQuat.w), 0.1);
        }

        // Shoot on left-click (always, not just when aiming)
        if (inputManager.isShooting) {
            this.shoot();
        }

        shoot() {
            const now = performance.now();
            if (now - this.lastShotTime < this.shootCooldown) return;
            this.lastShotTime = now;

            // Gun barrel position (approximate, local to mecha)
            const barrelLocalPos = new THREE.Vector3(0, 1.2, 0.5);
            const barrelPos = barrelLocalPos.applyMatrix4(this.mesh.matrixWorld);

            const shootDir = new THREE.Vector3().subVectors(this.aimTarget, barrelPos).normalize();

            this.muzzleFlash.trigger(barrelPos);
            this.createProjectile(barrelPos, shootDir);
        }
    }
