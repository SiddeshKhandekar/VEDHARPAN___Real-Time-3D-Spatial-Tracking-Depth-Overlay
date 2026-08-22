import * as THREE from 'three';

export class InputManager {
    constructor(camera, domElement) {
        this.camera = camera;
        this.domElement = domElement;

        this.keys = {
            'w': false,
            'a': false,
            's': false,
            'd': false,
            ' ': false
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
        this.fireMode = 1; // 1=Plasma, 2=Rapid, 3=Spread, 4=Charged

        // Gesture overrides
        this.gestureAimActive = false;
        this.gestureShootActive = false;
        this.gestureAimTarget = new THREE.Vector3();

        this.raycaster = new THREE.Raycaster();

        // Edge-detection: true only on the frame the button is first pressed
        this._mouseJustPressed = false;

        this._initListeners();
    }

    _initListeners() {
        window.addEventListener('keydown', (e) => {
            const k = e.key.toLowerCase();
            if (this.keys.hasOwnProperty(k)) {
                this.keys[k] = true;
            }
            // Fire mode switching (1-4)
            if (['1', '2', '3', '4'].includes(e.key)) {
                this.fireMode = parseInt(e.key);
                // Dispatch UI update event
                window.dispatchEvent(new CustomEvent('fireModeChanged', { detail: this.fireMode }));
            }
        });

        window.addEventListener('keyup', (e) => {
            if (this.keys.hasOwnProperty(e.key.toLowerCase())) {
                this.keys[e.key.toLowerCase()] = false;
            }
        });

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
