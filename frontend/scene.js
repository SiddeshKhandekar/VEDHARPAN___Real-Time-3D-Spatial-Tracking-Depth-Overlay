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
        this.socket = null;
        this.reconnectAttempt = 0;

        // Performance metrics
        this.frameCount = 0;
        this.lastFpsUpdate = performance.now();

        // Boot system
        this.init();
    }

    /**
     * Initialize Three.js WebGL rendering pipeline, lighting, and load models.
     */
    init() {
        // 1. Create Scene
        this.scene = new THREE.Scene();
        this.scene.fog = new THREE.FogExp2(0x1a1a24, 0.015);

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
        this.renderer.toneMappingExposure = 1.0;

        // 3. Setup Camera
        const aspect = window.innerWidth / window.innerHeight;
        this.camera = new THREE.PerspectiveCamera(45, aspect, 0.1, 100);
        // Default camera resting position looking directly at centerpiece
        this.camera.position.set(0, 1.8, 8);
        this.camera.lookAt(0, 1.0, 0);

        // 4. Setup Lighting
        this.setupLights();

        // 5. Create Dynamic Hand Shadow Occluder Mesh
        this.createHandOccluder();

        // 6. Load Assets
        this.loadAssets();

        // 7. Event Listeners
        window.addEventListener('resize', () => this.onWindowResize());

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
        const ambientLight = new THREE.AmbientLight(0xffffff, 0.4);
        this.scene.add(ambientLight);

        // Subtle bottom blue bounce light
        const hemisphereLight = new THREE.HemisphereLight(0x7ec0ff, 0x111122, 0.3);
        this.scene.add(hemisphereLight);

        // Primary Shadow-casting Directional Light (angled from top-front-right)
        this.dirLight = new THREE.DirectionalLight(0xffffff, 3.5);
        this.dirLight.position.set(5, 8, 4);
        this.dirLight.castShadow = true;

        // Optimize Shadow Map Frustum for high detail over diorama
        this.dirLight.shadow.mapSize.width = 2048;
        this.dirLight.shadow.mapSize.height = 2048;
        this.dirLight.shadow.camera.near = 0.5;
        this.dirLight.shadow.camera.far = 25;
        this.dirLight.shadow.camera.left = -6;
        this.dirLight.shadow.camera.right = 6;
        this.dirLight.shadow.camera.top = 6;
        this.dirLight.shadow.camera.bottom = -6;
        this.dirLight.shadow.bias = -0.0005;
        this.dirLight.shadow.radius = 4; // Blurs shadow edges slightly

        this.scene.add(this.dirLight);
    }

    /**
     * Create an invisible mesh proxy for the hand.
     * This casts a dynamic shadow representing the user's hand movements.
     */
    createHandOccluder() {
        // A low-poly sphere proxy acting as the hand center of mass
        const geometry = new THREE.SphereGeometry(0.45, 16, 16);
        const material = new THREE.MeshBasicMaterial({
            color: 0xff0000,
            visible: false // Invisible to the user, still casts shadow
        });

        this.handOccluder = new THREE.Mesh(geometry, material);
        this.handOccluder.castShadow = true;
        this.handOccluder.position.set(0, 1.2, 2.0); // Default home position
        this.scene.add(this.handOccluder);
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
                this.roomModel.position.set(0, 0, 0);
                this.roomModel.scale.set(1.0, 1.0, 1.0);
                configureShadows(this.roomModel, false, true); // Room receives shadows
                this.scene.add(this.roomModel);
                console.log('Loaded: Room Environment');
            },
            undefined,
            (error) => console.error('Error loading Room Model:', error)
        );

        // 2. Load Centered Mecha Model
        loader.load(
            `${assetPath}mecha.glb`,
            (gltf) => {
                this.mechaModel = gltf.scene;
                // Position mecha center-stage on the floor of the room
                this.mechaModel.position.set(0, 0.1, 0);
                this.mechaModel.scale.set(0.65, 0.65, 0.65);
                configureShadows(this.mechaModel, true, true); // Mecha casts & receives shadows
                this.scene.add(this.mechaModel);
                console.log('Loaded: Centerpiece Mecha');
            },
            undefined,
            (error) => console.error('Error loading Mecha Model:', error)
        );

        // 3. Load Car Tires Scatter Model
        loader.load(
            `${assetPath}game_ready_free_car_tires.glb`,
            (gltf) => {
                this.tiresModel = gltf.scene;
                // Scatter tires offset to the side of the centerpiece mecha
                this.tiresModel.position.set(-1.8, 0, 0.8);
                this.tiresModel.scale.set(0.5, 0.5, 0.5);
                configureShadows(this.tiresModel, true, true); // Tires cast & receive shadows
                this.scene.add(this.tiresModel);
                console.log('Loaded: Tires Scatter Model');
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
     * Dynamic Camera Parallax warping and off-axis viewport offset calculations.
     */
    applyParallax() {
        const width = window.innerWidth;
        const height = window.innerHeight;

        // Translate head telemetry coordinate limits [-1.0, 1.0] into camera target displacement
        const targetCamX = this.latestHead.x * PARALLAX_SENSITIVITY_X;
        const targetCamY = 1.8 + (this.latestHead.y * PARALLAX_SENSITIVITY_Y);
        // Map head.z depth. Farther head distance pushes camera back slightly
        const targetCamZ = 8.0 - (this.latestHead.z * 1.5);

        // Smoothly interpolate camera position (Lerp) to damp sudden movement spikes
        this.camera.position.x += (targetCamX - this.camera.position.x) * 0.15;
        this.camera.position.y += (targetCamY - this.camera.position.y) * 0.15;
        this.camera.position.z += (targetCamZ - this.camera.position.z) * 0.15;

        // Perform Asymmetric Frustum Warping (Off-Axis Projection)
        const xOffset = -this.latestHead.x * FRUSTUM_WARP_SENSITIVITY_X;
        const yOffset = this.latestHead.y * FRUSTUM_WARP_SENSITIVITY_Y;

        this.camera.setViewOffset(
            width, height,     // Full virtual film dimensions
            xOffset, yOffset,  // Pixel horizontal/vertical film offset
            width, height      // Sub-view rendering dimensions (full canvas)
        );

        // Keep camera focused on centerpiece coordinate region
        this.camera.lookAt(0, 1.0, 0);
    }

    /**
     * Process Hand coordinates and relocate the invisible occluder mesh.
     */
    applyShadowOcclusion() {
        // Map normalized telemetry [-1.0, 1.0] to custom Three.js world boundaries
        const targetX = THREE.MathUtils.mapLinear(this.latestHand.x, -1.0, 1.0, OCCLUDER_MIN_X, OCCLUDER_MAX_X);
        const targetY = THREE.MathUtils.mapLinear(this.latestHand.y, -1.0, 1.0, OCCLUDER_MIN_Y, OCCLUDER_MAX_Y);
        const targetZ = THREE.MathUtils.mapLinear(this.latestHand.z, -1.0, 1.0, OCCLUDER_MIN_Z, OCCLUDER_MAX_Z);

        // Check if hand is detected (i.e. not at default resting origin coordinate)
        const isHandDetected = Math.abs(this.latestHand.x) > 0.001 || Math.abs(this.latestHand.y) > 0.001;

        if (isHandDetected) {
            // Smoothly move hand occluder mesh towards coordinate target
            this.handOccluder.position.x += (targetX - this.handOccluder.position.x) * 0.25;
            this.handOccluder.position.y += (targetY - this.handOccluder.position.y) * 0.25;
            this.handOccluder.position.z += (targetZ - this.handOccluder.position.z) * 0.25;
        } else {
            // Smoothly return occluder behind/below scenery out of viewport frustum
            this.handOccluder.position.x += (0.0 - this.handOccluder.position.x) * 0.1;
            this.handOccluder.position.y += (-5.0 - this.handOccluder.position.y) * 0.1;
            this.handOccluder.position.z += (2.0 - this.handOccluder.position.z) * 0.1;
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
