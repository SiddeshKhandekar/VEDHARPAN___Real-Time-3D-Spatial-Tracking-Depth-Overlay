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
        this._fullCapacityStart = null; // performance.now() when 100% capacity first reached

        // HUD elements
        this._hudPoints = document.getElementById('construct-points');
        this._meterContainer = document.getElementById('force-meter-container');
        this._meterMsg = document.getElementById('force-meter-msg');
        this._meterWrap = document.getElementById('force-meter-wrap');
        this._meterFill = document.getElementById('force-meter-fill');
        this._meterLabel = document.getElementById('force-meter-label');
        this._meterPct = document.getElementById('force-meter-pct');

        // Auto-release feedback timer
        this._autoReleaseFeedbackStart = null;
        this._autoReleaseFeedbackEnd = null;

        // Cooldown
        this._cooldownEnd = 0;
        this._cooldownRAF = null;

        // Gesture tracking
        this._prevLeftGesture = 'none';

        // Cooldown timer HUD span (inline in #construct-points)
        this._timerSpan = document.getElementById('construct-cooldown-timer');

        // Mecha reference for depth anchoring
        this.mecha = null;
        this.mechaController = null;
        this._extruding = false;

        // Mouse hold tracking for robust force charging & release
        this._isMouseDown = false;

        window.addEventListener('mousedown', (e) => {
            if (e.button === 0 && this.state === STATES.AIMING && this.active) {
                this._isMouseDown = true;
                this._chargeStart = performance.now();
                this._fullCapacityStart = null;
                this._charge = 0;
                this._updateForceMeter(0);
            }
        });

        window.addEventListener('mouseup', (e) => {
            if (e.button === 0 && this.state === STATES.AIMING && this.active) {
                if (this._isMouseDown || this._chargeStart !== null) {
                    this._isMouseDown = false;
                    const finalCharge = Math.max(0.02, this._charge);
                    this._chargeStart = null;
                    this._fullCapacityStart = null;
                    this._charge = 0;
                    this._fireWithCharge(finalCharge, false);
                }
            }
        });

        this._initStrokeLine();
        console.log('[ConstructMode] Initialised');
    }

    /** Bind Mecha 3D wrapper reference so drawing plane matches Mecha depth */
    setMecha(mechaMesh, mechaController = null) {
        this.mecha = mechaMesh;
        if (mechaController) this.mechaController = mechaController;
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
        this._isMouseDown = false;
        this._chargeStart = null;
        this._fullCapacityStart = null;
        this._charge = 0;
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

        // Tick auto-release yellow blinking feedback if active
        if (this._autoReleaseFeedbackEnd !== null) {
            this._tickAutoReleaseFeedback();
        }

        if (!this.active) return;

        // In AIMING state: hold pending construct along aim vector and handle force meter charging
        if (this.state === STATES.AIMING) {
            this._syncObjectToAim();

            const isHolding = this._isMouseDown || (this._input && (this._input.mouseState?.left || this._input.gestureShootActive));
            if (isHolding) {
                if (this._chargeStart === null) {
                    this._chargeStart = performance.now();
                }
                const elapsed = performance.now() - this._chargeStart;
                this._charge = Math.min(1.0, elapsed / CHARGE_MAX_MS);
                this._updateForceMeter(this._charge);
            } else if (this._chargeStart !== null) {
                // Released LMB after charging!
                const finalCharge = Math.max(0.02, this._charge);
                this._isMouseDown = false;
                this._chargeStart = null;
                this._fullCapacityStart = null;
                this._charge = 0;
                this._fireWithCharge(finalCharge, false);
            }
        }

        // Head aiming drives orbit
        if (this._latestHead && this._applyHeadAim) {
            this._applyHeadAim(dt);
        }

        // Arrow-key rotation applies rotation to pending or fired construct object
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
        // Un-project normalised tip coord [-1, 1] onto a forward ray from camera
        const vec = new THREE.Vector3(indexTip.x, indexTip.y, 0.5);
        vec.unproject(this.camera);
        const dir = vec.sub(this.camera.position).normalize();

        // Calculate drawing distance: always position points at a clean, visible plane directly in front of the camera
        // In third person with mecha, match camera-to-mecha distance (clamped between 3.0m and 7.0m)
        let drawDist = 3.5;
        if (this.mecha && this.mecha.position) {
            const camToMecha = this.camera.position.distanceTo(this.mecha.position);
            drawDist = Math.max(3.0, Math.min(7.0, camToMecha));
        }
        const worldPoint = this.camera.position.clone().addScaledVector(dir, drawDist);

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

        // Calculate realistic mass based on extruded physical volume (density ~ 100 kg/m^3)
        const volume = (hw * 2) * (hh * 2) * (hd * 2);
        const mass = Math.max(30, Math.min(1500, volume * 100));

        const body = new CANNON.Body({
            mass: mass,
            position: new CANNON.Vec3(mesh.position.x, mesh.position.y, mesh.position.z),
            quaternion: new CANNON.Quaternion(mesh.quaternion.x, mesh.quaternion.y, mesh.quaternion.z, mesh.quaternion.w)
        });
        body.userDataVolume = volume;
        body.userDataMass = mass;
        body.isConstruct = true;
        body.isRestingOnGround = false;

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

        // Frozen in place (KINEMATIC) during AIMING until fired with force meter
        body.type = CANNON.Body.KINEMATIC;
        body.velocity.set(0, 0, 0);
        this.physicsWorld.world.addBody(body);

        const constructObj = {
            mesh,
            body,
            fired: false,
            createdAt: performance.now(),
            firedAt: null,
            timeout: null
        };
        this._constructObjects.push(constructObj);

        // Clear the drawn stroke
        this._clearStrokeLine();
        this._strokePoints = [];

        // Auto-enter AIMING state
        this.state = STATES.AIMING;
        this.pointsRemaining = MAX_POINTS;
        this._updateHUD();
        this._showForceMeter();
        console.log(`[ConstructMode] 3D Object Ready! Mass: ${mass.toFixed(1)}kg, Volume: ${volume.toFixed(2)}m³ — STATE: AIMING`);
    }

    // ─── Force-Meter Fire ─────────────────────────────────────────────────────

    _fireWithCharge(charge, isAutoRelease = false) {
        const obj = this._constructObjects.find(o => !o.fired);
        if (!obj) return;

        const volume = obj.body.userDataVolume || 1.0;
        // Formula: Higher volume/scale = lower max speed; shorter/compact = high speed & distance
        // Small (vol ~0.04m³): maxSpeed = 105 m/s (touches the train ~500m in ~5s)
        // Medium (vol ~1.0m³): maxSpeed = 32 m/s
        // Large (vol ~6.0m³): maxSpeed = 7.6 m/s
        // Massive (vol >= 18m³): maxSpeed = 2.8 - 3.2 m/s (directly falls down due to excessive weight)
        const maxSpeed = Math.max(2.5, Math.min(105.0, 32.0 / Math.pow(Math.max(0.04, volume), 0.8)));
        const minSpeed = Math.min(2.0, maxSpeed * 0.12);
        const speed = minSpeed + Math.pow(charge, 1.1) * (maxSpeed - minSpeed);

        // Aim direction: straight down the camera aim ray through crosshairs
        const shootDir = new THREE.Vector3();
        const camDir = new THREE.Vector3();
        this.camera.getWorldDirection(camDir);

        if (this._input && this._input.raycaster && this._input.raycaster.ray && this._input.raycaster.ray.direction.lengthSq() > 0.01) {
            shootDir.copy(this._input.raycaster.ray.direction).normalize();
        } else {
            shootDir.copy(camDir);
        }
        if (shootDir.dot(camDir) < 0.2) {
            shootDir.copy(camDir);
        }

        // Aerodynamic lift during flight for small/fast objects (compensates gravity so it stays airborne to reach train)
        // Heavy/massive objects (volume > 2.5m³) get 0 lift so they plummet to the ground immediately
        const liftFactor = (volume <= 2.5) ? Math.min(0.96, (speed / 105.0) * 0.96 * (1.0 - Math.abs(shootDir.y))) : 0;
        obj.body.liftFactor = liftFactor;

        // Reposition cleanly right along aim vector without parallax offset
        const startPos = this.camera.position.clone().addScaledVector(shootDir, 3.2);
        obj.mesh.position.copy(startPos);
        obj.body.position.copy(startPos);

        obj.body.type = CANNON.Body.DYNAMIC;
        obj.body.mass = obj.body.userDataMass || 100;
        obj.body.updateMassProperties();
        obj.body.wakeUp();

        // In-flight minimal damping: preserves momentum and speed over long distance flight
        obj.body.linearDamping = 0.008;
        obj.body.angularDamping = 0.02;

        obj.body.velocity.set(
            shootDir.x * speed,
            shootDir.y * speed,
            shootDir.z * speed
        );
        // Subtle natural rotational momentum upon launch
        obj.body.angularVelocity.set(
            (Math.random() - 0.5) * 1.5,
            (Math.random() - 0.5) * 1.5,
            (Math.random() - 0.5) * 1.5
        );
        obj.body.isRestingOnGround = false;

        // Contact/collision listener: when hitting ground or obstacle, remove lift and restore normal damping
        const onCollide = () => {
            obj.body.liftFactor = 0;
            obj.body.linearDamping = 0.35;
            obj.body.angularDamping = 0.50;
        };
        obj.body.addEventListener('collide', onCollide);

        obj.fired = true;
        obj.firedAt = performance.now();
        obj.timeout = setTimeout(() => this._despawnObject(obj), LIFETIME_MS);

        if (this.mechaController && this.mechaController.ammo && this.mechaController.ammo[4]) {
            const a = this.mechaController.ammo[4];
            if (a.rounds > 0) a.rounds--;
            window.dispatchEvent(new CustomEvent('ammoUpdate', {
                detail: { mode: 4, rounds: a.rounds, max: a.max, isReloading: false, cooldownMs: a.cooldownMs }
            }));
        }

        this.state = STATES.FIRED;
        if (isAutoRelease) {
            this._startAutoReleaseFeedback();
        } else {
            this._hideForceMeter();
        }
        this._updateHUD();
        this._enterCooldown();
        console.log(`[ConstructMode] FIRED (autoRelease: ${isAutoRelease}) — speed ${speed.toFixed(1)} m/s (charge ${(charge * 100).toFixed(0)}%, volume ${volume.toFixed(2)} m³, mass ${obj.body.mass.toFixed(1)} kg, lift: ${liftFactor.toFixed(2)})`);
    }

    /** When fired (e.g. left click in Mode 4 from mechaController), launch the active construct */
    fire() {
        if (this.state === STATES.AIMING) {
            const charge = (this._chargeStart !== null) ? this._charge : 0.3;
            this._isMouseDown = false;
            this._chargeStart = null;
            this._fullCapacityStart = null;
            this._charge = 0;
            this._fireWithCharge(charge, false);
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

    _syncObjectToAim() {
        const obj = this._constructObjects.find(o => !o.fired);
        if (!obj) return;
        const shootDir = new THREE.Vector3();
        const camDir = new THREE.Vector3();
        this.camera.getWorldDirection(camDir);

        if (this._input && this._input.raycaster && this._input.raycaster.ray && this._input.raycaster.ray.direction.lengthSq() > 0.01) {
            shootDir.copy(this._input.raycaster.ray.direction).normalize();
        } else {
            shootDir.copy(camDir);
        }
        if (shootDir.dot(camDir) < 0.2) {
            shootDir.copy(camDir);
        }

        // Hold object floating 3.2m in front of camera along aim vector
        const targetPos = this.camera.position.clone().addScaledVector(shootDir, 3.2);
        obj.mesh.position.lerp(targetPos, 0.25);
        obj.body.position.copy(obj.mesh.position);
        if (!obj.customRotation) {
            obj.mesh.quaternion.copy(this.camera.quaternion);
            obj.body.quaternion.copy(obj.mesh.quaternion);
        }
    }

    /** Apply physical rotation on the active construct object via arrow keys */
    _applyArrowRotation() {
        const obj = this._constructObjects[this._constructObjects.length - 1];
        if (!obj || !obj.body) return;
        if (!obj.fired) {
            let rotated = false;
            if (this.arrowLeft) { obj.mesh.rotateY(-ROTATION_INCREMENT); rotated = true; }
            if (this.arrowRight) { obj.mesh.rotateY(+ROTATION_INCREMENT); rotated = true; }
            if (this.arrowUp) { obj.mesh.rotateX(-ROTATION_INCREMENT); rotated = true; }
            if (this.arrowDown) { obj.mesh.rotateX(+ROTATION_INCREMENT); rotated = true; }
            if (rotated) {
                obj.customRotation = true;
                obj.body.quaternion.copy(obj.mesh.quaternion);
            }
        } else {
            obj.body.wakeUp();
            if (this.arrowLeft) obj.body.angularVelocity.y -= 2.0;
            if (this.arrowRight) obj.body.angularVelocity.y += 2.0;
            if (this.arrowUp) obj.body.angularVelocity.x -= 2.0;
            if (this.arrowDown) obj.body.angularVelocity.x += 2.0;
        }
    }

    // ─── Lifetime & Despawn ───────────────────────────────────────────────────

    _tickObjectLifetime() {
        const now = performance.now();
        for (let i = this._constructObjects.length - 1; i >= 0; i--) {
            const obj = this._constructObjects[i];

            if (obj.fired) {
                // Continuously sync THREE mesh to dynamic physics body every single frame
                obj.mesh.position.copy(obj.body.position);
                obj.mesh.quaternion.copy(obj.body.quaternion);

                // Apply aerodynamic lift during active flight
                if (!obj.body.isRestingOnGround && obj.body.liftFactor && obj.body.liftFactor > 0) {
                    const liftForce = new CANNON.Vec3(0, obj.body.mass * 9.82 * obj.body.liftFactor, 0);
                    obj.body.applyForce(liftForce, obj.body.position);
                }

                // Check if the body has come to rest on the ground/surface
                const speedSq = obj.body.velocity.lengthSquared() + obj.body.angularVelocity.lengthSquared();
                if (!obj.body.isRestingOnGround && speedSq < 0.35 && (now - obj.firedAt > 800)) {
                    obj.body.isRestingOnGround = true;
                    obj.body.liftFactor = 0;
                    // Lock as STATIC so ordinary mecha walking cannot push or budge it!
                    obj.body.type = CANNON.Body.STATIC;
                    obj.body.velocity.set(0, 0, 0);
                    obj.body.angularVelocity.set(0, 0, 0);
                    obj.body.linearDamping = 0.35;
                    obj.body.angularDamping = 0.50;
                }
            }

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
            linewidth: 3,
            transparent: true,
            opacity: 0.95,
            depthTest: false,
            depthWrite: false,
        });
        this._strokeLine = new THREE.Line(this._strokeGeo, mat);
        this._strokeLine.frustumCulled = false; // NEVER cull stroke line in any camera angle!
        this._strokeLine.renderOrder = 9998;
        this._strokeLine.visible = false;
        this.scene.add(this._strokeLine);

        // Glowing vertex markers for crystal-clear visibility across all screens and angles
        const pointMat = new THREE.PointsMaterial({
            color: 0x00ffff,
            size: 9,
            sizeAttenuation: false, // 9 screen-space pixels regardless of distance
            transparent: true,
            opacity: 0.95,
            depthTest: false,
            depthWrite: false,
        });
        this._strokePointsMesh = new THREE.Points(this._strokeGeo, pointMat);
        this._strokePointsMesh.frustumCulled = false; // NEVER cull vertex points in any camera angle!
        this._strokePointsMesh.renderOrder = 9999;
        this._strokePointsMesh.visible = false;
        this.scene.add(this._strokePointsMesh);
    }

    _updateStrokeLine() {
        const pts = this._strokePoints;
        if (pts.length < 1) {
            if (this._strokeLine) this._strokeLine.visible = false;
            if (this._strokePointsMesh) this._strokePointsMesh.visible = false;
            return;
        }

        const posAttr = this._strokeGeo.attributes.position;
        for (let i = 0; i < pts.length && i < MAX_POINTS; i++) {
            posAttr.setXYZ(i, pts[i].x, pts[i].y, pts[i].z);
        }
        posAttr.needsUpdate = true;
        this._strokeGeo.setDrawRange(0, pts.length);
        this._strokeGeo.computeBoundingSphere();
        this._strokeGeo.computeBoundingBox();

        if (pts.length >= 2) {
            this._strokeLine.visible = true;
        } else {
            this._strokeLine.visible = false;
        }
        if (this._strokePointsMesh) this._strokePointsMesh.visible = true;
    }

    _clearStrokeLine() {
        this._strokeGeo?.setDrawRange(0, 0);
        if (this._strokeLine) this._strokeLine.visible = false;
        if (this._strokePointsMesh) this._strokePointsMesh.visible = false;
    }

    // ─── Force Meter HUD ──────────────────────────────────────────────────────

    _showForceMeter() {
        this._autoReleaseFeedbackEnd = null;
        this._autoReleaseFeedbackStart = null;
        if (this._meterMsg) {
            this._meterMsg.classList.add('hidden');
            this._meterMsg.style.display = 'none';
        }
        if (this._meterContainer) {
            this._meterContainer.classList.remove('hidden');
            this._meterContainer.style.display = 'flex';
            this._meterContainer.style.transform = 'translate(0px, 0px)';
        }
        if (this._meterLabel) {
            this._meterLabel.textContent = 'FORCE';
            this._meterLabel.style.color = '#00f2fe';
            this._meterLabel.style.textShadow = '0 0 8px #00f2fe';
        }
        if (this._meterPct) {
            this._meterPct.textContent = '0%';
            this._meterPct.style.color = '#00f2fe';
            this._meterPct.style.textShadow = '0 0 10px #00f2fe';
        }
        if (this._meterFill) {
            this._meterFill.style.height = '0%';
            this._meterFill.style.background = '#00f2fe';
            this._meterFill.style.boxShadow = '0 0 16px rgba(0, 242, 254, 0.9)';
        }
        if (this._meterWrap) {
            this._meterWrap.style.borderColor = 'rgba(0, 242, 254, 0.55)';
            this._meterWrap.style.boxShadow = '0 0 24px rgba(0, 242, 254, 0.25), inset 0 0 10px rgba(0, 0, 0, 0.85)';
        }
    }

    _updateForceMeter(charge) {
        if (this._meterContainer) {
            this._meterContainer.classList.remove('hidden');
            this._meterContainer.style.display = 'flex';
        }

        const pct = Math.round(charge * 100);
        if (this._meterFill) {
            this._meterFill.style.height = `${pct}%`;
        }

        if (charge < 1.0) {
            // Charging phase (< 100% capacity)
            this._fullCapacityStart = null;
            if (this._meterMsg) {
                this._meterMsg.classList.add('hidden');
                this._meterMsg.style.display = 'none';
            }
            if (this._meterContainer) {
                this._meterContainer.style.transform = 'translate(0px, 0px)';
            }

            let r, g, b;
            if (charge < 0.70) {
                // Smooth gradient from cyan (0, 242, 254) to electric gold (255, 200, 0)
                const t = charge / 0.70;
                r = Math.round(0 + 255 * t);
                g = Math.round(242 - 42 * t);
                b = Math.round(254 * (1 - t));
            } else {
                // Almost full (70% - 100%): gradually transitions color to crimson red (255, 16, 32)
                const t = (charge - 0.70) / 0.30;
                r = 255;
                g = Math.round(200 * (1 - t) + 16 * t);
                b = Math.round(0 * (1 - t) + 32 * t);
            }

            if (this._meterFill) {
                this._meterFill.style.background = `rgb(${r},${g},${b})`;
                this._meterFill.style.boxShadow = `0 0 ${12 + charge * 20}px rgba(${r},${g},${b},0.95)`;
            }
            if (this._meterWrap) {
                this._meterWrap.style.borderColor = `rgba(${r},${g},${b},0.65)`;
                this._meterWrap.style.boxShadow = `0 0 24px rgba(${r},${g},${b},0.35), inset 0 0 10px rgba(0,0,0,0.85)`;
            }
            if (this._meterPct) {
                this._meterPct.style.color = `rgb(${r},${g},${b})`;
                this._meterPct.style.textShadow = `0 0 10px rgb(${r},${g},${b})`;
                this._meterPct.textContent = `${pct}%`;
            }
            if (this._meterLabel) {
                this._meterLabel.textContent = 'FORCE';
                this._meterLabel.style.color = `rgb(${r},${g},${b})`;
                this._meterLabel.style.textShadow = `0 0 8px rgb(${r},${g},${b})`;
            }
        } else {
            // 100% Capacity reached!
            if (this._fullCapacityStart === null) {
                this._fullCapacityStart = performance.now();
            }
            const elapsedFull = (performance.now() - this._fullCapacityStart) / 1000.0;

            // In the 5th second of 100% capacity: object is automatically released in aim direction!
            if (elapsedFull >= 5.0) {
                console.log('[ConstructMode] 5 seconds at 100% capacity reached — AUTO-RELEASING in aim direction!');
                if (this._meterContainer) {
                    this._meterContainer.style.transform = 'translate(0px, 0px)';
                }
                this._isMouseDown = false;
                this._chargeStart = null;
                this._fullCapacityStart = null;
                this._charge = 0;
                this._fireWithCharge(1.0, true);
                return;
            }

            // Blinking animation:
            // Starts slow (~2.0 Hz) and smoothly transitions to fast speeding strobe under 3s (~14.0 Hz),
            // and accelerates further up to ~19 Hz into the 5th second auto-shoot!
            const ramp = Math.min(1.0, elapsedFull / 3.0);
            const freq = ramp < 1.0 ? (2.0 + ramp * 12.0) : (14.0 + (elapsedFull - 3.0) * 2.5);

            const phase = (performance.now() / 1000.0) * freq * Math.PI * 2;
            const blinkVal = 0.5 + 0.5 * Math.sin(phase); // oscillates 0.0 to 1.0
            const alpha = 0.20 + 0.80 * blinkVal;

            // Vibration:
            // "when the force meter is red and after 2 sec also make the meter viberate along with raising blinking speed."
            if (elapsedFull >= 2.0 && this._meterContainer) {
                // Vibration intensity escalates from 2.0s to 5.0s
                const tVib = Math.min(1.0, (elapsedFull - 2.0) / 3.0);
                const vibAmp = 2.0 + tVib * 5.5; // 2.0px up to 7.5px vibration amplitude
                const jitterX = (Math.random() - 0.5) * 2.0 * vibAmp;
                const jitterY = (Math.random() - 0.5) * 2.0 * vibAmp;
                this._meterContainer.style.transform = `translate(${jitterX.toFixed(1)}px, ${jitterY.toFixed(1)}px)`;
            } else if (this._meterContainer) {
                this._meterContainer.style.transform = 'translate(0px, 0px)';
            }

            if (this._meterFill) {
                this._meterFill.style.background = `rgba(255, 16, 32, ${alpha})`;
                this._meterFill.style.boxShadow = `0 0 ${16 + blinkVal * 28}px rgba(255, 20, 40, ${alpha})`;
            }
            if (this._meterWrap) {
                this._meterWrap.style.borderColor = `rgba(255, 30, 50, ${0.4 + 0.6 * blinkVal})`;
                this._meterWrap.style.boxShadow = `0 0 ${20 + blinkVal * 30}px rgba(255, 20, 40, ${0.35 + 0.55 * blinkVal}), inset 0 0 10px rgba(0,0,0,0.85)`;
            }
            if (this._meterPct) {
                this._meterPct.style.color = `rgba(255, 60, 70, ${0.7 + 0.3 * blinkVal})`;
                this._meterPct.style.textShadow = `0 0 14px rgba(255, 30, 50, ${alpha})`;
                this._meterPct.textContent = '100%';
            }
            if (this._meterLabel) {
                const countdown = Math.max(0, 5.0 - elapsedFull).toFixed(1);
                this._meterLabel.textContent = `AUTO: ${countdown}s`;
                this._meterLabel.style.color = `rgba(255, 80, 80, ${0.7 + 0.3 * blinkVal})`;
            }
        }
    }

    /**
     * Yellow blinking feedback when 3D object is auto-released after meter vibration.
     * Displays message 'RELEASED' above '100+' sign while pulsing yellow strobe for 1.5 seconds.
     */
    _startAutoReleaseFeedback() {
        this._autoReleaseFeedbackStart = performance.now();
        this._autoReleaseFeedbackEnd = performance.now() + 1500; // 1.5 seconds yellow feedback

        if (this._meterContainer) {
            this._meterContainer.classList.remove('hidden');
            this._meterContainer.style.display = 'flex';
            this._meterContainer.style.transform = 'translate(0px, 0px)';
        }
        if (this._meterMsg) {
            this._meterMsg.classList.remove('hidden');
            this._meterMsg.style.display = 'block';
            this._meterMsg.textContent = 'RELEASED';
        }
        if (this._meterPct) {
            this._meterPct.textContent = '100+';
        }
        if (this._meterLabel) {
            this._meterLabel.textContent = 'AUTO-FIRED';
        }
        if (this._meterFill) {
            this._meterFill.style.height = '100%';
        }
        this._tickAutoReleaseFeedback();
    }

    _tickAutoReleaseFeedback() {
        if (this._autoReleaseFeedbackEnd === null) return;

        const now = performance.now();
        if (now >= this._autoReleaseFeedbackEnd) {
            this._autoReleaseFeedbackEnd = null;
            this._hideForceMeter();
            return;
        }

        // Fast yellow strobe blinking (~7.0 Hz)
        const t = (now - this._autoReleaseFeedbackStart) / 1000.0;
        const blinkPhase = Math.sin(t * 7.0 * Math.PI * 2);
        const blinkVal = 0.5 + 0.5 * blinkPhase; // 0.0 to 1.0
        const alpha = 0.25 + 0.75 * blinkVal;

        // Vivid sci-fi yellow / amber strobe palette
        const yellowColor = `rgba(255, 238, 0, ${alpha})`;
        const yellowSolid = '#ffee00';

        if (this._meterMsg) {
            this._meterMsg.classList.remove('hidden');
            this._meterMsg.style.display = 'block';
            this._meterMsg.textContent = 'RELEASED';
            this._meterMsg.style.color = yellowColor;
            this._meterMsg.style.textShadow = `0 0 ${10 + blinkVal * 15}px ${yellowSolid}, 0 0 ${20 + blinkVal * 20}px rgba(255, 187, 0, ${alpha})`;
        }

        if (this._meterPct) {
            this._meterPct.textContent = '100+';
            this._meterPct.style.color = yellowColor;
            this._meterPct.style.textShadow = `0 0 ${12 + blinkVal * 14}px ${yellowSolid}`;
        }

        if (this._meterFill) {
            this._meterFill.style.height = '100%';
            this._meterFill.style.background = yellowColor;
            this._meterFill.style.boxShadow = `0 0 ${16 + blinkVal * 24}px rgba(255, 238, 0, ${alpha})`;
        }

        if (this._meterWrap) {
            this._meterWrap.style.borderColor = `rgba(255, 238, 0, ${0.45 + 0.55 * blinkVal})`;
            this._meterWrap.style.boxShadow = `0 0 ${20 + blinkVal * 25}px rgba(255, 238, 0, ${0.35 + 0.55 * blinkVal}), inset 0 0 10px rgba(0,0,0,0.85)`;
        }

        if (this._meterLabel) {
            this._meterLabel.textContent = 'AUTO-FIRED';
            this._meterLabel.style.color = yellowColor;
            this._meterLabel.style.textShadow = `0 0 8px ${yellowSolid}`;
        }
    }

    _hideForceMeter() {
        this._fullCapacityStart = null;
        this._autoReleaseFeedbackEnd = null;
        this._autoReleaseFeedbackStart = null;
        if (this._meterMsg) {
            this._meterMsg.classList.add('hidden');
            this._meterMsg.style.display = 'none';
        }
        if (this._meterContainer) {
            this._meterContainer.classList.add('hidden');
            this._meterContainer.style.display = 'none';
            this._meterContainer.style.transform = 'translate(0px, 0px)';
        }
        if (this._meterWrap) {
            this._meterWrap.style.borderColor = 'rgba(0, 242, 254, 0.55)';
            this._meterWrap.style.boxShadow = '0 0 24px rgba(0, 242, 254, 0.25), inset 0 0 10px rgba(0, 0, 0, 0.85)';
        }
        if (this._meterLabel) {
            this._meterLabel.textContent = 'FORCE';
            this._meterLabel.style.color = '#00f2fe';
            this._meterLabel.style.textShadow = '0 0 8px #00f2fe';
        }
        if (this._meterPct) {
            this._meterPct.style.color = '#00f2fe';
            this._meterPct.style.textShadow = '0 0 10px #00f2fe';
            this._meterPct.textContent = '0%';
        }
        if (this._meterFill) {
            this._meterFill.style.height = '0%';
            this._meterFill.style.background = '#00f2fe';
            this._meterFill.style.boxShadow = '0 0 16px rgba(0, 242, 254, 0.9)';
        }
    }

    // ─── Points / State HUD ───────────────────────────────────────────────────

    _updateHUD() {
        if (!this._hudPoints) return;
        const labels = {
            [STATES.IDLE]: '✋ IDLE — Point right index to draw in 3D',
            [STATES.DRAWING]: '✏️ DRAWING — Hold left fist 0.4s to commit 3D physics object',
            [STATES.OBJECT_READY]: '🟦 PREPARING 3D OBJECT...',
            [STATES.AIMING]: '🎯 AIMING — Hold LMB to charge throw force, release to launch!',
            [STATES.FIRED]: '🚀 3D OBJECT LAUNCHED',
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
