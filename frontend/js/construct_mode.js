import * as THREE from 'three';
import * as CANNON from 'cannon-es';

/**
 * ConstructMode — Mode 4: Hand-Drawing to 3D Physics Object Launch
 *
 * Simplified State Machine:
 *   IDLE → DRAWING → OBJECT_READY → AIMING → FIRED → COOLDOWN
 *
 * Gestures:
 *   Right hand point (index only) → draw stroke points (right hand only)
 *   Left hand fist held 400ms     → extrude stroke to 3D object immediately
 *   Mouse hold (in AIMING)        → charges force meter (0–100%)
 *   Mouse release (in AIMING)     → fires at proportional speed
 */

// ─── Constants ───────────────────────────────────────────────────────────────
const STATES = Object.freeze({
    IDLE: 'IDLE',
    DRAWING: 'DRAWING',
    OBJECT_READY: 'OBJECT_READY',
    AIMING: 'AIMING',
    FIRED: 'FIRED',
    COOLDOWN: 'COOLDOWN',
});

const MAX_POINTS = 150;       // Max stroke points per session
const MIN_STROKE_DIST = 0.05;      // Min world-space distance between points (anti-aliasing)
const FIST_HOLD_MS = 400;       // ms left-fist must be held to trigger extrusion
const COOLDOWN_MS = 30_000;    // 30 seconds cooldown
const LIFETIME_MS = 120_000;   // Spawned object lives 2 min
const STALE_WARN_MS = 20_000;   // Last 20 s — object pulses orange to warn of despawn
const DESPAWN_ALT = -300;      // Auto-despawn if below this Y

// Force meter / launch speed
const CHARGE_MAX_MS = 2000;      // Full charge reached after 2 seconds
const SPEED_MIN = 3;         // m/s at tap (0% charge)
const SPEED_MAX = 20;        // m/s at full hold (100% charge)

// Drawing plane depth in front of camera
const DRAW_PLANE_DEPTH = 2.5;

// Arrow key rotation
const ROTATION_INCREMENT = (5 * Math.PI) / 180;

// Douglas-Peucker epsilon
const DP_EPSILON = 0.03;

// ─── Douglas-Peucker Path Simplification ─────────────────────────────────────
function perpendicularDistance(point, lineStart, lineEnd) {
    const dx = lineEnd.x - lineStart.x;
    const dy = lineEnd.y - lineStart.y;
    const mag = Math.sqrt(dx * dx + dy * dy);
    if (mag === 0) return point.distanceTo(lineStart);
    return Math.abs(dx * (lineStart.y - point.y) - (lineStart.x - point.x) * dy) / mag;
}

function douglasPeucker(points, epsilon) {
    if (points.length <= 2) return points;
    let maxDist = 0, maxIdx = 0;
    const end = points.length - 1;
    for (let i = 1; i < end; i++) {
        const d = perpendicularDistance(points[i], points[0], points[end]);
        if (d > maxDist) { maxDist = d; maxIdx = i; }
    }
    if (maxDist > epsilon) {
        const left = douglasPeucker(points.slice(0, maxIdx + 1), epsilon);
        const right = douglasPeucker(points.slice(maxIdx), epsilon);
        return [...left.slice(0, -1), ...right];
    }
    return [points[0], points[end]];
}

// ─── Main Class ───────────────────────────────────────────────────────────────
export class ConstructMode {
    /**
     * @param {THREE.Scene}   scene
     * @param {PhysicsWorld}  physicsWorld
     * @param {THREE.Camera}  camera
     * @param {InputManager}  inputManager  — for live mouseState polling
     */
    constructor(scene, physicsWorld, camera, inputManager) {
        this.scene = scene;
        this.physicsWorld = physicsWorld;
        this.camera = camera;
        this._input = inputManager;

        // State
        this.state = STATES.IDLE;
        this.active = false;

        // Drawing
        this._strokePoints = [];
        this.pointsRemaining = MAX_POINTS;

        // Fist debounce — timestamp when fist gesture first detected
        this._fistStart = null;

        // Head telemetry
        this._latestHead = null;

        // Orbit setters (bound from scene.js)
        this._setOrbitYaw = null;
        this._setOrbitPitch = null;
        this._getOrbitYaw = null;
        this._getOrbitPitch = null;

        // Arrow key states (set by external code)
        this.arrowLeft = false;
        this.arrowRight = false;
        this.arrowUp = false;
        this.arrowDown = false;

        // THREE stroke line
        this._strokeLine = null;
        this._strokeGeo = null;

        // Spawned objects
        this._constructObjects = [];

        // Force meter
        this._chargeStart = null;   // performance.now() when mousedown
        this._charge = 0;      // 0..1

        // HUD elements
        this._hudPoints = document.getElementById('construct-points');
        this._meterWrap = document.getElementById('force-meter-wrap');
        this._meterFill = document.getElementById('force-meter-fill');

        // Cooldown
        this._cooldownEnd = 0;
        this._cooldownRAF = null;

        // Gesture tracking
        this._prevLeftGesture = 'none';

        // Cooldown timer HUD span (inline in #construct-points)
        this._timerSpan = document.getElementById('construct-cooldown-timer');

        // Mecha reference for depth anchoring
        this.mecha = null;
        this._extruding = false;

        this._initStrokeLine();
        console.log('[ConstructMode] Initialised');
    }

    /** Bind Mecha 3D wrapper reference so drawing plane matches Mecha depth */
    setMecha(mechaMesh) {
        this.mecha = mechaMesh;
    }

    // ─── Lifecycle ────────────────────────────────────────────────────────────

    activate() {
        if (this.active) return;
        this.active = true;
        this.state = STATES.IDLE;
        this.pointsRemaining = MAX_POINTS;
        this._strokePoints = [];
        this._fistStart = null;
        this._chargeStart = null;
        this._charge = 0;
        this._updateHUD();
        console.log('[ConstructMode] Activated');
    }

    deactivate() {
        this.active = false;
        this._clearStrokeLine();
        this._hideForceMeter();
        this.state = STATES.IDLE;
        this._stopCooldownTimer();
        this._hideHUD();
        console.log('[ConstructMode] Deactivated');
    }

    /** Bind live orbit setters from scene.js */
    bindOrbitSetters(setYaw, setPitch, getYaw, getPitch) {
        this._setOrbitYaw = setYaw;
        this._setOrbitPitch = setPitch;
        this._getOrbitYaw = getYaw;
        this._getOrbitPitch = getPitch;
    }

    // ─── Telemetry Entry Point ────────────────────────────────────────────────

    /**
     * Called every WebSocket message with fresh telemetry.
     * @param {Array}  hands — hand objects from telemetry
     * @param {Object} head  — {x, y, z}
     */
    onTelemetry(hands, head) {
        this._latestHead = head;
        if (!this.active) return;

        let rightHand = null;
        let leftHand = null;
        for (const h of hands) {
            if (h.handedness === 'Right' && !rightHand) rightHand = h;
            if (h.handedness === 'Left' && !leftHand) leftHand = h;
        }

        const leftGesture = leftHand ? leftHand.gesture : 'none';

        this._processRightHand(rightHand);
        this._processLeftHand(leftGesture);

        this._prevLeftGesture = leftGesture;
    }

    // ─── Per-Frame Update ─────────────────────────────────────────────────────

    /**
     * Main update — called every animation frame from scene.js.
     * @param {number} dt  delta-time in seconds
     */
    update(dt) {
        // Tick spawned object lifetime regardless of active state
        this._tickObjectLifetime();

        if (!this.active) return;

        // Head aiming drives orbit
        if (this._latestHead && this._applyHeadAim) {
            this._applyHeadAim(dt);
        }

        // Arrow-key rotation applies physical angular momentum to the most recent construct object
        this._applyArrowRotation();
    }

    // ─── Right Hand: Drawing ──────────────────────────────────────────────────

    _processRightHand(rightHand) {
        if (!rightHand) return;
        const gesture = rightHand.gesture;

        if (gesture === 'point' && rightHand.index_tip) {
            if (this.pointsRemaining <= 0) return;

            // Auto-start drawing on first point
            if (this.state === STATES.IDLE) {
                this.state = STATES.DRAWING;
                this._updateHUD();
            }

            if (this.state === STATES.DRAWING) {
                this._addStrokePoint(rightHand.index_tip);
            }
        }
    }

    _addStrokePoint(indexTip) {
        // Un-project the normalised tip coord onto a plane in front of camera
        const vec = new THREE.Vector3(indexTip.x, indexTip.y, 0.5);
        vec.unproject(this.camera);
        const dir = vec.sub(this.camera.position).normalize();

        const camForward = new THREE.Vector3();
        this.camera.getWorldDirection(camForward);
        const planeNormal = camForward.clone().negate();

        // Dynamically anchor the drawing plane to pass directly through the Mecha's position in 3D world space!
        // This ensures drawing above the mecha on screen places the 3D stroke points directly above the mecha.
        let planeOrigin;
        if (this.mecha && this.mecha.position) {
            planeOrigin = this.mecha.position.clone().add(new THREE.Vector3(0, 2.0, 0));
        } else {
            planeOrigin = this.camera.position.clone().addScaledVector(camForward, 5.0);
        }

        let worldPoint;
        const denom = planeNormal.dot(dir);
        if (Math.abs(denom) > 1e-6) {
            const t = planeNormal.dot(planeOrigin.clone().sub(this.camera.position)) / denom;
            worldPoint = this.camera.position.clone().addScaledVector(dir, t);
        } else {
            worldPoint = this.camera.position.clone().addScaledVector(dir, 5.0);
        }

        // ── Min-distance filter: skip if too close to last point ──────────────
        const last = this._strokePoints.at(-1);
        if (last && worldPoint.distanceTo(last) < MIN_STROKE_DIST) return;

        this._strokePoints.push(worldPoint);
        this.pointsRemaining = Math.max(0, this.pointsRemaining - 1);
        this._updateStrokeLine();
        this._updateHUD();
    }

    // ─── Left Hand: Fist → Extrude ────────────────────────────────────────────

    _processLeftHand(gesture) {
        if (gesture === 'fist') {
            // Start or continue the fist timer
            if (this._fistStart === null) {
                this._fistStart = performance.now();
            }
            const held = performance.now() - this._fistStart;

            // Allow extrusion from DRAWING state, OR from IDLE if the user already
            // drew ≥3 points and lifted their right finger before making a fist.
            const canExtrude = (this.state === STATES.DRAWING || this.state === STATES.IDLE) &&
                this._strokePoints.length >= 3 &&
                !this._extruding;

            if (held >= FIST_HOLD_MS && canExtrude) {
                this._extruding = true;
                this._convertStrokeTo3D();  // Immediately spawns dynamic physics object!
                this._fistStart = null;
                setTimeout(() => { this._extruding = false; }, 800); // 800ms gesture debounce
            } else if (held >= FIST_HOLD_MS && this._strokePoints.length === 0) {
                console.debug('[ConstructMode] Fist held — no stroke points yet; point your right index finger to draw first.');
            }
        } else {
            // Reset fist timer whenever gesture is NOT fist
            this._fistStart = null;
        }

        this._prevLeftGesture = gesture;
    }

    // ─── 3D Conversion ────────────────────────────────────────────────────────

    _convertStrokeTo3D() {
        this.state = STATES.OBJECT_READY;
        console.log('[ConstructMode] Extruding stroke —', this._strokePoints.length, 'pts');
        this._updateHUD();

        const points3D = this._strokePoints;

        // Build local frame from stroke centroid + camera orientation
        const centroid = new THREE.Vector3();
        points3D.forEach(p => centroid.add(p));
        centroid.divideScalar(points3D.length);

        const camForward = new THREE.Vector3();
        this.camera.getWorldDirection(camForward);
        const planeNormal = camForward.clone().negate();
        const planeRight = new THREE.Vector3(1, 0, 0);
        const planeUp = new THREE.Vector3().crossVectors(planeNormal, planeRight).normalize();

        // Project to 2D
        const pts2D = points3D.map(p => {
            const rel = p.clone().sub(centroid);
            return new THREE.Vector2(rel.dot(planeRight), rel.dot(planeUp));
        });

        // Simplify
        const simplified = douglasPeucker(pts2D, DP_EPSILON);
        if (simplified.length < 3) {
            console.warn('[ConstructMode] Simplified stroke too short — resetting');
            this.state = STATES.DRAWING;
            this._updateHUD();
            return;
        }

        // Build shape
        const shape = new THREE.Shape();
        shape.moveTo(simplified[0].x, simplified[0].y);
        for (let i = 1; i < simplified.length; i++) {
            shape.lineTo(simplified[i].x, simplified[i].y);
        }
        shape.closePath();

        // Extrude depth proportional to bounding box
        const box = new THREE.Box2();
        simplified.forEach(p => box.expandByPoint(p));
        const size = new THREE.Vector2();
        box.getSize(size);
        const extrudeDepth = Math.max(0.15, Math.min((size.x + size.y) * 0.25, 1.5));

        const geometry = new THREE.ExtrudeGeometry(shape, {
            depth: extrudeDepth,
            bevelEnabled: true,
            bevelThickness: 0.04,
            bevelSize: 0.03,
            bevelSegments: 2,
        });
        geometry.computeBoundingBox();
        geometry.center();

        // Translucent cyan glass material
        const material = new THREE.MeshPhysicalMaterial({
            color: 0x00f2fe,
            emissive: 0x003344,
            emissiveIntensity: 0.4,
            transparent: true,
            opacity: 0.55,
            roughness: 0.05,
            metalness: 0.1,
            transmission: 0.55,
            thickness: 0.5,
            depthWrite: false,
            side: THREE.DoubleSide,
        });

        const mesh = new THREE.Mesh(geometry, material);
        mesh.quaternion.copy(this.camera.quaternion);
        mesh.position.copy(centroid);
        this.scene.add(mesh);

        geometry.computeBoundingBox();
        const bb = geometry.boundingBox;
        const hw = Math.max(0.15, (bb.max.x - bb.min.x) / 2);
        const hh = Math.max(0.15, (bb.max.y - bb.min.y) / 2);
        const hd = Math.max(0.15, (bb.max.z - bb.min.z) / 2);

        // Calculate realistic mass based on extruded physical volume (density ~ 70 kg/m^3)
        const volume = (hw * 2) * (hh * 2) * (hd * 2);
        const mass = Math.max(50, Math.min(350, volume * 70));

        const body = new CANNON.Body({
            mass: mass,
            position: new CANNON.Vec3(mesh.position.x, mesh.position.y, mesh.position.z),
            quaternion: new CANNON.Quaternion(mesh.quaternion.x, mesh.quaternion.y, mesh.quaternion.z, mesh.quaternion.w)
        });

        // 1. Primary Box shape: provides solid flat surfaces for Mecha to stand on and slide over
        body.addShape(new CANNON.Box(new CANNON.Vec3(hw, hh, hd)));

        // 2. Corner and bottom contact spheres: enables collision against static CANNON.Trimesh environment (floors & stairs)
        const sphereR = Math.min(0.2, hw * 0.4, hh * 0.4, hd * 0.4);
        const sphereOffsets = [
            // Bottom face corners & center
            new CANNON.Vec3(-hw + sphereR, -hh + sphereR, -hd + sphereR),
            new CANNON.Vec3( hw - sphereR, -hh + sphereR, -hd + sphereR),
            new CANNON.Vec3(-hw + sphereR, -hh + sphereR,  hd - sphereR),
            new CANNON.Vec3( hw - sphereR, -hh + sphereR,  hd - sphereR),
            new CANNON.Vec3(0, -hh + sphereR, 0),
            // Top face corners (for upside-down landing or tumbling)
            new CANNON.Vec3(-hw + sphereR,  hh - sphereR, -hd + sphereR),
            new CANNON.Vec3( hw - sphereR,  hh - sphereR, -hd + sphereR),
            new CANNON.Vec3(-hw + sphereR,  hh - sphereR,  hd - sphereR),
            new CANNON.Vec3( hw - sphereR,  hh - sphereR,  hd - sphereR),
        ];
        sphereOffsets.forEach(offset => {
            body.addShape(new CANNON.Sphere(sphereR), offset);
        });

        body.linearDamping = 0.35;
        body.angularDamping = 0.50;
        body.material = this.physicsWorld.getConstructMaterial();

        // Group 2 — collides with Environment (1) AND Mecha (4)
        body.collisionFilterGroup = 2;
        body.collisionFilterMask = 1 | 4;

        // DYNAMIC PHYSICS: subject to gravity, velocity, momentum and collision immediately!
        body.type = CANNON.Body.DYNAMIC;
        body.velocity.set(0, -0.5, 0); // Slight downward velocity to initiate immediate gravitational fall
        this.physicsWorld.world.addBody(body);

        const constructObj = {
            mesh,
            body,
            fired: true,
            createdAt: performance.now(),
            firedAt: performance.now(),
            timeout: null
        };
        constructObj.timeout = setTimeout(() => this._despawnObject(constructObj), LIFETIME_MS);
        this._constructObjects.push(constructObj);

        // Clear the drawn stroke
        this._clearStrokeLine();
        this._strokePoints = [];

        // Return to IDLE so user can immediately draw another construct or interact
        this.state = STATES.IDLE;
        this.pointsRemaining = MAX_POINTS;
        this._updateHUD();
        console.log(`[ConstructMode] 3D Physics Object created! Mass: ${mass.toFixed(1)}kg, Volume: ${volume.toFixed(2)}m³`);
    }

    // ─── Force-Meter Fire ─────────────────────────────────────────────────────

    _fireWithCharge(charge) {
        const obj = this._constructObjects.find(o => !o.fired);
        if (!obj) return;

        const speed = SPEED_MIN + charge * (SPEED_MAX - SPEED_MIN);
        const dir = new THREE.Vector3();
        this.camera.getWorldDirection(dir);

        obj.body.type = CANNON.Body.DYNAMIC;
        obj.body.updateMassProperties();
        obj.body.wakeUp();
        obj.body.velocity.set(dir.x * speed, dir.y * speed, dir.z * speed);
        obj.fired = true;
        obj.firedAt = performance.now();
        obj.timeout = setTimeout(() => this._despawnObject(obj), LIFETIME_MS);

        this.state = STATES.FIRED;
        this._updateHUD();
        this._enterCooldown();
        console.log(`[ConstructMode] FIRED — speed ${speed.toFixed(1)} u/s (charge ${(charge * 100).toFixed(0)}%)`);
    }

    /** When fired (e.g. left click in Mode 4), apply a physical kinetic forward launch impulse to the active construct */
    fire() {
        const obj = this._constructObjects[this._constructObjects.length - 1];
        if (obj && obj.body) {
            const dir = new THREE.Vector3();
            this.camera.getWorldDirection(dir);
            obj.body.wakeUp();
            obj.body.applyImpulse(
                new CANNON.Vec3(dir.x * 300, dir.y * 300 + 80, dir.z * 300),
                new CANNON.Vec3(0, 0, 0)
            );
            console.log('[ConstructMode] Applied physical forward impulse to construct object');
            return true;
        }
        return false;
    }

    // ─── Head Aiming ──────────────────────────────────────────────────────────

    _applyHeadAim(dt) {
        if (!this._latestHead || !this._setOrbitYaw) return;
        const HEAD_DEAD_ZONE = 0.15;
        const HEAD_SENSITIVITY = 1.5;
        const hx = this._latestHead.x;
        const hy = this._latestHead.y;
        if (Math.abs(hx) > HEAD_DEAD_ZONE) {
            const delta = Math.sign(hx) * (Math.abs(hx) - HEAD_DEAD_ZONE) * HEAD_SENSITIVITY * dt;
            this._setOrbitYaw(this._getOrbitYaw() + delta);
        }
        if (Math.abs(hy) > HEAD_DEAD_ZONE) {
            const delta = Math.sign(hy) * (Math.abs(hy) - HEAD_DEAD_ZONE) * HEAD_SENSITIVITY * dt;
            this._setOrbitPitch(this._getOrbitPitch() - delta);
        }
    }

    /** Apply physical angular velocity on the most recent construct object via arrow keys */
    _applyArrowRotation() {
        const obj = this._constructObjects[this._constructObjects.length - 1];
        if (!obj || !obj.body) return;
        obj.body.wakeUp();
        if (this.arrowLeft) obj.body.angularVelocity.y -= 2.0;
        if (this.arrowRight) obj.body.angularVelocity.y += 2.0;
        if (this.arrowUp) obj.body.angularVelocity.x -= 2.0;
        if (this.arrowDown) obj.body.angularVelocity.x += 2.0;
    }

    // ─── Lifetime & Despawn ───────────────────────────────────────────────────

    _tickObjectLifetime() {
        const now = performance.now();
        for (let i = this._constructObjects.length - 1; i >= 0; i--) {
            const obj = this._constructObjects[i];

            // Continuously sync THREE mesh to dynamic physics body every single frame
            obj.mesh.position.copy(obj.body.position);
            obj.mesh.quaternion.copy(obj.body.quaternion);

            // Despawn if fallen below the world floor
            if (obj.body.position.y < DESPAWN_ALT) {
                this._despawnObject(obj);
                continue;
            }

            // ── Stale visual warning (last STALE_WARN_MS ms) ───────────────────
            if (obj.firedAt !== null) {
                const remaining = LIFETIME_MS - (now - obj.firedAt);
                if (remaining < STALE_WARN_MS) {
                    // t goes 1 → 0 as the object approaches despawn
                    const t = Math.max(0, remaining / STALE_WARN_MS);
                    // Pulse frequency increases as it gets staler
                    const pulse = (Math.sin(now * 0.004 * (1 + (1 - t) * 4)) + 1) / 2;
                    const mat = obj.mesh.material;
                    // Opacity: fades from healthy 0.55 down to 0.15 with a pulse
                    mat.opacity = 0.15 + t * 0.40 + pulse * 0.15 * (1 - t);
                    // Emissive shifts from cyan to orange-red
                    mat.emissive.setRGB(
                        0.0 + (1 - t) * 0.9 + pulse * 0.3 * (1 - t),  // red rises
                        0.2 * t + (1 - t) * 0.25,                       // green drops
                        0.2 * t                                          // blue drops
                    );
                    mat.emissiveIntensity = 0.4 + (1 - t) * 2.0;
                    mat.needsUpdate = false;  // geometry unchanged; no full recompile
                } else {
                    // Healthy — restore default appearance
                    const mat = obj.mesh.material;
                    mat.opacity = 0.55;
                    mat.emissive.setHex(0x003344);
                    mat.emissiveIntensity = 0.4;
                }
            }
        }
    }

    _despawnObject(obj) {
        clearTimeout(obj.timeout);
        // Restore material opacity before removal (avoids THREE.js warnings)
        if (obj.mesh.material) {
            obj.mesh.material.opacity = 0;
        }
        this.scene.remove(obj.mesh);
        if (obj.body.world) this.physicsWorld.world.removeBody(obj.body);
        const idx = this._constructObjects.indexOf(obj);
        if (idx !== -1) this._constructObjects.splice(idx, 1);
    }

    // ─── Cooldown ─────────────────────────────────────────────────────────────

    _enterCooldown() {
        this.state = STATES.COOLDOWN;
        this._cooldownEnd = performance.now() + COOLDOWN_MS;
        this._updateHUD();
        console.log('[ConstructMode] Cooldown — 30 seconds');
        setTimeout(() => this._resetCycle(), COOLDOWN_MS);

        // Launch a RAF-based timer that ticks the inline countdown span
        this._stopCooldownTimer();
        const tick = () => {
            if (this.state !== STATES.COOLDOWN) { this._stopCooldownTimer(); return; }
            const remaining = Math.max(0, Math.ceil((this._cooldownEnd - performance.now()) / 1000));
            if (this._timerSpan) {
                this._timerSpan.textContent = `  ⏱ ${remaining}s`;
                this._timerSpan.style.display = 'inline';
            }
            if (remaining > 0) {
                this._cooldownRAF = requestAnimationFrame(tick);
            } else {
                this._stopCooldownTimer();
            }
        };
        this._cooldownRAF = requestAnimationFrame(tick);
    }

    _resetCycle() {
        this.state = STATES.IDLE;
        this.pointsRemaining = MAX_POINTS;
        this._strokePoints = [];
        this._fistStart = null;
        this._constructObjects = [];
        this._clearStrokeLine();
        this._stopCooldownTimer();
        this._updateHUD();
        console.log('[ConstructMode] Ready — cooldown over');
    }

    /** Cancel the RAF-based cooldown countdown and hide the timer span. */
    _stopCooldownTimer() {
        if (this._cooldownRAF !== null) {
            cancelAnimationFrame(this._cooldownRAF);
            this._cooldownRAF = null;
        }
        if (this._timerSpan) {
            this._timerSpan.style.display = 'none';
            this._timerSpan.textContent = '';
        }
    }

    // ─── Stroke Line Renderer ─────────────────────────────────────────────────

    _initStrokeLine() {
        this._strokeGeo = new THREE.BufferGeometry();
        const positions = new Float32Array(MAX_POINTS * 3);
        this._strokeGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        this._strokeGeo.setDrawRange(0, 0);

        const mat = new THREE.LineBasicMaterial({
            color: 0x00f2fe,
            linewidth: 2,
            transparent: true,
            opacity: 0.9,
            depthTest: false,
        });
        this._strokeLine = new THREE.Line(this._strokeGeo, mat);
        this._strokeLine.renderOrder = 999;
        this._strokeLine.visible = false;
        this.scene.add(this._strokeLine);
    }

    _updateStrokeLine() {
        const pts = this._strokePoints;
        if (pts.length < 2) { this._strokeLine.visible = false; return; }
        const posAttr = this._strokeGeo.attributes.position;
        for (let i = 0; i < pts.length && i < MAX_POINTS; i++) {
            posAttr.setXYZ(i, pts[i].x, pts[i].y, pts[i].z);
        }
        posAttr.needsUpdate = true;
        this._strokeGeo.setDrawRange(0, pts.length);
        this._strokeLine.visible = true;
    }

    _clearStrokeLine() {
        this._strokeGeo?.setDrawRange(0, 0);
        if (this._strokeLine) this._strokeLine.visible = false;
    }

    // ─── Force Meter HUD ──────────────────────────────────────────────────────

    _updateForceMeter(charge) {
        if (!this._meterWrap) return;
        this._meterWrap.classList.remove('hidden');
        if (this._meterFill) {
            this._meterFill.style.height = `${Math.round(charge * 100)}%`;
            // Colour shifts from cyan (low) to white-hot (full)
            const r = Math.round(charge * 255);
            const g = Math.round(242 - charge * 80);
            const b = Math.round(254 - charge * 100);
            this._meterFill.style.background = `rgb(${r},${g},${b})`;
            this._meterFill.style.boxShadow = `0 0 ${8 + charge * 16}px rgba(${r},${g},${b},0.8)`;
        }
    }

    _hideForceMeter() {
        if (!this._meterWrap) return;
        this._meterWrap.classList.add('hidden');
        if (this._meterFill) this._meterFill.style.height = '0%';
    }

    // ─── Points / State HUD ───────────────────────────────────────────────────

    _updateHUD() {
        if (!this._hudPoints) return;
        const labels = {
            [STATES.IDLE]: '✋ IDLE — Point right index to draw in 3D',
            [STATES.DRAWING]: '✏️ DRAWING — Hold left fist 0.4s to commit 3D physics object',
            [STATES.OBJECT_READY]: '🟦 SPAWNING 3D PHYSICS OBJECT...',
            [STATES.AIMING]: '🎯 3D PHYSICS ACTIVE',
            [STATES.FIRED]: '🚀 3D PHYSICS OBJECT DEPLOYED',
            [STATES.COOLDOWN]: '⏳ COOLDOWN — Recharging',
        };
        const label = labels[this.state] || this.state;
        // Re-inject innerHTML but preserve the timer span if it exists inside the div
        this._hudPoints.innerHTML =
            `<span style="font-size:0.75rem;opacity:0.75">${label}</span>` +
            `<br>POINTS: ${this.pointsRemaining}/${MAX_POINTS}` +
            `<span id="construct-cooldown-timer" style="display:none;margin-left:8px;color:#ffb300;"></span>`;
        // Re-grab the timer span reference since innerHTML was replaced
        this._timerSpan = document.getElementById('construct-cooldown-timer');
        this._hudPoints.classList.remove('hidden');
    }

    _hideHUD() {
        this._hudPoints?.classList.add('hidden');
    }
}
