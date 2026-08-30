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

        this.c_cyan = new THREE.Color(0x00f2fe);
        this.c_yellow = new THREE.Color(0xffff00);
        this.c_orange = new THREE.Color(0xff8800);
        this.c_red = new THREE.Color(0xff2a2a);

        this.activeShieldColor = new THREE.Color(0x00f2fe);
        this.shieldBlinkPhase = 0;

        // Build 3D visuals for the shield
        this.shieldGroup = new THREE.Group();
        this.shieldGroup.visible = false;
        this.mesh.add(this.shieldGroup); // Parent to mechaWrapper so it rotates with mecha automatically

        // 1. Oval Shield Mesh (layered glass + glowing wireframe)
        // Using a squished Icosahedron generates a beautiful repeating triangular geodesic lattice (classic sci-fi shield grid)
        // instead of basic horizontal/vertical modeling loops. It forms a thin 'contact lens' shape when z-scaled!
        const shieldGeoHigh = new THREE.IcosahedronGeometry(1.0, 3);
        const shieldGeoLow = new THREE.IcosahedronGeometry(1.0, 0); // 0 subdivision = sparse, chunky distinct sci-fi lines perfect for distance

        this.glassMat = new THREE.MeshPhysicalMaterial({
            color: 0x00f2fe, emissive: 0x00f2fe, emissiveIntensity: 0.15,
            transparent: true, opacity: 0.15, roughness: 0.1, depthWrite: false, side: THREE.DoubleSide, fog: false
        });
        this.wireMat = new THREE.MeshBasicMaterial({
            color: 0x4facfe, wireframe: true, transparent: true, opacity: 0.25, depthWrite: false, blending: THREE.NormalBlending, side: THREE.DoubleSide, fog: false
        });

        this.shieldGlass = new THREE.Mesh(shieldGeoHigh, this.glassMat);

        // We clone wireMat to allow independent opacity fading during crossfade
        this.wireMatHigh = this.wireMat.clone();
        this.wireMatLow = this.wireMat.clone();

        this.wireHigh = new THREE.Mesh(shieldGeoHigh, this.wireMatHigh);
        this.wireLow = new THREE.Mesh(shieldGeoLow, this.wireMatLow);

        // Expand vertically and slightly horizontally to cover the legs and entire body
        this.shieldGlass.scale.set(1.5, 2.7, 0.4);
        this.wireHigh.scale.set(1.51, 2.71, 0.41);
        this.wireLow.scale.set(1.51, 2.71, 0.41);

        // Lower the shield mesh to properly cover legs 
        this.shieldGlass.position.set(0, 2.0, 1.8);
        this.wireHigh.position.set(0, 2.0, 1.8);
        this.wireLow.position.set(0, 2.0, 1.8);

        this.shieldGroup.add(this.shieldGlass);
        this.shieldGroup.add(this.wireHigh);
        this.shieldGroup.add(this.wireLow);



        // 2. Projector Beam (from stomach to shield center)
        // Stomach offset: (0, 2.0, 0). Shield center: (0, 2.0, 1.8)
        const diff = new THREE.Vector3(0, 2.0, 1.8).sub(new THREE.Vector3(0, 2.0, 0));
        const dist = diff.length();
        const beamGeo = new THREE.CylinderGeometry(0.2, 0.05, dist, 12, 1, true); // wider at shield, narrow at stomach
        const beamMat = new THREE.MeshBasicMaterial({
            color: 0x00f2fe, transparent: true, opacity: 0.3, depthWrite: false, blending: THREE.NormalBlending
        });
        const beamMesh = new THREE.Mesh(beamGeo, beamMat);
        beamMesh.position.copy(new THREE.Vector3(0, 2.0, 0).lerp(new THREE.Vector3(0, 2.0, 1.8), 0.5));

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

        // ── Flight Mode System ────────────────────────────────────────────────
        this.flightActive = false;

        // Boost energy: max 5 seconds
        this.boostEnergyMax = 5.0;
        this.boostEnergy = this.boostEnergyMax;
        this.boostRegenRate = this.boostEnergyMax / 30.0; // 30 sec full regen
        this.isBoostDepleted = false; // locked-out when fully empty
        this.flightYaw = 0; // tracked independently for smooth numpad turning

        // ── Iron Man Attitude / Altitude Indicator Ring ───────────────────────
        this.altitudeRing = new THREE.Group();
        this.altitudeRing.visible = false;

        // Outer horizon torus
        const ringMat = new THREE.MeshBasicMaterial({
            color: 0x00f2fe, transparent: true, opacity: 0.15, depthWrite: false, fog: false
        });
        const horizonTorus = new THREE.Mesh(
            new THREE.TorusGeometry(3.2, 0.025, 8, 72),
            ringMat.clone()
        );
        this.altitudeRing.add(horizonTorus);

        // Inner tighter ring
        const innerTorus = new THREE.Mesh(
            new THREE.TorusGeometry(2.0, 0.015, 6, 48),
            new THREE.MeshBasicMaterial({ color: 0x00f2fe, transparent: true, opacity: 0.10, depthWrite: false, fog: false })
        );
        this.altitudeRing.add(innerTorus);

        // Tick marks every 10 degrees around the outer ring
        const tickMat = new THREE.MeshBasicMaterial({ color: 0x00f2fe, transparent: true, opacity: 0.22, depthWrite: false, fog: false });
        this.boostTickMat = new THREE.MeshBasicMaterial({ color: 0x00f2fe, transparent: true, opacity: 0.4, depthWrite: false, fog: false });

        for (let i = 0; i < 36; i++) {
            const angle = (i / 36) * Math.PI * 2;
            const isMajor = i % 9 === 0;
            const tickLen = isMajor ? 0.35 : 0.18;

            // The 7 ticks perfectly centered at the front (Z > 0), 3 on each side
            const isFrontBoostTick = (i <= 3 || i >= 33);

            const tick = new THREE.Mesh(
                new THREE.BoxGeometry(0.03, tickLen, 0.03),
                isFrontBoostTick ? this.boostTickMat : tickMat
            );
            tick.position.set(Math.sin(angle) * 3.2, 0, Math.cos(angle) * 3.2);
            tick.lookAt(0, 0, 0);
            this.altitudeRing.add(tick);
        }

        // Pitch ladder: 4 arcs above and below equator
        const pitchArcMat = new THREE.MeshBasicMaterial({ color: 0x00f2fe, transparent: true, opacity: 0.12, depthWrite: false, fog: false });
        for (let j = 1; j <= 4; j++) {
            const pitchAngle = (j / 5) * (Math.PI / 2); // 0 to 90 deg
            for (const sign of [1, -1]) {
                const arc = new THREE.Mesh(
                    new THREE.TorusGeometry(3.2 * Math.cos(pitchAngle), 0.012, 4, 32, Math.PI * 0.6),
                    pitchArcMat
                );
                arc.position.y = sign * 3.2 * Math.sin(pitchAngle);
                arc.rotation.y = Math.PI / 2;
                this.altitudeRing.add(arc);
            }
        }

        // Vertical velocity needle (points up/down based on vy)
        const needleMat = new THREE.MeshBasicMaterial({ color: 0x00ffff, transparent: true, opacity: 0.35, depthWrite: false, fog: false });
        this.altNeedle = new THREE.Mesh(new THREE.BoxGeometry(0.04, 1.2, 0.04), needleMat);
        this.altNeedle.position.set(0, 0, 3.2);
        this.altitudeRing.add(this.altNeedle);

        this.altitudeRing.position.set(0, 2.5, 0); // centered on mecha torso
        this.mesh.add(this.altitudeRing);

        // ── Boost Bracket Meters (left and right curved cyan arcs) ────────────
        this.boostBrackets = new THREE.Group();
        this.boostBrackets.visible = false;

        const bracketMat = new THREE.MeshBasicMaterial({
            color: 0x00f2fe, transparent: true, opacity: 0.8, depthWrite: false, fog: false
        });
        const bracketBgMat = new THREE.MeshBasicMaterial({
            color: 0x003344, transparent: true, opacity: 0.4, depthWrite: false, fog: false
        });

        // Build a pair of bracket arcs (left = negative X, right = positive X)
        // Each arc is oriented via rotation.y = Math.PI/2 so the torus sweeps in the YZ-plane
        // and appears as a vertical ( ) parenthesis shape when seen from the camera.
        const BRACKET_X = 6.0;          // units from mecha centre-line
        const BRACKET_Y = 2.5;          // torso height offset
        const TORUS_R = 2.2;          // arc circle radius
        const TORUS_TUBE = 0.07;         // tube thickness
        const ARC_ANGLE = Math.PI * 0.75; // 135° arc — the open gap faces outward

        for (const side of [-1, 1]) {
            // rotZ: rotate the arc so the gap faces outward (away from mecha).
            // Left bracket: gap faces left  → rotZ = -Math.PI * 0.125
            // Right bracket: gap faces right → rotZ =  Math.PI * 0.875 (= PI + PI*-0.125 flipped)
            const rotZ = side === -1 ? -Math.PI * 0.125 : Math.PI * 0.875;

            // Background track arc
            const bgArc = new THREE.Mesh(
                new THREE.TorusGeometry(TORUS_R, TORUS_TUBE, 4, 32, ARC_ANGLE),
                bracketBgMat.clone()
            );
            bgArc.position.set(side * BRACKET_X, BRACKET_Y, 0);
            bgArc.rotation.set(0, Math.PI / 2, rotZ); // y-rotation makes arc face camera
            this.boostBrackets.add(bgArc);

            // Fill torus
            const fillArc = new THREE.Mesh(
                new THREE.TorusGeometry(TORUS_R, TORUS_TUBE + 0.01, 4, 32, ARC_ANGLE),
                bracketMat.clone()
            );
            fillArc.position.set(side * BRACKET_X, BRACKET_Y, 0);
            fillArc.rotation.set(0, Math.PI / 2, rotZ);
            fillArc.userData.isFill = true;
            fillArc.userData.side = side;
            this.boostBrackets.add(fillArc);
        }

        this.boostBrackets.position.set(0, 0, 0);
        this.mesh.add(this.boostBrackets);
    }

    update(inputManager, dt, cameraMode = 1) {
        if (this.shieldWireLOD) this.shieldWireLOD.update(this.camera);
        // ── Flight Mode: override gravity and apply 3D movement ───────────────
        if (this.flightActive) {
            this._updateFlight(inputManager, dt, cameraMode);
        } else {
            // ── Ground Movement ───────────────────────────────────────────────
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
                } else {
                    const meterContainer = document.getElementById('shield-meter-container');
                    if (meterContainer && !meterContainer.classList.contains('shield-warning')) {
                        meterContainer.classList.add('shield-warning');
                        setTimeout(() => meterContainer.classList.remove('shield-warning'), 2000);
                    }
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
            }
        }

        // Sync visual & physical state
        this.shieldGroup.visible = shieldEffectivelyOn;
        this.isShieldDeployed = shieldEffectivelyOn; // Save for shoot check

        // --- Real-time Visual Shield Degradation ---
        if (shieldEffectivelyOn) {
            let currentOpacity = 0.25;

            // Segmented Heat-Map Color Gradient (Cyan -> Yellow -> Orange -> Red)
            if (this.shieldEnergy >= 15.0) {
                this.activeShieldColor.copy(this.c_cyan);
                this.shieldBlinkPhase = 0;
            } else if (this.shieldEnergy <= 4.0) {
                this.activeShieldColor.copy(this.c_red);

                // Final 3 seconds blinking logic (3.0 and below)
                if (this.shieldEnergy <= 3.0) {
                    const blinkFreq = 4.0 + (3.0 - this.shieldEnergy) * 12.0;
                    this.shieldBlinkPhase += dt * blinkFreq;
                    const blinkScale = (Math.sin(this.shieldBlinkPhase) + 1.0) / 2.0;
                    currentOpacity = 0.05 + blinkScale * 0.35; // aggressive pulse between 5% and 40%
                } else {
                    this.shieldBlinkPhase = 0;
                }
            } else {
                this.shieldBlinkPhase = 0;
                // Factor goes 0.0 -> 1.0 as energy drops from 15.0 to 4.0
                const factor = 1.0 - ((this.shieldEnergy - 4.0) / 11.0);
                if (factor < 0.33) {
                    this.activeShieldColor.lerpColors(this.c_cyan, this.c_yellow, factor / 0.33);
                } else if (factor < 0.66) {
                    this.activeShieldColor.lerpColors(this.c_yellow, this.c_orange, (factor - 0.33) / 0.33);
                } else {
                    this.activeShieldColor.lerpColors(this.c_orange, this.c_red, (factor - 0.66) / 0.34);
                }
            }

            // Smoothly crossfade LOD opacities based on distance between 70 and 110 units
            const dist = this.mesh.position.distanceTo(this.camera.position);
            const fadeStart = 70.0;
            const fadeEnd = 110.0;

            let highAlpha = 1.0;
            let lowAlpha = 0.0;

            if (dist > fadeStart) {
                if (dist > fadeEnd) {
                    highAlpha = 0.0;
                    lowAlpha = 1.0;
                } else {
                    lowAlpha = (dist - fadeStart) / (fadeEnd - fadeStart);
                    highAlpha = 1.0 - lowAlpha;
                }
            }

            // Sync other materials 
            this.glassMat.color.copy(this.activeShieldColor);
            this.glassMat.emissive.copy(this.activeShieldColor);

            this.wireMatHigh.color.copy(this.activeShieldColor);
            this.wireMatLow.color.copy(this.activeShieldColor);

            this.glassMat.opacity = currentOpacity;
            this.wireMatHigh.opacity = currentOpacity * highAlpha;
            this.wireMatLow.opacity = currentOpacity * lowAlpha;
        } else {
            this.shieldBlinkPhase = 0; // reset for next deployment
        }

        const meterContainer = document.getElementById('shield-meter-container');
        if (shieldEffectivelyOn) {
            // Place Physics body exactly corresponding to the Mesh World space
            const worldPos = new THREE.Vector3(0, 2.0, 1.8).applyMatrix4(this.mesh.matrixWorld);
            this.shieldPhysics.position.copy(worldPos);
            this.shieldPhysics.quaternion.copy(this.mesh.quaternion);
            // Re-bind to grid
            if (this.shieldPhysics.collisionFilterGroup === 0) {
                this.shieldPhysics.collisionFilterGroup = 4;
                this.shieldPhysics.collisionFilterMask = 2 | 1;
            }
        } else {
            // Disable tracking dynamically but DO NOT teleport position (Destroys SAP Broadphase Arrays natively causing severe physics lag)
            this.shieldPhysics.collisionFilterGroup = 0;
            this.shieldPhysics.collisionFilterMask = 0;
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



        // Toggle threshold dot
        const thresholdEl = document.getElementById('shield-meter-threshold');
        if (thresholdEl) {
            if (this.shieldEnergy >= 30.0) {
                thresholdEl.style.display = 'none';
            } else {
                thresholdEl.style.display = 'block';
            }
        }

        // -- Engine plume visuals (always running to process shutdown transitions) --
        this._updatePlumes(inputManager, dt, cameraMode);
    } // <-- closing brace for update()

    /**
     * Flight Mode physics tick. Called each frame when flightActive === true.
     * WASD (3D camera-relative), Numpad8/2 (altitude), Numpad4/6 (yaw),
     * Left Shift (speed boost in exact camera forward direction).
     */
    _updateFlight(inputManager, dt, cameraMode = 1) {
        const FLIGHT_SPEED = 12.0;    // normal cruise units/sec
        const BOOST_SPEED = 55.0;    // full boost units/sec
        const VERTICAL_SPEED = 8.0;     // numpad up/down units/sec
        const YAW_SPEED = 1.8;     // rad/sec for numpad yaw
        // Frame-rate independent damping: equivalent to 0.88 per-frame at 60 FPS
        const dampFactor = Math.pow(0.88, dt * 60);
        // Velocity lerp strength: high = responsive, approaches instant at ~10 units/sec
        const velLerp = Math.min(1.0, dt * 10);

        // -- Kill gravity: apply inverse gravitational force every tick ---------
        const grav = this.physicsWorld.world.gravity;
        this.body.applyForce(
            new CANNON.Vec3(-grav.x * this.body.mass, -grav.y * this.body.mass, -grav.z * this.body.mass),
            new CANNON.Vec3(0, 0, 0)
        );

        // -- Numpad4/6 yaw: rotate both mecha body AND camera orbit ---------
        let yawLeft = false;
        let yawRight = false;
        let isBoostKey = false;
        let canBoost = false;
        const moveVel = new THREE.Vector3();

        if (cameraMode !== 0) {
            yawLeft = !!(inputManager.actions?.['flightTurnLeft']);
            yawRight = !!(inputManager.actions?.['flightTurnRight']);

            if (yawLeft || yawRight) {
                const delta = (yawLeft ? 1 : -1) * YAW_SPEED * dt;
                const yawDeltaQuat = new CANNON.Quaternion();
                yawDeltaQuat.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), delta);
                this.body.quaternion = this.body.quaternion.mult(yawDeltaQuat);
                // Tell scene.js to rotate orbitYaw so the camera follows
                window.dispatchEvent(new CustomEvent('flightYawDelta', { detail: { delta } }));
            }

            // -- Mouse -> mecha yaw: lerp toward camera facing ONLY when no numpad yaw ---
            if (!yawLeft && !yawRight) {
                const camFwd3D = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
                const yawAngle = Math.atan2(camFwd3D.x, camFwd3D.z);
                const targetFacingQuat = new CANNON.Quaternion();
                targetFacingQuat.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), yawAngle);
                this.body.quaternion.slerp(targetFacingQuat, 0.12, this.body.quaternion);
            }

            // -- Boost logic -------------------------------------------------------
            isBoostKey = !!(inputManager.actions?.['flightBoost']);
            canBoost = !this.isBoostDepleted && isBoostKey && this.boostEnergy > 0;

            if (canBoost) {
                this.boostEnergy = Math.max(0, this.boostEnergy - dt);
                if (this.boostEnergy <= 0) this.isBoostDepleted = true;
            } else {
                // Regen only when NOT holding boost OR when fully depleted (must wait for full)
                if (!isBoostKey || this.isBoostDepleted) {
                    this.boostEnergy = Math.min(this.boostEnergyMax, this.boostEnergy + this.boostRegenRate * dt);
                    if (this.boostEnergy >= this.boostEnergyMax) this.isBoostDepleted = false;
                }
            }

            // -- Build target velocity vector -------------------------------------
            if (canBoost) {
                // Boost: exact 3D camera forward (includes vertical pitch)
                const boostDir = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion).normalize();
                moveVel.copy(boostDir).multiplyScalar(BOOST_SPEED);
            } else {
                const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion).normalize();
                const rgt = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion).normalize();

                if (inputManager.keys['w']) moveVel.addScaledVector(fwd, FLIGHT_SPEED);
                if (inputManager.keys['s']) moveVel.addScaledVector(fwd, -FLIGHT_SPEED);
                if (inputManager.keys['a']) moveVel.addScaledVector(rgt, -FLIGHT_SPEED);
                if (inputManager.keys['d']) moveVel.addScaledVector(rgt, FLIGHT_SPEED);

                const isUp = !!(inputManager.actions?.['flightUp']);
                const isDown = !!(inputManager.actions?.['flightDown']);
                if (isUp) moveVel.y += VERTICAL_SPEED;
                if (isDown) moveVel.y -= VERTICAL_SPEED;
            }
        } else {
            // Free Roam mode: passively regenerate boost, ignore movement inputs
            if (!this.isBoostDepleted) {
                this.boostEnergy = Math.min(this.boostEnergyMax, this.boostEnergy + this.boostRegenRate * dt);
                if (this.boostEnergy >= this.boostEnergyMax) this.isBoostDepleted = false;
            }
        }

        // Apply or damp — using lerp for smooth acceleration, dt-scaled damping for coast
        if (moveVel.lengthSq() > 0) {
            this.body.velocity.x += (moveVel.x - this.body.velocity.x) * velLerp;
            this.body.velocity.z += (moveVel.z - this.body.velocity.z) * velLerp;
            if (moveVel.y !== 0) {
                this.body.velocity.y += (moveVel.y - this.body.velocity.y) * velLerp;
            } else {
                this.body.velocity.y *= dampFactor;
            }
        } else {
            this.body.velocity.x *= dampFactor;
            this.body.velocity.y *= dampFactor;
            this.body.velocity.z *= dampFactor;
        }

        // -- Altitude ring: stays level in world space -------------------------
        this.altitudeRing.rotation.set(0, 0, 0);
        const vy = this.body.velocity.y;
        this.altNeedle.rotation.x = THREE.MathUtils.clamp(vy * 0.08, -0.6, 0.6);

        // -- Boost indicator visual ----------------------------------------
        const boostFrac = this.boostEnergy / this.boostEnergyMax;

        // Sync the front 6 ticks of the First Person HUD
        if (this.boostTickMat) {
            if (this.isBoostDepleted) {
                this.boostTickMat.color.setHex(0xff2020);
                this.boostTickMat.opacity = 0.4 + 0.6 * Math.abs(Math.sin(performance.now() * 0.008));
            } else if (canBoost) {
                this.boostTickMat.color.setHex(0xc000ff);
                this.boostTickMat.opacity = 1.0;
            } else {
                this.boostTickMat.color.setHex(0x00f2fe);
                this.boostTickMat.opacity = 0.4;
            }
        }

        // Sync outer boost brackets
        this.boostBrackets.traverse((child) => {
            if (child.isMesh && child.userData.isFill) {
                if (this.isBoostDepleted) {
                    child.material.color.setHex(0xff2020);
                    child.material.opacity = 0.4 + 0.3 * Math.abs(Math.sin(performance.now() * 0.008));
                } else {
                    child.material.color.setHex(canBoost ? 0xffffff : 0x00f2fe);
                    child.material.opacity = 0.3 + boostFrac * 0.6;
                }
            }
        });

        // -- HUD DOM readouts ------------------------------------------------
        const altEl = document.getElementById('flight-altitude');
        const spdEl = document.getElementById('flight-speed');
        if (altEl) altEl.textContent = this.body.position.y.toFixed(1);
        if (spdEl) {
            const spd3D = Math.sqrt(
                this.body.velocity.x ** 2 +
                this.body.velocity.y ** 2 +
                this.body.velocity.z ** 2
            );
            spdEl.textContent = spd3D.toFixed(1);
        }

        // -- Flight shooting: left-click fires along 3D camera forward, no aim required ----
        // For rapid fire (mode 2), check mouseState.left; for single fire, use isShooting.
        const isFiring = inputManager.isShooting ||
            (inputManager.fireMode === 2 && inputManager.mouseState?.left);
        if (isFiring) {
            // Project aimTarget 80 units along camera forward if no raycast hit is available
            const camDir = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion).normalize();
            const farTarget = this.camera.position.clone().addScaledVector(camDir, 80);
            // Only override if aimTarget is at origin (i.e., no real hit registered)
            if (this.aimTarget.lengthSq() < 0.1 || !inputManager.aimActive) {
                this.aimTarget.copy(farTarget);
            }
            this.shoot(inputManager.fireMode || 1);
        }
    }

    /**
     * Toggle Flight Mode on/off.
     * Shows/hides the Iron Man ring, boost brackets, and flight HUD.
     */
    toggleFlight() {
        this.flightActive = !this.flightActive;

        // On enter: kill momentum for a clean hover
        // On exit: kill velocity so mecha doesn't rocket away when re-landing
        this.body.velocity.set(0, 0, 0);
        this.body.angularVelocity.set(0, 0, 0);

        // Force-retract shield when entering flight — a flying mecha can't be locked inside a bubble.
        if (this.flightActive) {
            this.shieldActiveBase = false;
            this.isShieldDeployed = false;
            if (this.shieldMesh) this.shieldMesh.visible = false;
        }

        // 3D overlays visible only in flight
        this.altitudeRing.visible = this.flightActive;
        this.boostBrackets.visible = this.flightActive;

        // HUD panel
        const flightHud = document.getElementById('flight-hud');
        if (flightHud) flightHud.classList.toggle('hidden', !this.flightActive);
    }

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

    /**
     * Load engine plume GLB and instantiate 5 named emitter slots,
     * parented to the mecha wrapper. Call once after construction.
     *
     * POSITION NOTE: mechaWrapper is unscaled; mechaModel inside it has:
     *   position.y = 2.35 (raised above wrapper origin)
     *   scale      = 0.6
     *   rotation   = (0,0,0) → mecha faces camera (+Z in world)
     *   so mecha BACK is at NEGATIVE Z in wrapper-local space.
     *
     * ROTATION NOTE: plume GLB emits in its own +Y by default (upward).
     *   rot.x = Math.PI flips the emission to fire in LOCAL -Y, which
     *   after pivot placement on the back fires AWAY from the mecha.
     */
    loadPlumes(loader) {
        // Local offsets relative to mechaWrapper (unscaled):
        //   y: mecha feet ~2.35, torso ~3.5, shoulder ~4.4, head ~5.3
        //   z: mecha back exits at roughly z = -0.5 to -1.0 (negative = away from camera)
        //   rot.x = Math.PI  → flip plume fire direction from +Y to -Y
        //   additional tilt angles are applied on top.
        const SLOTS = [
            // Shoulder vents — upper back, slightly outward
            { name: 'shoulderL', pos: [-0.65, 4.35, -0.35], rot: [Math.PI + 0.3, 0, 0.2], scale: 0.32 },
            { name: 'shoulderR', pos: [0.65, 4.35, -0.35], rot: [Math.PI + 0.3, 0, -0.2], scale: 0.32 },
            // Main central back thruster
            { name: 'backMain', pos: [0.0, 2.30, -0.85], rot: [Math.PI + 0.15, 0, 0.0], scale: 0.70 },
            // Side nacelle boosters — flanking the torso (only active during boost, facing backwards)
            { name: 'sideL', pos: [-0.55, 3.15, -0.50], rot: [Math.PI * 1.5 + 0.2, -0.1, 0], scale: 0.36 },
            { name: 'sideR', pos: [0.55, 3.15, -0.50], rot: [Math.PI * 1.5 + 0.2, 0.1, 0], scale: 0.36 },
        ];

        // Fire colors — orange-yellow gradient
        this.PLUME_COLOR_FIRE = new THREE.Color(0xFF6600); // deep orange core
        this.PLUME_COLOR_FIRE2 = new THREE.Color(0xFFAA00); // yellow outer
        // Boost colors — electric orange-blue
        this.PLUME_COLOR_BOOST = new THREE.Color(0xFF3300); // hot orange
        this.PLUME_COLOR_BOOST2 = new THREE.Color(0x0088FF); // electric blue

        this.plumes = {};
        this.plumeReady = false;
        this._boostColorActive = false; // track last color state

        loader.load('assets/simple_engine_plume_test.glb', (gltf) => {
            const baseScene = gltf.scene;
            const baseClips = gltf.animations;

            SLOTS.forEach(slot => {
                const clone = baseScene.clone(true);
                clone.visible = false;

                // Collect emissive meshes for color control
                const emissiveMeshes = [];
                clone.traverse(child => {
                    if (child.isMesh && child.material) {
                        child.material = child.material.clone();
                        child.material.blending = THREE.AdditiveBlending;
                        child.material.depthWrite = false;
                        child.material.transparent = true;
                        // Stamp fire colour on load
                        child.material.color.set(this.PLUME_COLOR_FIRE);
                        if (child.material.emissive) child.material.emissive.set(this.PLUME_COLOR_FIRE2);
                        if (child.material.emissiveIntensity !== undefined) child.material.emissiveIntensity = 1.4;
                        emissiveMeshes.push(child);
                    }
                });

                const pivot = new THREE.Group();
                pivot.position.set(...slot.pos);
                pivot.rotation.set(...slot.rot);
                pivot.scale.setScalar(slot.scale);
                pivot.add(clone);
                this.mesh.add(pivot);

                const mixer = new THREE.AnimationMixer(clone);
                let action = null;
                if (baseClips.length > 0) {
                    action = mixer.clipAction(baseClips[0]);
                    action.setLoop(THREE.LoopRepeat, Infinity);
                    action.play();
                }

                this.plumes[slot.name] = { mesh: clone, pivot, mixer, action, baseScale: slot.scale, emissiveMeshes };
            });

            this.plumeReady = true;
            console.log('[Plumes] Engine plume system ready — 5 emitter slots active.');
        }, undefined, (err) => {
            console.warn('[Plumes] Failed to load plume GLB:', err);
        });
    }

    /** Tint all meshes in a plume slot to fire or boost colors. */
    _setPlumeTint(plume, isBoosting) {
        const col = isBoosting ? this.PLUME_COLOR_BOOST : this.PLUME_COLOR_FIRE;
        const col2 = isBoosting ? this.PLUME_COLOR_BOOST2 : this.PLUME_COLOR_FIRE2;
        plume.emissiveMeshes.forEach(child => {
            child.material.color.set(col);
            if (child.material.emissive) child.material.emissive.set(col2);
        });
    }

    /**
     * Drive plume visibility, scale, color, and vectored-thrust yaw each frame.
     * Must be called inside _updateFlight() every tick.
     */
    _updatePlumes(inputManager, dt, cameraMode) {
        if (!this.plumeReady) return;

        const active = cameraMode !== 0 && this.flightActive;

        // If flight mode is deactivated while in flight mode, shut down all visuals
        if (!active) {
            Object.values(this.plumes).forEach(p => p.mesh.visible = false);
            return;
        }

        const isUp = active && !!(inputManager.actions?.['flightUp']);
        const isDown = active && !!(inputManager.actions?.['flightDown']);
        const isLeft = active && !!(inputManager.keys?.['a']);
        const isRight = active && !!(inputManager.keys?.['d']);
        const isBoosting = active && !this.isBoostDepleted
            && !!(inputManager.actions?.['flightBoost'])
            && this.boostEnergy > 0;

        // Retint all slots when boost state changes (avoid per-frame traversal)
        if (isBoosting !== this._boostColorActive) {
            this._boostColorActive = isBoosting;
            Object.values(this.plumes).forEach(p => this._setPlumeTint(p, isBoosting));
        }

        // ── Shoulder plumes — visible only when descending ─────────────────────
        ['shoulderL', 'shoulderR'].forEach(name => {
            const p = this.plumes[name];
            p.mesh.visible = isDown;
            if (isDown) p.mixer.update(dt);
        });

        // ── Back main thruster — always on in flight, big when ascending or boosting ───────
        const bp = this.plumes['backMain'];
        bp.mesh.visible = true;
        const targetScale = (isUp || isBoosting) ? bp.baseScale * 2.4 : bp.baseScale * 0.65;
        const curS = bp.pivot.scale.x;
        bp.pivot.scale.setScalar(curS + (targetScale - curS) * Math.min(1, dt * 7));

        // Dynamic anchoring: shift the exhaust down on the Y axis when scaled up
        // to prevent the massive flame from clipping upward into the mecha body.
        // We only apply this drop when purely ascending, otherwise it decouples the horizontal boost jet.
        const basePosY = 2.30;
        const targetPosY = (isUp && !isBoosting) ? (basePosY - 0.90) : basePosY;
        bp.pivot.position.y += (targetPosY - bp.pivot.position.y) * Math.min(1, dt * 7);

        // Vectored-thrust yaw: lean opposite to strafe direction (using Z axis since the plume emits vertically)
        const yawTarget = isLeft ? 0.42 : isRight ? -0.42 : 0.0;
        bp.pivot.rotation.z += (yawTarget - bp.pivot.rotation.z) * Math.min(1, dt * 8);

        // Speed illusion: pitch backward by 90 degrees (+Math.PI/2) during boost
        // Math.PI points down. 1.5 * Math.PI points perfectly backward.
        const pitchTarget = isBoosting ? (Math.PI + 0.15 + Math.PI / 2) : (Math.PI + 0.15);
        bp.pivot.rotation.x += (pitchTarget - bp.pivot.rotation.x) * Math.min(1, dt * 8);

        // Dynamic length: stretch the flame backwards heavily when boosting (3.0x multiplier)
        const lengthTarget = isBoosting ? 3.0 : (isUp ? 2.5 : 1.5);
        const curLen = bp.mesh.scale.y;
        bp.mesh.scale.set(1, curLen + (lengthTarget - curLen) * Math.min(1, dt * 8), 1);

        bp.mixer.update(dt);

        // ── Side nacelle plumes — boost only ─────────────────────────────────
        ['sideL', 'sideR'].forEach(name => {
            const p = this.plumes[name];
            p.mesh.visible = isBoosting;
            if (isBoosting) {
                // Stretch the mesh on its local Y axis to make it visibly longer
                p.mesh.scale.set(1, 2.5, 1);
                p.pivot.scale.setScalar(p.baseScale * 1.55);
                p.mixer.update(dt);
            }
        });
    }
}
