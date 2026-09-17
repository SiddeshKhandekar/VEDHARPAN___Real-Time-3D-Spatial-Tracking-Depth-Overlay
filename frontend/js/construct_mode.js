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
const COOLDOWN_MS = 300_000;   // 5 minutes cooldown
const LIFETIME_MS = 300_000;   // Spawned object lives 5 min
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

        // Gesture tracking
        this._prevLeftGesture = 'none';

        this._initStrokeLine();
        console.log('[ConstructMode] Initialised');
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
        if (this.state === STATES.AIMING && this._latestHead) {
            this._applyHeadAim(dt);
            this._syncObjectToAim();
        }

        // Arrow-key rotation of the pending object
        if (this.state === STATES.AIMING) {
            this._applyArrowRotation();
        }

        // Force meter charging (poll live mouse state every frame)
        if (this.state === STATES.AIMING && this._input) {
            const lmb = this._input.mouseState?.left ?? false;

            if (lmb) {
                // Button is held — accumulate charge
                if (this._chargeStart === null) {
                    this._chargeStart = performance.now();
                }
                this._charge = Math.min(
                    (performance.now() - this._chargeStart) / CHARGE_MAX_MS,
                    1.0
                );
                this._updateForceMeter(this._charge);
            } else if (this._chargeStart !== null) {
                // Button just released — fire!
                this._fireWithCharge(this._charge);
                this._chargeStart = null;
                this._charge = 0;
                this._hideForceMeter();
            }
        }
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
        const planeOrigin = this.camera.position.clone()
            .addScaledVector(camForward, DRAW_PLANE_DEPTH);
        const planeNormal = camForward.clone().negate();

        let worldPoint;
        const denom = planeNormal.dot(dir);
        if (Math.abs(denom) > 1e-6) {
            const t = planeNormal.dot(planeOrigin.clone().sub(this.camera.position)) / denom;
            worldPoint = this.camera.position.clone().addScaledVector(dir, t);
        } else {
            worldPoint = this.camera.position.clone().addScaledVector(dir, 3.0);
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

            if (held >= FIST_HOLD_MS && this.state === STATES.DRAWING) {
                if (this._strokePoints.length >= 3) {
                    this._convertStrokeTo3D();  // transitions to OBJECT_READY → AIMING
                } else {
                    console.warn('[ConstructMode] Fist locked but stroke too short (< 3 points) — keep drawing');
                }
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

        // Build Cannon.js body
        const posArr = geometry.attributes.position.array;
        const uniqueMap = new Map();
        const cannonVerts = [];
        for (let i = 0; i < posArr.length; i += 3) {
            const key = `${posArr[i].toFixed(3)}_${posArr[i + 1].toFixed(3)}_${posArr[i + 2].toFixed(3)}`;
            if (!uniqueMap.has(key)) {
                uniqueMap.set(key, cannonVerts.length);
                cannonVerts.push(new CANNON.Vec3(posArr[i], posArr[i + 1], posArr[i + 2]));
            }
        }
        const cannonFaces = [];
        const idx = geometry.index ? geometry.index.array : null;
        if (idx) {
            for (let i = 0; i < idx.length; i += 3) {
                const verts = [idx[i], idx[i + 1], idx[i + 2]].map(vi => {
                    const key = `${posArr[vi * 3].toFixed(3)}_${posArr[vi * 3 + 1].toFixed(3)}_${posArr[vi * 3 + 2].toFixed(3)}`;
                    return uniqueMap.get(key);
                });
                if (new Set(verts).size === 3) cannonFaces.push(verts);
            }
        }

        let body;
        if (cannonFaces.length > 0 && cannonVerts.length >= 4) {
            try {
                const cs = new CANNON.ConvexPolyhedron({ vertices: cannonVerts, faces: cannonFaces });
                body = new CANNON.Body({ mass: 5, shape: cs });
            } catch (e) {
                console.warn('[ConstructMode] ConvexPolyhedron fallback:', e.message);
            }
        }
        if (!body) {
            geometry.computeBoundingBox();
            const bb = geometry.boundingBox;
            const hw = (bb.max.x - bb.min.x) / 2;
            const hh = (bb.max.y - bb.min.y) / 2;
            const hd = (bb.max.z - bb.min.z) / 2;
            body = new CANNON.Body({ mass: 5, shape: new CANNON.Box(new CANNON.Vec3(hw, hh, hd)) });
        }

        body.position.copy(mesh.position);
        body.quaternion.copy(mesh.quaternion);
        body.linearDamping = 0.1;
        body.angularDamping = 0.4;
        body.collisionFilterGroup = 2;
        body.collisionFilterMask = 1;
        body.type = CANNON.Body.KINEMATIC;  // stays frozen until fired
        body.velocity.set(0, 0, 0);
        this.physicsWorld.world.addBody(body);

        this._constructObjects.push({ mesh, body, fired: false, timeout: null });

        // Clear the drawn stroke
        this._clearStrokeLine();
        this._strokePoints = [];

        // Auto-enter AIMING
        this.state = STATES.AIMING;
        this._updateHUD();
        console.log('[ConstructMode] Object ready — STATE: AIMING');
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
        obj.body.velocity.set(dir.x * speed, dir.y * speed, dir.z * speed);
        obj.fired = true;
        obj.timeout = setTimeout(() => this._despawnObject(obj), LIFETIME_MS);

        this.state = STATES.FIRED;
        this._updateHUD();
        this._enterCooldown();
        console.log(`[ConstructMode] FIRED — speed ${speed.toFixed(1)} u/s (charge ${(charge * 100).toFixed(0)}%)`);
    }

    /** Legacy hook kept so MechaController's fire() call is a no-op in Mode 4 */
    fire() { return false; }

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
        const dir = new THREE.Vector3();
        this.camera.getWorldDirection(dir);
        const targetPos = this.camera.position.clone().addScaledVector(dir, 4.0);
        obj.mesh.position.lerp(targetPos, 0.12);
        obj.body.position.copy(obj.mesh.position);
    }

    _applyArrowRotation() {
        const obj = this._constructObjects.find(o => !o.fired);
        if (!obj) return;
        if (this.arrowLeft) obj.mesh.rotateY(-ROTATION_INCREMENT);
        if (this.arrowRight) obj.mesh.rotateY(+ROTATION_INCREMENT);
        if (this.arrowUp) obj.mesh.rotateX(-ROTATION_INCREMENT);
        if (this.arrowDown) obj.mesh.rotateX(+ROTATION_INCREMENT);
        obj.body.quaternion.copy(obj.mesh.quaternion);
    }

    // ─── Lifetime & Despawn ───────────────────────────────────────────────────

    _tickObjectLifetime() {
        for (const obj of this._constructObjects) {
            if (obj.fired) {
                obj.mesh.position.copy(obj.body.position);
                obj.mesh.quaternion.copy(obj.body.quaternion);
                if (obj.body.type === CANNON.Body.KINEMATIC) {
                    obj.body.type = CANNON.Body.DYNAMIC;
                    obj.body.updateMassProperties();
                }
                if (obj.body.position.y < DESPAWN_ALT) {
                    this._despawnObject(obj);
                }
            }
        }
    }

    _despawnObject(obj) {
        clearTimeout(obj.timeout);
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
        console.log('[ConstructMode] Cooldown — 5 minutes');
        setTimeout(() => this._resetCycle(), COOLDOWN_MS);
    }

    _resetCycle() {
        this.state = STATES.IDLE;
        this.pointsRemaining = MAX_POINTS;
        this._strokePoints = [];
        this._fistStart = null;
        this._constructObjects = [];
        this._clearStrokeLine();
        this._updateHUD();
        console.log('[ConstructMode] Ready — cooldown over');
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
            [STATES.IDLE]: '✋ IDLE — Point right index to draw',
            [STATES.DRAWING]: '✏️ DRAWING — Hold left fist 0.4s to extrude',
            [STATES.OBJECT_READY]: '🟦 EXTRUDING...',
            [STATES.AIMING]: '🎯 AIMING — Hold LMB to charge, release to fire',
            [STATES.FIRED]: '🚀 FIRED',
            [STATES.COOLDOWN]: '⏳ COOLDOWN — 5 min recharge',
        };
        const label = labels[this.state] || this.state;
        this._hudPoints.innerHTML =
            `<span style="font-size:0.75rem;opacity:0.75">${label}</span>` +
            `<br>POINTS: ${this.pointsRemaining}/${MAX_POINTS}`;
        this._hudPoints.classList.remove('hidden');
    }

    _hideHUD() {
        this._hudPoints?.classList.add('hidden');
    }
}
