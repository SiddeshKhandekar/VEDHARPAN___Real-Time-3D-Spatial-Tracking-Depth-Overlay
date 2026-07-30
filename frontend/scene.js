import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/**
 * VEDHARPAN Phase 2: Three.js Viewport & Shadow Physics Engine
 * 
 * This module sets up the 3D diorama scene, loads the GLB models,
 * connects to the telemetry server, and updates the camera perspective
 * and light occlusion in real time based on head/hand tracking coordinates.
 */

// --- Configuration & Constants ---
const SERVER_URL = 'ws://localhost:8765';
const RECONNECT_DELAY_BASE_MS = 1000;
const RECONNECT_DELAY_MAX_MS = 8000;

// Parallax Sensitivity
const PARALLAX_SENSITIVITY_X = 2.5; // Controls camera X-translation
const PARALLAX_SENSITIVITY_Y = 1.8; // Controls camera Y-translation
const FRUSTUM_WARP_SENSITIVITY_X = 180; // Frustum offset in pixels
const FRUSTUM_WARP_SENSITIVITY_Y = 120; // Frustum offset in pixels

// Hand Occluder Limits (Three.js World Coordinates)
const OCCLUDER_MIN_X = -6.0;
const OCCLUDER_MAX_X = 6.0;
const OCCLUDER_MIN_Y = -1.0;
const OCCLUDER_MAX_Y = 5.0;
const OCCLUDER_MIN_Z = -5.0;
const OCCLUDER_MAX_Z = 5.0;

class DioramaScene {
    constructor() {
        this.container = document.body;
        this.canvas = document.getElementById('viewport');
        this.hudStatus = document.getElementById('status');
        this.hudFps = document.getElementById('fps');
        this.hudHead = document.getElementById('head-coords');
        this.hudHand = document.getElementById('hand-coords');

        // Main scene objects
        this.scene = null;
        this.camera = null;
        this.renderer = null;
        this.dirLight = null;
        this.handOccluder = null;

        // Assets
        this.roomModel = null;
        this.mechaModel = null;
        this.tiresModel = null;

        // Telemetry state
        this.latestHead = { x: 0, y: 0, z: 0 };
        this.latestHand = { x: 0, y: 0, z: 0 };
        this.latestHandLandmarks = [];
        this.socket = null;
        this.reconnectAttempt = 0;
        this.handRigSpheres = [];

        // Performance metrics
        this.frameCount = 0;
        this.lastFpsUpdate = performance.now();

        // Mouse Drag Controls State
        this.isDragging = false;
        this.previousMousePosition = { x: 0, y: 0 };
        this.orbitYaw = 0;
        this.orbitPitch = 0;

        // Boot system
        this.init();
    }

    /**
     * Initialize Three.js WebGL rendering pipeline, lighting, and load models.
     */
    init() {
        // 1. Create Scene
        this.scene = new THREE.Scene();
        this.scene.fog = new THREE.FogExp2(0x1a1a24, 0.008);

        // 2. Setup Renderer
        this.renderer = new THREE.WebGLRenderer({
            canvas: this.canvas,
            antialias: true,
            alpha: true
        });
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
        this.renderer.toneMappingExposure = 1.2;

        // 3. Setup Camera — straight eye-level looking into the hall
        const aspect = window.innerWidth / window.innerHeight;
        this.camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 5000);
        this.camera.position.set(0, 1.5, 6);
        this.camera.lookAt(0, 1.5, 0);

        // 4. Setup Lighting
        this.setupLights();

        // 5. Create Dynamic Hand Shadow Occluder Mesh
        this.createHandOccluder();

        // 6. Load Assets
        this.loadAssets();

        // 7. Event Listeners
        window.addEventListener('resize', () => this.onWindowResize());

        const disconnectBtn = document.getElementById('disconnect-btn');
        if (disconnectBtn) {
            disconnectBtn.addEventListener('click', () => {
                if (this.socket && this.socket.readyState === WebSocket.OPEN) {
                    this.socket.send(JSON.stringify({ command: "shutdown" }));
                }
            });
        }

        // Mouse Drag Orbit Controls
        this.renderer.domElement.addEventListener('mousedown', (e) => {
            this.isDragging = true;
            this.previousMousePosition = { x: e.offsetX, y: e.offsetY };
        });

        this.renderer.domElement.addEventListener('mousemove', (e) => {
            if (this.isDragging) {
                const deltaX = e.offsetX - this.previousMousePosition.x;
                const deltaY = e.offsetY - this.previousMousePosition.y;

                this.orbitYaw -= deltaX * 0.005;
                this.orbitPitch -= deltaY * 0.005;

                // Clamp pitch to prevent flipping
                this.orbitPitch = Math.max(-Math.PI / 2 + 0.1, Math.min(Math.PI / 2 - 0.1, this.orbitPitch));

                this.previousMousePosition = { x: e.offsetX, y: e.offsetY };
            }
        });

        this.renderer.domElement.addEventListener('mouseup', () => { this.isDragging = false; });
        this.renderer.domElement.addEventListener('mouseleave', () => { this.isDragging = false; });

        // 8. Connect to WebSocket Telemetry Server
        this.connectTelemetry();

        // 9. Start Rendering Loop
        this.animate();
    }

    /**
     * Set up scene lighting. Enforces high shadow resolution and soft shadow maps.
     */
    setupLights() {
        // Soft ambient fill light
        const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
        this.scene.add(ambientLight);

        // Subtle sky-ground bounce light
        const hemisphereLight = new THREE.HemisphereLight(0x7ec0ff, 0x111122, 0.35);
        this.scene.add(hemisphereLight);

        // Primary Shadow-casting Directional Light — positioned high behind the camera
        // so shadows project directly forward onto the stairs.
        this.dirLight = new THREE.DirectionalLight(0xfff5e6, 4.0);
        this.dirLight.position.set(0, 12, 10);
        this.dirLight.target.position.set(0, 0, 0);
        this.dirLight.castShadow = true;

        // Shadow frustum sized to cover the whole room interior
        this.dirLight.shadow.mapSize.width = 4096;
        this.dirLight.shadow.mapSize.height = 4096;
        this.dirLight.shadow.camera.near = 0.5;
        this.dirLight.shadow.camera.far = 30;
        this.dirLight.shadow.camera.left = -10;
        this.dirLight.shadow.camera.right = 10;
        this.dirLight.shadow.camera.top = 10;
        this.dirLight.shadow.camera.bottom = -10;
        this.dirLight.shadow.bias = -0.0003;
        this.dirLight.shadow.normalBias = 0.02;
        this.dirLight.shadow.radius = 3;

        this.scene.add(this.dirLight);
        this.scene.add(this.dirLight.target);
    }

    /**
     * Create a 21-joint skeleton rig for the hand that casts real shadows.
     *
     * CRITICAL: MeshBasicMaterial with visible:false does NOT cast shadows
     * in Three.js. We must use MeshStandardMaterial with opacity:0 and
     * transparent:true. The mesh is optically invisible to the viewer but
     * the renderer still writes it into the shadow depth pass.
     */
    createHandOccluder() {
        this.handRigGroup = new THREE.Group();
        this.handRigSpheres = [];

        // Shadow-only material: optically invisible, but rendered into shadow maps
        const shadowOnlyMat = new THREE.MeshStandardMaterial({
            color: 0x000000,
            transparent: true,
            opacity: 0.0,
            roughness: 1.0,
            metalness: 0.0,
        });

        const jointGeo = new THREE.SphereGeometry(0.15, 10, 10);

        // 21 MediaPipe hand landmarks
        for (let i = 0; i < 21; i++) {
            const sphere = new THREE.Mesh(jointGeo, shadowOnlyMat);
            sphere.castShadow = true;
            sphere.receiveShadow = false;
            sphere.position.set(0, -10, 0); // Start out-of-frame
            this.handRigGroup.add(sphere);
            this.handRigSpheres.push(sphere);
        }

        // Central palm volume proxy (slightly larger)
        const palmGeo = new THREE.SphereGeometry(0.28, 12, 12);
        this.handOccluder = new THREE.Mesh(palmGeo, shadowOnlyMat);
        this.handOccluder.castShadow = true;
        this.handOccluder.receiveShadow = false;
        this.handOccluder.position.set(0, -10, 2.0);
        this.handRigGroup.add(this.handOccluder);

        this.scene.add(this.handRigGroup);
    }

    /**
     * Load GLB assets from the assets directory and configure shadow casting/receiving.
     */
    loadAssets() {
        const loader = new GLTFLoader();
        const assetPath = 'assets/';

        // Helper to enable shadows recursively on imported model nodes
        const configureShadows = (object, cast, receive) => {
            object.traverse((child) => {
                if (child.isMesh) {
                    child.castShadow = cast;
                    child.receiveShadow = receive;

                    // Enhance material reflectivity
                    if (child.material) {
                        child.material.roughness = Math.min(child.material.roughness, 0.8);
                        child.material.envMapIntensity = 1.2;
                    }
                }
            });
        };

        // 1. Load Room Environment
        loader.load(
            `${assetPath}urban_design_vr_room.glb`,
            (gltf) => {
                this.roomModel = gltf.scene;
                // Centre room at origin; default rotation (0,0,0) faces the stairs going UP
                this.roomModel.position.set(0, -2.7, 0);
                this.roomModel.rotation.set(0, 1.6, 0);
                this.roomModel.scale.set(1.2, 1.2, 1.2);
                configureShadows(this.roomModel, false, true); // Room only receives shadows
                this.scene.add(this.roomModel);
                console.log('Loaded: Room Environment');
            },
            undefined,
            (error) => console.error('Error loading Room Model:', error)
        );

        // 2. Load Mecha — placed on the stairs
        loader.load(
            `${assetPath}mecha.glb`,
            (gltf) => {
                this.mechaModel = gltf.scene;
                // Position on the bottom of the stairs (Z=0). Y=1.5 prevents clipping into the floor.
                // The mecha natively faces the camera (+Z).
                // We rotate it 180 degrees (Math.PI) on Y to make it face -Z (up the stairs).
                this.mechaModel.position.set(0, 300, 2);
                this.mechaModel.rotation.set(0, Math.PI, 0);
                this.mechaModel.scale.set(0.6, 0.6, 0.6);
                configureShadows(this.mechaModel, true, true);
                this.scene.add(this.mechaModel);
                console.log('Loaded: Centerpiece Mecha');
            },
            undefined,
            (error) => console.error('Error loading Mecha Model:', error)
        );

        // 3. Load Space Globe Background
        loader.load(
            `${assetPath}space_globe.glb`,
            (gltf) => {
                this.spaceBackground = gltf.scene;

                // Keep it at the origin, scale it to 500 
                this.spaceBackground.position.set(0, 0, 0);
                this.spaceBackground.scale.set(500, 500, 500);

                this.spaceBackground.rotation.y = THREE.MathUtils.degToRad(180);

                this.spaceBackground.traverse((child) => {
                    // Check if it's a mesh and has a material
                    if (child.isMesh && child.material) {

                        // 1. THE MOST IMPORTANT FIX: Tell the stars to ignore scene fog!
                        child.material.fog = false;

                        // 2. Render on the inside (your file actually sets doubleSided: true by default, but this enforces it)
                        child.material.side = THREE.BackSide;

                        // 3. Ensure the glowing emissive texture is at full brightness
                        child.material.emissiveIntensity = 1;

                        // 4. Force it to stay in the background
                        child.material.depthWrite = false;
                        child.renderOrder = -1;
                    }
                });

                this.scene.add(this.spaceBackground);
                console.log('Loaded: Space 360 Background');
            },
            undefined,
            (error) => console.error('Error loading Space Globe:', error)
        );

        // 4. Load Tires — scattered around the stairs and hall
        loader.load(
            `${assetPath}game_ready_free_car_tires.glb`,
            (gltf) => {
                // Scatter multiple tire groups everywhere in the hall
                const tirePositions = [
                    { x: -1.5, y: 0, z: 0.5, rotY: 0.3 },
                    { x: 1.8, y: 5, z: -1.0, rotY: -0.5 },
                    { x: -0.8, y: 1.8, z: -2.5, rotY: 1.2 },
                    { x: 1.2, y: 2.2, z: -4.0, rotY: 2.0 },
                    { x: -2.0, y: 0.5, z: 2.0, rotY: 0.8 },
                    { x: 2.5, y: 0.8, z: 1.5, rotY: 1.5 },
                ];

                tirePositions.forEach((pos, idx) => {
                    const tireClone = gltf.scene.clone();
                    tireClone.position.set(pos.x, pos.y, pos.z);
                    tireClone.rotation.y = pos.rotY;
                    tireClone.scale.set(0.4, 0.4, 0.4);
                    configureShadows(tireClone, true, true);
                    this.scene.add(tireClone);
                });

                console.log('Loaded: Tires scattered around Mecha');
            },
            undefined,
            (error) => console.error('Error loading Tires Model:', error)
        );
    }

    /**
     * Establish WebSocket client connection with auto-reconnection and status reporting.
     */
    connectTelemetry() {
        this.hudStatus.textContent = 'Connecting...';
        this.hudStatus.className = 'connecting';

        this.socket = new WebSocket(SERVER_URL);

        this.socket.onopen = () => {
            console.log('Connected to VEDHARPAN Telemetry Server');
            this.hudStatus.textContent = 'Connected';
            this.hudStatus.className = 'connected';
            this.reconnectAttempt = 0;
        };

        this.socket.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);

                if (data.head) {
                    this.latestHead = data.head;
                    this.hudHead.textContent = `x: ${data.head.x.toFixed(2)}, y: ${data.head.y.toFixed(2)}, z: ${data.head.z.toFixed(2)}`;
                }

                if (data.hand) {
                    this.latestHand = data.hand;
                    this.hudHand.textContent = `x: ${data.hand.x.toFixed(2)}, y: ${data.hand.y.toFixed(2)}, z: ${data.hand.z.toFixed(2)}`;
                }

                if (data.hand_landmarks) {
                    this.latestHandLandmarks = data.hand_landmarks;
                }
            } catch (err) {
                console.error('Failed to parse telemetry payload:', err);
            }
        };

        this.socket.onclose = () => {
            console.log('Telemetry connection closed. Attempting reconnect...');
            this.hudStatus.textContent = 'Disconnected';
            this.hudStatus.className = 'disconnected';

            // Reconnect logic with exponential backoff
            const delay = Math.min(
                RECONNECT_DELAY_BASE_MS * Math.pow(2, this.reconnectAttempt),
                RECONNECT_DELAY_MAX_MS
            );
            this.reconnectAttempt++;
            setTimeout(() => this.connectTelemetry(), delay);
        };

        this.socket.onerror = (error) => {
            console.error('WebSocket Error:', error);
        };
    }

    /**
     * Rescale viewport canvas on browser window resizing.
     */
    onWindowResize() {
        const width = window.innerWidth;
        const height = window.innerHeight;

        this.camera.aspect = width / height;
        this.camera.updateProjectionMatrix();

        this.renderer.setSize(width, height);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    }

    /**
     * Dynamic Camera Parallax warping and off-axis viewport offset calculations
     * with integrated spherical mouse orbit control.
     */
    applyParallax() {
        const width = window.innerWidth;
        const height = window.innerHeight;

        // Base orbit radius
        const radius = 6.0;
        const headZOffset = this.latestHead.z * 1.5;
        const actualRadius = radius - headZOffset;

        // Convert orbitYaw and orbitPitch to Spherical coordinates
        const phi = Math.PI / 2 - this.orbitPitch;
        const theta = this.orbitYaw;

        const orbitX = actualRadius * Math.sin(phi) * Math.sin(theta);
        const orbitY = 1.5 + actualRadius * Math.cos(phi);
        const orbitZ = actualRadius * Math.sin(phi) * Math.cos(theta);

        // Add Parallax (Head Tracking) offsets perpendicular to the look direction
        const rightX = Math.cos(theta);
        const rightZ = -Math.sin(theta);

        const parallaxX = this.latestHead.x * PARALLAX_SENSITIVITY_X;
        const parallaxY = this.latestHead.y * PARALLAX_SENSITIVITY_Y;

        const targetCamX = orbitX + (parallaxX * rightX);
        const targetCamY = orbitY + parallaxY;
        const targetCamZ = orbitZ + (parallaxX * rightZ);

        // Smoothly interpolate camera position (Lerp) for stability
        this.camera.position.x += (targetCamX - this.camera.position.x) * 0.15;
        this.camera.position.y += (targetCamY - this.camera.position.y) * 0.15;
        this.camera.position.z += (targetCamZ - this.camera.position.z) * 0.15;

        // Perform Asymmetric Frustum Warping (Off-Axis Projection)
        const xOffset = -this.latestHead.x * FRUSTUM_WARP_SENSITIVITY_X;
        const yOffset = this.latestHead.y * FRUSTUM_WARP_SENSITIVITY_Y;

        this.camera.setViewOffset(
            width, height,
            xOffset, yOffset,
            width, height
        );

        // Camera always looks at the center (0, 1.5, 0)
        this.camera.lookAt(0, 1.5, 0);
    }

    /**
     * Process Hand coordinates and relocate the 21-joint skeleton occluder.
     */
    applyShadowOcclusion() {
        // Map normalized telemetry [-1.0, 1.0] to custom Three.js world boundaries
        const targetX = THREE.MathUtils.mapLinear(this.latestHand.x, -1.0, 1.0, OCCLUDER_MIN_X, OCCLUDER_MAX_X);
        const targetY = THREE.MathUtils.mapLinear(this.latestHand.y, -1.0, 1.0, OCCLUDER_MIN_Y, OCCLUDER_MAX_Y);
        const targetZ = THREE.MathUtils.mapLinear(this.latestHand.z, -1.0, 1.0, OCCLUDER_MIN_Z, OCCLUDER_MAX_Z);

        const isHandDetected = Math.abs(this.latestHand.x) > 0.001 || Math.abs(this.latestHand.y) > 0.001;

        if (isHandDetected) {
            // Smoothly move hand occluder center towards wrist coordinate target
            this.handOccluder.position.x += (targetX - this.handOccluder.position.x) * 0.25;
            this.handOccluder.position.y += (targetY - this.handOccluder.position.y) * 0.25;
            this.handOccluder.position.z += (targetZ - this.handOccluder.position.z) * 0.25;

            // Position all 21 individual joint spheres if landmarks array is available
            if (this.latestHandLandmarks && this.latestHandLandmarks.length === 21) {
                for (let i = 0; i < 21; i++) {
                    const lm = this.latestHandLandmarks[i];
                    const lmX = THREE.MathUtils.mapLinear(lm.x, -1.0, 1.0, OCCLUDER_MIN_X, OCCLUDER_MAX_X);
                    const lmY = THREE.MathUtils.mapLinear(lm.y, -1.0, 1.0, OCCLUDER_MIN_Y, OCCLUDER_MAX_Y);
                    const lmZ = THREE.MathUtils.mapLinear(lm.z, -1.0, 1.0, OCCLUDER_MIN_Z, OCCLUDER_MAX_Z);

                    const sphere = this.handRigSpheres[i];
                    sphere.position.x += (lmX - sphere.position.x) * 0.35;
                    sphere.position.y += (lmY - sphere.position.y) * 0.35;
                    sphere.position.z += (lmZ - sphere.position.z) * 0.35;
                }
            }
        } else {
            // Smoothly return all occluders out of frame when no hand detected
            this.handOccluder.position.x += (0.0 - this.handOccluder.position.x) * 0.1;
            this.handOccluder.position.y += (-10.0 - this.handOccluder.position.y) * 0.1;
            this.handOccluder.position.z += (2.0 - this.handOccluder.position.z) * 0.1;

            for (let i = 0; i < this.handRigSpheres.length; i++) {
                const sphere = this.handRigSpheres[i];
                sphere.position.y += (-10.0 - sphere.position.y) * 0.1;
            }
        }
    }

    /**
     * Compute and output actual active rendering FPS diagnostics to HUD.
     */
    updateFpsHud() {
        this.frameCount++;
        const now = performance.now();
        const duration = now - this.lastFpsUpdate;

        if (duration >= 1000) {
            const currentFps = Math.round((this.frameCount * 1000) / duration);
            this.hudFps.textContent = currentFps.toString();
            this.frameCount = 0;
            this.lastFpsUpdate = now;
        }
    }

    /**
     * Main Animation & Render loop. Runs at browser vertical refresh rate.
     */
    animate() {
        requestAnimationFrame(() => this.animate());

        // 1. Update camera parallax projections
        this.applyParallax();

        // 2. Adjust dynamic shadow physics occluder positions
        this.applyShadowOcclusion();

        // 3. Idle animations on models if loaded
        if (this.mechaModel) {
            // Subtle breathing/floating effect
            const elapsed = performance.now() * 0.0015;
            this.mechaModel.position.y = 0.1 + Math.sin(elapsed) * 0.08;
        }

        // 4. Render main loop frame
        this.renderer.render(this.scene, this.camera);

        // 5. Update Diagnostics
        this.updateFpsHud();
    }
}

// Instantiate scene manager once document loaded
window.addEventListener('DOMContentLoaded', () => {
    new DioramaScene();
});
