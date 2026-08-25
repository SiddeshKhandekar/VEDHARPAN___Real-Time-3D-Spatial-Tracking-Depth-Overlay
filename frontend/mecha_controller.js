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

        // ── Defensive Shield Feature ──────────────────────────────────────────
        this.shieldEnergyMax = 120.0;
        this.shieldEnergy = this.shieldEnergyMax;
        this.shieldActiveBase = false;
        this.shieldPreviouslyPressed = false;

        // Build 3D visuals for the shield
        this.shieldGroup = new THREE.Group();
        this.shieldGroup.visible = false;
        this.mesh.add(this.shieldGroup); // Parent to mechaWrapper so it rotates with mecha automatically

        // 1. Oval Shield Mesh (layered glass + glowing wireframe)
        // Cut the sphere exactly in half (phi: 0 to PI) so it forms a frontal curved shield instead of a closed egg
        // Base radius 1.0, scaled below to fit the mecha profile.
        const shieldGeo = new THREE.SphereGeometry(1.0, 20, 10, 0, Math.PI);
        const glassMat = new THREE.MeshPhysicalMaterial({
            color: 0x00f2fe, emissive: 0x00f2fe, emissiveIntensity: 0.15,
            transparent: true, opacity: 0.3, transmission: 0.7, roughness: 0.1, depthWrite: false
        });
        const wireMat = new THREE.MeshBasicMaterial({
            color: 0x4facfe, wireframe: true, transparent: true, opacity: 0.45, depthWrite: false, blending: THREE.AdditiveBlending
        });
        this.shieldGlass = new THREE.Mesh(shieldGeo, glassMat);
        this.shieldWire = new THREE.Mesh(shieldGeo, wireMat);
        // Mecha physics box is 2.4 wide by 3.6 tall. We'll clip the shield just slightly wider than that.
        this.shieldGlass.scale.set(1.3, 2.0, 0.4);
        this.shieldWire.scale.set(1.35, 2.05, 0.45); // Slightly larger

        // Since the hemisphere (phi=0 to PI) points forward (+Z), we position it in front
        // so the flat back rim sits towards the mecha and the curve bows outward.
        this.shieldGlass.position.set(0, 2.5, 1.5);
        this.shieldWire.position.set(0, 2.5, 1.5);
        this.shieldGroup.add(this.shieldGlass);
        this.shieldGroup.add(this.shieldWire);

        // 2. Projector Beam (from stomach to shield center)
        // Stomach offset: (0, 2.0, 0). Shield center: (0, 2.5, 1.5)
        const diff = new THREE.Vector3(0, 2.5, 1.5).sub(new THREE.Vector3(0, 2.0, 0));
        const dist = diff.length();
        const beamGeo = new THREE.CylinderGeometry(0.2, 0.05, dist, 12, 1, true); // wider at shield, narrow at stomach
        const beamMat = new THREE.MeshBasicMaterial({
            color: 0x00f2fe, transparent: true, opacity: 0.3, depthWrite: false, blending: THREE.AdditiveBlending
        });
        const beamMesh = new THREE.Mesh(beamGeo, beamMat);
        beamMesh.position.copy(new THREE.Vector3(0, 2.0, 0).lerp(new THREE.Vector3(0, 2.5, 1.5), 0.5));

        // Orient beam along the vector
        const axis = new THREE.Vector3(0, 1, 0);
        beamMesh.quaternion.setFromUnitVectors(axis, diff.clone().normalize());
        this.shieldGroup.add(beamMesh);

        // 3. Shield Physics Body
        // Placed in collision group 4 (Shields) tracking the mask for Projectiles mapping
        this.shieldPhysics = new CANNON.Body({
            mass: 0, // static relative to mecha body (but we will strictly update its position)
            shape: new CANNON.Box(new CANNON.Vec3(3.0, 4.0, 0.3)),
            isTrigger: false
        });
        this.shieldPhysics.collisionFilterGroup = 4;
        this.shieldPhysics.collisionFilterMask = 2 | 1; // Block projectiles(2) and environment(1)
        // We do not add the shield directly to the rigid physics world as a free body, 
        // because it's kinematic and strictly tethered to the front of the mecha.
        // Instead, we will sync its coordinate transform manually when Active.
        this.physicsWorld.world.addBody(this.shieldPhysics);
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

        // ── Shield Logic Processing ───────────────────────────────────────────
        const isQ = inputManager.keys['q'] || inputManager.actions?.['toggleShield'];
        const isE = inputManager.keys['e'] || inputManager.actions?.['holdShield'];

        // Edge-trigger Q to toggle on/off
        if (isQ && !this.shieldPreviouslyPressed) {
            if (this.shieldActiveBase) {
                this.shieldActiveBase = false;
            } else {
                // Minimum energy requirement (30 units = 1 min passive regen worth)
                if (this.shieldEnergy >= 30.0) {
                    this.shieldActiveBase = true;
                    document.getElementById('shield-meter-container')?.classList.remove('hidden');
                }
            }
        }
        this.shieldPreviouslyPressed = isQ;

        // Calculate Effective State (Drops if E is held, regardless of base state)
        const shieldEffectivelyOn = this.shieldActiveBase && !isE;

        if (shieldEffectivelyOn) {
            this.shieldEnergy -= dt; // Cost 1.0 energy per second
            if (this.shieldEnergy <= 0) {
                this.shieldEnergy = 0;
                this.shieldActiveBase = false; // Auto force off on depletion
            }
        } else {
            // Regen logic
            if (isE && this.shieldActiveBase) {
                // Suspended via E-hold penalizes regen rate heavily (0.25 sec/sec)
                this.shieldEnergy += dt * 0.25;
            } else {
                // Standard passive regen restores in exactly 4 minutes (4*60 = 240s to restore 120 unit capacity) -> 0.5 sec/sec
                this.shieldEnergy += dt * 0.5;
            }
            if (this.shieldEnergy > this.shieldEnergyMax) {
                this.shieldEnergy = this.shieldEnergyMax;
                if (!this.shieldActiveBase) {
                    document.getElementById('shield-meter-container')?.classList.add('hidden'); // auto-hide when full and off
                }
            } else {
                document.getElementById('shield-meter-container')?.classList.remove('hidden');
            }
        }

        // Sync visual & physical state
        this.shieldGroup.visible = shieldEffectivelyOn;
        this.isShieldDeployed = shieldEffectivelyOn; // Save for shoot check

        const meterContainer = document.getElementById('shield-meter-container');
        if (shieldEffectivelyOn) {
            // Place Physics body exactly corresponding to the Mesh World space
            const worldPos = new THREE.Vector3(0, 2.5, 1.5).applyMatrix4(this.mesh.matrixWorld);
            this.shieldPhysics.position.copy(worldPos);
            this.shieldPhysics.quaternion.copy(this.mesh.quaternion);
            // Re-bind to grid
            if (this.shieldPhysics.collisionFilterGroup === 0) {
                this.shieldPhysics.collisionFilterGroup = 4;
            }
        } else {
            // Toss physical component far so it doesn't block shots when transparent
            this.shieldPhysics.position.set(0, -9999, 0);
            this.shieldPhysics.collisionFilterGroup = 0;
        }

        // Bind DOM UI progress tracking
        const fillBar = document.getElementById('shield-meter-fill');
        if (fillBar) {
            const percent = (this.shieldEnergy / this.shieldEnergyMax) * 100;
            fillBar.style.width = `${percent}%`;

            // Add pulse warning if it's dropping extremely low
            if (this.shieldEnergy < 15.0) {
                fillBar.style.background = `linear-gradient(90deg, #ff2a2a 0%, #ff7878 100%)`;
            } else {
                fillBar.style.background = `linear-gradient(90deg, #00f2fe 0%, #4facfe 100%)`;
            }
        }
    } // <-- closing brace for update()

    shoot(fireMode = 1) {
        if (this.isShieldDeployed) {
            // Player attempted to fire while shield is blocking them inside. Show warning!
            const meterContainer = document.getElementById('shield-meter-container');
            if (meterContainer && !meterContainer.classList.contains('shield-warning')) {
                meterContainer.classList.add('shield-warning');
                setTimeout(() => {
                    meterContainer?.classList.remove('shield-warning');
                }, 2000);
            }
            return;
        }

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
