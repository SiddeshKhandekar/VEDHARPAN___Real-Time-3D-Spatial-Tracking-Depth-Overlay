import * as THREE from 'three';
import * as CANNON from 'cannon-es';

/**
 * ConstructMode — Mode 4 Hand-Drawing to 3D Object Firing System
 *
 * Full state machine lifecycle:
 *   IDLE → DRAWING → LOCKED → CONVERTING → OBJECT_READY → HEAD_AIMING → FIRED/PLACED → COOLDOWN
 *
 * Left hand controls:
 *   - Fist  → Lock current stroke / re-enter drawing after object exists
 *   - Open  → Convert locked stroke to 3D extruded object
 *
 * Right hand (pointing):
 *   - Index fingertip tracked in 3D viewport space as drawing input
 *
 * Point budget: 100 points shared across all objects per activation cycle.
 */

// ─── Constants ──────────────────────────────────────────────────────────────
const STATES = Object.freeze({
    IDLE: 'IDLE',
    DRAWING: 'DRAWING',
    LOCKED: 'LOCKED',
    CONVERTING: 'CONVERTING',
    OBJECT_READY: 'OBJECT_READY',
    HEAD_AIMING: 'HEAD_AIMING',
    PLACEMENT: 'PLACEMENT',
    FIRED: 'FIRED',
    COOLDOWN: 'COOLDOWN',
});

const MAX_POINTS = 100;            // Total drawing budget per cycle
const COOLDOWN_MS = 300_000;        // 5 minutes
const LIFETIME_MS = 300_000;        // 5 minutes alive after fire/place
const DESPAWN_ALTITUDE = -300;           // Auto-despawn threshold (world units)
const FIST_CONFIRM_FRAMES = 5;          // Frames fist must hold before locking

// Head-aiming config
const HEAD_DEAD_ZONE = 0.15;           // ±15 % of normalised range
const HEAD_SENSITIVITY = 1.5;           // radians / second at frame edge

// Drawing plane config (meters in front of mecha)
const DRAW_PLANE_DEPTH = -2.5;

// Arrow key rotation increment (radians per frame)
const ROTATION_INCREMENT = (5 * Math.PI) / 180;

// ─── Douglas-Peucker Path Simplification ────────────────────────────────────
function perpendicularDistance(point, lineStart, lineEnd) {
    const dx = lineEnd.x - lineStart.x;
    const dy = lineEnd.y - lineStart.y;
    const mag = Math.sqrt(dx * dx + dy * dy);
    if (mag === 0) return point.distanceTo(lineStart);
    return Math.abs(dx * (lineStart.y - point.y) - (lineStart.x - point.x) * dy) / mag;
}

function douglasPeucker(points, epsilon) {
    if (points.length <= 2) return points;
    let maxDist = 0;
    let maxIdx = 0;
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

// ─── Main Class ─────────────────────────────────────────────────────────────
export class ConstructMode {
    /**
     * @param {THREE.Scene}    scene
     * @param {PhysicsWorld}   physicsWorld
     * @param {THREE.Camera}   camera
     */
    constructor(scene, physicsWorld, camera) {
        this.scene = scene;
        this.physicsWorld = physicsWorld;
        this.camera = camera;

        // State
        this.state = STATES.IDLE;
        this.active = false;  // true when fireMode === 4

        // Drawing budget
        this.pointsRemaining = MAX_POINTS;

        // Raw stroke points in normalised tip coords (accumulated per-frame)
        this._strokePoints = [];          // current stroke: [{x,y,z}]
        this._fistFrameCount = 0;

        // Head telemetry (latest)
        this._latestHead = null;

        // Arrow key states (set by InputManager)
        this.arrowLeft = false;
        this.arrowRight = false;
        this.arrowUp = false;
        this.arrowDown = false;

        // Orbit yaw/pitch for head-based aiming (written back to scene)
        this._orbitYawRef = null;   // { value: number } passed from scene
        this._orbitPitchRef = null;

        // THREE objects
        this._strokeLine = null;   // THREE.Line for live stroke
        this._strokeGeo = null;
        this._constructObjects = [];   // array of { mesh, body, timeout }

        // HUD element
        this._hudPoints = document.getElementById('construct-points');

        // Cooldown
        this._cooldownEnd = 0;

        // Gesture debounce (left hand)
        this._prevLeftGesture = 'none';
        this._prevRightGesture = 'none';

        // Build the live-stroke line geometry
        this._initStrokeLine();

        console.log('[ConstructMode] Initialised');
    }

    // ─── Lifecycle ────────────────────────────────────────────────────────────

    /** Called by scene when fireMode changes to 4 */
    activate() {
        if (this.active) return;
        this.active = true;
        this.state = STATES.IDLE;
        this.pointsRemaining = MAX_POINTS;
        this._strokePoints = [];
        this._fistFrameCount = 0;
        this._updateHUD();
        console.log('[ConstructMode] Activated');
    }

    /** Called by scene when fireMode changes away from 4 */
    deactivate() {
        this.active = false;
        this._clearStrokeLine();
        this.state = STATES.IDLE;
        this._hideHUD();
        console.log('[ConstructMode] Deactivated');
    }

    /**
     * Bind orbit yaw/pitch references so head-aim can drive the camera.
     * Pass objects of form { value: number } that scene.js reads.
     */
    bindOrbitRefs(yawRef, pitchRef) {
        this._orbitYawRef = yawRef;
        this._orbitPitchRef = pitchRef;
    }

    // ─── Telemetry Entry Point ────────────────────────────────────────────────

    /**
     * Called every WebSocket message with fresh telemetry data.
     * @param {Array}  hands   - array of hand objects from telemetry
     * @param {Object} head    - {x, y, z} head spatial vector
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
        const rightGesture = rightHand ? rightHand.gesture : 'none';

        this._processRightHand(rightHand, rightGesture);
        this._processLeftHand(leftHand, leftGesture);

        this._prevLeftGesture = leftGesture;
        this._prevRightGesture = rightGesture;
    }

    // ─── Per-Frame Update ─────────────────────────────────────────────────────

    /**
     * Main update — called every animation frame from scene.js.
     * @param {number} dt  delta-time in seconds
     */
    update(dt) {
        if (!this.active) {
            // Still check lifetime/altitude for already-fired objects
            this._tickObjectLifetime();
            return;
        }

        // Head-aiming drives orbit yaw/pitch
        if (this.state === STATES.HEAD_AIMING && this._latestHead) {
            this._applyHeadAim(dt);
        }

        // Arrow-key rotation in PLACEMENT mode
        if (this.state === STATES.PLACEMENT) {
            this._applyArrowRotation();
        }

        // Always check altitude of live physics objects
        this._tickObjectLifetime();
    }

    // ─── Public Actions ───────────────────────────────────────────────────────

    /**
     * Called by MechaController when fireMode=4 and left-click fires.
     * Returns true if the shot was consumed, false if not ready.
     */
    fire() {
        if (this.state !== STATES.HEAD_AIMING && this.state !== STATES.PLACEMENT) {
            return false;
        }

        const obj = this._constructObjects.find(o => !o.fired && !o.placed);
        if (!obj) return false;

        // Apply velocity in camera forward direction
        const direction = new THREE.Vector3();
        this.camera.getWorldDirection(direction);
        const speed = 12;
        obj.body.velocity.set(
            direction.x * speed,
            direction.y * speed,
            direction.z * speed
        );
        obj.fired = true;

        // Start 5-min lifetime timer
        obj.timeout = setTimeout(() => this._despawnObject(obj), LIFETIME_MS);

        this.state = STATES.FIRED;
        this._enterCooldown();
        return true;
    }

    /**
     * Place current object as static body at its current position.
     * Called when left fist closes during PLACEMENT state.
     */
    placeObject() {
        const obj = this._constructObjects.find(o => !o.fired && !o.placed);
        if (!obj) return;

        obj.body.mass = 0;
        obj.body.updateMassProperties();
        obj.body.velocity.set(0, 0, 0);
        obj.placed = true;

        clearTimeout(obj.timeout);
        obj.timeout = setTimeout(() => this._despawnObject(obj), LIFETIME_MS);

        this.state = STATES.FIRED;
        this._enterCooldown();
    }

    /**
     * Called when InputManager detects left-click during HEAD_AIMING state.
     * Alias to fire() for direct binding.
     */
    onFireClick() {
        return this.fire();
    }

    // ─── State: Drawing ───────────────────────────────────────────────────────

    _processRightHand(rightHand, gesture) {
        const canDraw = this.state === STATES.DRAWING || this.state === STATES.IDLE;

        if (gesture === 'point' && rightHand && rightHand.index_tip) {
            if (this.pointsRemaining <= 0) return;

            // Transition to DRAWING on first point
            if (this.state === STATES.IDLE || this.state === STATES.OBJECT_READY) {
                this.state = STATES.DRAWING;
            }

            if (this.state === STATES.DRAWING) {
                this._addStrokePoint(rightHand.index_tip);
            }
        } else if (gesture !== 'point' && this._prevRightGesture === 'point') {
            // Finger lifted — current stroke segment end
            // (Next point gesture will start a new stroke or continue the path)
        }
    }

    _addStrokePoint(indexTip) {
        // Map normalised tip coords to a point on the drawing plane in world space.
        // The plane sits DRAW_PLANE_DEPTH meters along the camera's local -Z axis.
        const ndcX = indexTip.x;   // already normalised [-1, 1]
        const ndcY = indexTip.y;

        // Un-project via camera to a plane in front of the mecha
        const vec = new THREE.Vector3(ndcX, ndcY, 0.5);
        vec.unproject(this.camera);
        const dir = vec.sub(this.camera.position).normalize();

        // Intersect with a plane DRAW_PLANE_DEPTH units in camera-forward space
        const camForward = new THREE.Vector3();
        this.camera.getWorldDirection(camForward);
        const planeOrigin = this.camera.position.clone().addScaledVector(camForward, Math.abs(DRAW_PLANE_DEPTH));
        const planeNormal = camForward.clone().negate();

        const denom = planeNormal.dot(dir);
        let worldPoint;
        if (Math.abs(denom) > 1e-6) {
            const t = planeNormal.dot(planeOrigin.clone().sub(this.camera.position)) / denom;
            worldPoint = this.camera.position.clone().addScaledVector(dir, t);
        } else {
            // Fallback: fixed depth
            worldPoint = this.camera.position.clone().addScaledVector(dir, 3.0);
        }

        this._strokePoints.push(worldPoint);
        this.pointsRemaining = Math.max(0, this.pointsRemaining - 1);
        this._updateStrokeLine();
        this._updateHUD();
    }

    // ─── State: Fist Lock / Convert ───────────────────────────────────────────

    _processLeftHand(leftHand, gesture) {
        const prevGesture = this._prevLeftGesture;

        if (gesture === 'fist') {
            this._fistFrameCount++;

            // Stable fist for N frames → lock drawing
            if (this._fistFrameCount >= FIST_CONFIRM_FRAMES) {
                if (this.state === STATES.DRAWING) {
                    this.state = STATES.LOCKED;
                    console.log('[ConstructMode] Drawing LOCKED');
                }
                // In PLACEMENT state, fist-close triggers place
                if (this.state === STATES.PLACEMENT) {
                    this.placeObject();
                }
            }
        } else {
            this._fistFrameCount = 0;

            // Fist → Open transition: convert stroke to 3D object
            if (prevGesture === 'fist' && gesture === 'open') {
                if (this.state === STATES.LOCKED && this._strokePoints.length >= 3) {
                    this._convertStrokeTo3D();
                }
            }

            // Open hand while OBJECT_READY → go to HEAD_AIMING
            if (gesture === 'open' && this.state === STATES.OBJECT_READY) {
                this.state = STATES.HEAD_AIMING;
                console.log('[ConstructMode] STATE: HEAD_AIMING');
            }
        }
    }

    // ─── 3D Conversion ────────────────────────────────────────────────────────

    _convertStrokeTo3D() {
        this.state = STATES.CONVERTING;
        console.log('[ConstructMode] Converting stroke to 3D...', this._strokePoints.length, 'pts');

        // 1. Project all world points onto a local 2D plane for shape building
        const points3D = this._strokePoints;
        if (points3D.length < 3) {
            this.state = STATES.DRAWING;
            return;
        }

        // Build a local coordinate frame from the stroke's centroid and camera orientation
        const centroid = new THREE.Vector3();
        points3D.forEach(p => centroid.add(p));
        centroid.divideScalar(points3D.length);

        const camForward = new THREE.Vector3();
        this.camera.getWorldDirection(camForward);
        const planeNormal = camForward.clone().negate(); // plane faces camera
        const planeRight = new THREE.Vector3(1, 0, 0);
        const planeUp = new THREE.Vector3().crossVectors(planeNormal, planeRight).normalize();

        // Project each world point to local 2D coords
        const pts2D = points3D.map(p => {
            const rel = p.clone().sub(centroid);
            return new THREE.Vector2(rel.dot(planeRight), rel.dot(planeUp));
        });

        // 2. Simplify using Douglas-Peucker
        const simplified = douglasPeucker(pts2D, 0.03);

        // 3. Build THREE.Shape from simplified 2D points
        const shape = new THREE.Shape();
        shape.moveTo(simplified[0].x, simplified[0].y);
        for (let i = 1; i < simplified.length; i++) {
            shape.lineTo(simplified[i].x, simplified[i].y);
        }
        shape.closePath();

        // 4. Determine extrude depth proportional to bounding box
        const box = new THREE.Box2();
        simplified.forEach(p => box.expandByPoint(p));
        const size = new THREE.Vector2();
        box.getSize(size);
        const extrudeDepth = Math.max(0.15, Math.min((size.x + size.y) * 0.25, 1.5));

        const extrudeSettings = {
            depth: extrudeDepth,
            bevelEnabled: true,
            bevelThickness: 0.04,
            bevelSize: 0.03,
            bevelSegments: 2,
        };

        const geometry = new THREE.ExtrudeGeometry(shape, extrudeSettings);
        geometry.computeBoundingBox();
        geometry.center(); // centre at local origin

        // 5. Translucent glass-like material
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

        // Orient mesh to face the camera (align flat face toward viewer)
        const euler = new THREE.Euler(0, 0, 0, 'YXZ');
        const camQuat = this.camera.quaternion.clone();
        mesh.quaternion.copy(camQuat);

        // Place at centroid
        mesh.position.copy(centroid);
        this.scene.add(mesh);

        // 6. Build Cannon.js ConvexPolyhedron from geometry vertices
        const posArr = geometry.attributes.position.array;
        const cannonVerts = [];
        const uniqueMap = new Map();
        for (let i = 0; i < posArr.length; i += 3) {
            const key = `${posArr[i].toFixed(3)}_${posArr[i + 1].toFixed(3)}_${posArr[i + 2].toFixed(3)}`;
            if (!uniqueMap.has(key)) {
                uniqueMap.set(key, cannonVerts.length);
                cannonVerts.push(new CANNON.Vec3(posArr[i], posArr[i + 1], posArr[i + 2]));
            }
        }

        // Build face list — every 3 position indices form a triangle
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
                const shape = new CANNON.ConvexPolyhedron({ vertices: cannonVerts, faces: cannonFaces });
                body = new CANNON.Body({ mass: 5, shape });
            } catch (e) {
                console.warn('[ConstructMode] ConvexPolyhedron fallback to Box:', e.message);
            }
        }

        if (!body) {
            // Fallback to box matching bounding box
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
        body.collisionFilterGroup = 2;  // projectile group
        body.collisionFilterMask = 1;  // collide with environment

        // Keep body kinematic until fired
        body.type = CANNON.Body.KINEMATIC;
        body.velocity.set(0, 0, 0);

        this.physicsWorld.world.addBody(body);

        // Register sync between mesh and body
        const obj = { mesh, body, fired: false, placed: false, timeout: null };
        this._constructObjects.push(obj);

        // Clear stroke line
        this._clearStrokeLine();
        this._strokePoints = [];

        this.state = STATES.OBJECT_READY;
        console.log('[ConstructMode] 3D object ready. State: OBJECT_READY');

        // If budget allows, allow more drawing
        if (this.pointsRemaining > 0) {
            console.log(`[ConstructMode] ${this.pointsRemaining} points remaining for next object`);
        }
    }

    // ─── Head Aiming ─────────────────────────────────────────────────────────

    _applyHeadAim(dt) {
        if (!this._latestHead || !this._orbitYawRef || !this._orbitPitchRef) return;

        const hx = this._latestHead.x;
        const hy = this._latestHead.y;

        if (Math.abs(hx) > HEAD_DEAD_ZONE) {
            const delta = Math.sign(hx) * (Math.abs(hx) - HEAD_DEAD_ZONE) * HEAD_SENSITIVITY * dt;
            this._orbitYawRef.value += delta;
        }
        if (Math.abs(hy) > HEAD_DEAD_ZONE) {
            // Inverted: head up → aim down
            const delta = Math.sign(hy) * (Math.abs(hy) - HEAD_DEAD_ZONE) * HEAD_SENSITIVITY * dt;
            this._orbitPitchRef.value -= delta;
            // Clamp pitch
            this._orbitPitchRef.value = Math.max(-1.2, Math.min(1.2, this._orbitPitchRef.value));
        }

        // Sync pending construct object position to mecha + camera forward
        this._syncObjectToAim();
    }

    _syncObjectToAim() {
        const obj = this._constructObjects.find(o => !o.fired && !o.placed);
        if (!obj) return;

        const dir = new THREE.Vector3();
        this.camera.getWorldDirection(dir);

        const targetPos = this.camera.position.clone().addScaledVector(dir, 4.0);
        obj.mesh.position.lerp(targetPos, 0.12);
        obj.body.position.copy(obj.mesh.position);
    }

    // ─── Placement (Arrow Keys) ───────────────────────────────────────────────

    _applyArrowRotation() {
        const obj = this._constructObjects.find(o => !o.fired && !o.placed);
        if (!obj) return;

        if (this.arrowLeft) obj.mesh.rotateY(-ROTATION_INCREMENT);
        if (this.arrowRight) obj.mesh.rotateY(+ROTATION_INCREMENT);
        if (this.arrowUp) obj.mesh.rotateX(-ROTATION_INCREMENT);
        if (this.arrowDown) obj.mesh.rotateX(+ROTATION_INCREMENT);

        obj.body.quaternion.copy(obj.mesh.quaternion);
    }

    // ─── Lifetime & Altitude ─────────────────────────────────────────────────

    _tickObjectLifetime() {
        for (const obj of this._constructObjects) {
            if (obj.fired && !obj.placed) {
                // Sync mesh to physics body
                obj.mesh.position.copy(obj.body.position);
                obj.mesh.quaternion.copy(obj.body.quaternion);

                // Unfreeze kinematic on fired objects
                if (obj.body.type === CANNON.Body.KINEMATIC) {
                    obj.body.type = CANNON.Body.DYNAMIC;
                    obj.body.updateMassProperties();
                }

                // Check altitude
                if (obj.body.position.y < DESPAWN_ALTITUDE) {
                    this._despawnObject(obj);
                }
            }
        }
    }

    _despawnObject(obj) {
        clearTimeout(obj.timeout);
        this.scene.remove(obj.mesh);
        if (obj.body.world) {
            this.physicsWorld.world.removeBody(obj.body);
        }
        const idx = this._constructObjects.indexOf(obj);
        if (idx !== -1) this._constructObjects.splice(idx, 1);

        // If all objects gone, check cooldown
        const remainingActive = this._constructObjects.filter(o => !o.placed);
        if (remainingActive.length === 0 && this.state === STATES.FIRED) {
            this._enterCooldown();
        }
    }

    // ─── Cooldown ─────────────────────────────────────────────────────────────

    _enterCooldown() {
        this.state = STATES.COOLDOWN;
        this._cooldownEnd = performance.now() + COOLDOWN_MS;
        console.log('[ConstructMode] Cooldown started — 5 minutes');

        setTimeout(() => {
            this._resetCycle();
        }, COOLDOWN_MS);
    }

    _resetCycle() {
        this.state = STATES.IDLE;
        this.pointsRemaining = MAX_POINTS;
        this._strokePoints = [];
        this._fistFrameCount = 0;
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

    // ─── HUD ──────────────────────────────────────────────────────────────────

    _updateHUD() {
        if (!this._hudPoints) return;
        this._hudPoints.textContent = `POINTS: ${this.pointsRemaining}/${MAX_POINTS}`;
        this._hudPoints.classList.remove('hidden');
    }

    _hideHUD() {
        if (!this._hudPoints) return;
        this._hudPoints.classList.add('hidden');
    }
}
