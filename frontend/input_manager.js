import * as THREE from 'three';

export class InputManager {
    constructor(camera, domElement) {
        this.camera = camera;
        this.domElement = domElement;

        // ── Default game-action → pressed state ──────────────────────────────
        // These are resolved by the action map below, not raw keys.
        this.actionState = {
            moveForward: false,
            moveBackward: false,
            moveLeft: false,
            moveRight: false,
            jump: false,
        };

        // Legacy alias kept so MechaController (which reads `this.keys`) still works.
        // We keep it in sync with actionState getters via a Proxy-like approach.
        this.keys = {
            'w': false,
            'a': false,
            's': false,
            'd': false,
            ' ': false,
        };

        this.mouseState = {
            left: false,
            right: false
        };

        this.mousePos = new THREE.Vector2();

        // Final unified state for the controller
        this.aimActive = false;
        this.isShooting = false;
        this.aimTarget = new THREE.Vector3();
        this.fireMode = 1; // 1=Plasma, 2=Rapid, 3=Missile, 4=Grenade

        // Gesture overrides
        this.gestureAimActive = false;
        this.gestureShootActive = false;
        this.gestureAimTarget = new THREE.Vector3();

        this.raycaster = new THREE.Raycaster();

        // Edge-detection: true only on the frame the button is first pressed
        this._mouseJustPressed = false;

        /**
         * keyToAction: lowercased key → actionId
         * Managed by SettingsManager.applyToInputManager().
         * Initialised here with defaults (mirrors ACTIONS defaultKeys).
         */
        this._keyToAction = {
            'w': 'moveForward',
            's': 'moveBackward',
            'a': 'moveLeft',
            'd': 'moveRight',
            ' ': 'jump',
            '1': 'fireMode1',
            '2': 'fireMode2',
            '3': 'fireMode3',
            '4': 'fireMode4',
            'v': 'toggleCamera',
            'escape': 'openMenu',
        };

        this._initListeners();
    }

    /**
     * Called by SettingsManager.applyToInputManager().
     * Replaces the full keyToAction lookup so both default and custom
     * keys resolve to the correct action.
     *
     * @param {Record<string,string>} keyToActionMap  lowercaseKey → actionId
     */
    applyBindings(keyToActionMap) {
        this._keyToAction = keyToActionMap;
    }

    _resolveKeydown(e) {
        const k = e.key.toLowerCase();
        const action = this._keyToAction[k];

        // ── Movement ───────────────────────────────────────────
        if (action === 'moveForward') { this.keys['w'] = true; return; }
        if (action === 'moveBackward') { this.keys['s'] = true; return; }
        if (action === 'moveLeft') { this.keys['a'] = true; return; }
        if (action === 'moveRight') { this.keys['d'] = true; return; }
        if (action === 'jump') { this.keys[' '] = true; return; }

        // ── Fire mode switching ────────────────────────────────
        const fireModeMap = { fireMode1: 1, fireMode2: 2, fireMode3: 3, fireMode4: 4 };
        if (fireModeMap[action] !== undefined) {
            this.fireMode = fireModeMap[action];
            window.dispatchEvent(new CustomEvent('fireModeChanged', { detail: this.fireMode }));
            return;
        }
    }

    _resolveKeyup(e) {
        const k = e.key.toLowerCase();
        const action = this._keyToAction[k];

        if (action === 'moveForward') { this.keys['w'] = false; }
        if (action === 'moveBackward') { this.keys['s'] = false; }
        if (action === 'moveLeft') { this.keys['a'] = false; }
        if (action === 'moveRight') { this.keys['d'] = false; }
        if (action === 'jump') { this.keys[' '] = false; }
    }

    _initListeners() {
        window.addEventListener('keydown', (e) => this._resolveKeydown(e));
        window.addEventListener('keyup', (e) => this._resolveKeyup(e));

        this.domElement.addEventListener('mousedown', (e) => {
            if (e.button === 0) { this.mouseState.left = true; this._mouseJustPressed = true; }
            if (e.button === 2) this.mouseState.right = true;
        });

        this.domElement.addEventListener('mouseup', (e) => {
            if (e.button === 0) this.mouseState.left = false;
            if (e.button === 2) this.mouseState.right = false;
        });

        this.domElement.addEventListener('mousemove', (e) => {
            this.mousePos.x = (e.clientX / window.innerWidth) * 2 - 1;
            this.mousePos.y = -(e.clientY / window.innerHeight) * 2 + 1;
        });

        // Prevent context menu on right click
        this.domElement.addEventListener('contextmenu', e => e.preventDefault());
    }

    // Call this from the websocket handler when new gesture data arrives
    updateGestures(gestures, handTargetPos) {
        this.gestureAimActive = gestures.includes("aim");
        this.gestureShootActive = gestures.includes("fire");

        if (handTargetPos) {
            this.gestureAimTarget.copy(handTargetPos);
        }
    }

    update(sceneObjects, cameraMode = 0) {
        // Resolve aiming targets

        // Gesture takes priority
        if (this.gestureAimActive || this.gestureShootActive) {
            this.aimActive = true;
            this.isShooting = this.gestureShootActive;
            this.aimTarget.copy(this.gestureAimTarget);
        } else {
            // Fallback to mouse
            this.aimActive = this.mouseState.right;
            // Mode 2 (Rapid) = hold to fire continuously; all others = single click per shot
            this.isShooting = (this.fireMode === 2)
                ? this.mouseState.left
                : this._mouseJustPressed;
            this._mouseJustPressed = false; // consumed — clear every frame

            if (this.aimActive || this.isShooting) {
                // Determine raycast origin: (0,0) in pointer lock modes, else real mousePos
                const rayPos = (cameraMode !== 0) ? new THREE.Vector2(0, 0) : this.mousePos;

                // Raycast into scene to find target point
                this.raycaster.setFromCamera(rayPos, this.camera);

                // Assuming sceneObjects is an array of meshes to raycast against
                const intersects = this.raycaster.intersectObjects(sceneObjects, true);
                if (intersects.length > 0) {
                    this.aimTarget.copy(intersects[0].point);
                } else {
                    // Just aim straight out in the ray direction
                    this.aimTarget.copy(this.raycaster.ray.at(50, new THREE.Vector3()));
                }
            }
        }
    }
}
