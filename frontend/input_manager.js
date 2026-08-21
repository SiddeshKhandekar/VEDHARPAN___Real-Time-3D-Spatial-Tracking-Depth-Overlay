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

        // Gesture overrides
        this.gestureAimActive = false;
        this.gestureShootActive = false;
        this.gestureAimTarget = new THREE.Vector3();

        this.raycaster = new THREE.Raycaster();

        this._initListeners();
    }

    _initListeners() {
        window.addEventListener('keydown', (e) => {
            if (this.keys.hasOwnProperty(e.key.toLowerCase())) {
                this.keys[e.key.toLowerCase()] = true;
            }
        });

        window.addEventListener('keyup', (e) => {
            if (this.keys.hasOwnProperty(e.key.toLowerCase())) {
                this.keys[e.key.toLowerCase()] = false;
            }
        });

        this.domElement.addEventListener('mousedown', (e) => {
            if (e.button === 0) this.mouseState.left = true;
            if (e.button === 2) this.mouseState.right = true;
        });

        this.domElement.addEventListener('mouseup', (e) => {
            if (e.button === 0) this.mouseState.left = false;
            if (e.button === 2) this.mouseState.right = false;
        });

        this.domElement.addEventListener('mousemove', (e) => {
            if (document.pointerLockElement) {
                // Pointer-locked: always aim from screen centre (matches crosshair)
                this.mousePos.x = 0;
                this.mousePos.y = 0;
            } else {
                this.mousePos.x = (e.clientX / window.innerWidth) * 2 - 1;
                this.mousePos.y = -(e.clientY / window.innerHeight) * 2 + 1;
            }
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

    update(sceneObjects) {
        // Resolve aiming targets

        // Gesture takes priority
        if (this.gestureAimActive || this.gestureShootActive) {
            this.aimActive = true;
            this.isShooting = this.gestureShootActive;
            this.aimTarget.copy(this.gestureAimTarget);
        } else {
            // Fallback to mouse
            this.aimActive = this.mouseState.right;
            this.isShooting = this.mouseState.left;

            if (this.aimActive || this.isShooting) {
                // Raycast into scene to find target point
                this.raycaster.setFromCamera(this.mousePos, this.camera);

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
