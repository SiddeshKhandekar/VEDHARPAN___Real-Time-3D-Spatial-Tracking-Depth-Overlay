import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { PhysicsWorld } from './physics_world.js';
import { InputManager } from './input_manager.js';
import { VisualEffects } from './effects.js';
import { MechaController } from './mecha_controller.js';
import { SettingsManager, ACTIONS } from './settings.js';

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
        this.hudHand = document.getElementById('hands-coords');
        this.hudCameraMode = document.getElementById('camera-mode');

        // Main scene objects
        this.scene = null;
        this.camera = null;
        this.renderer = null;
        this.dirLight = null;
        this.handRigs = [];

        // Assets
        this.roomModel = null;
        this.mechaModel = null;
        this.tiresModel = null;
        this.collidableMeshes = [];

        // Telemetry state
        this.latestHead = { x: 0, y: 0, z: 0 };
        this.latestHands = [];
        this.socket = null;
        this.reconnectAttempt = 0;

        // Performance metrics
        this.frameCount = 0;
        this.lastFpsUpdate = performance.now();

        // Mouse Drag Controls State
        this.isDragging = false;
        this.previousMousePosition = { x: 0, y: 0 };
        this.orbitYaw = 0;
        this.orbitPitch = 0;

        // Free Roam Variables
        this.freeRoamOffset = new THREE.Vector3(0, 0, 0);
        this.isRecentering = false;

        // Camera Modes: 0=Free Roam, 1=Third Person, 2=First Person, 3=Aiming
        this.cameraMode = 0;
        this.cameraModeNames = ['Free Roam', 'Third Person', 'First Person', 'Aiming View'];
        this.previousCameraMode = undefined; // for right-click aim toggle

        // Physics and Logic
        this.physicsWorld = null;
        this.inputManager = null;
        this.effects = null;
        this.mechaController = null;

        // Game State (Always playing to keep world alive in background)
        this.gameState = 'playing';
        this.score = 0;
        this.lastTime = performance.now();

        // Boot system
        this.settingsManager = new SettingsManager();
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
            alpha: false,
            preserveDrawingBuffer: true,
            powerPreference: "high-performance"
        });
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
        this.renderer.toneMappingExposure = 1.2;

        // 3. Setup Camera — straight eye-level looking into the hall
        const aspect = window.innerWidth / window.innerHeight;
        this.camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 50000);
        this.camera.position.set(0, 1.5, 6);
        this.camera.lookAt(0, 1.5, 0);

        // 4. Setup Lighting
        this.setupLights();

        // 5. Create Dynamic Hand Shadow Occluder Mesh
        this.createHandRigs();

        // 6. Initialize Core Systems first (Must exist BEFORE GLTF parse callbacks bind Trimesh)
        this.physicsWorld = new PhysicsWorld();
        this.inputManager = new InputManager(this.camera, this.renderer.domElement);
        this.settingsManager.applyToInputManager(this.inputManager);
        this.effects = new VisualEffects(this.scene);

        // 7. Load Assets (Blocks rendering specifically until finished via the callback)
        this.loadAssets(() => {
            // 8. Start Rendering Loop
            this.animate();

            if (sessionStorage.getItem('vedharpan_autostart_newgame')) {
                sessionStorage.removeItem('vedharpan_autostart_newgame');
                setTimeout(() => {
                    const startBtn = document.getElementById('btn-start');
                    if (startBtn) startBtn.click();
                }, 250);
            }
        });

        // 9. Event Listeners
        window.addEventListener('resize', () => this.onWindowResize());


        // Main Menu Buttons
        const btnStart = document.getElementById('btn-start');
        if (btnStart) {
            if (sessionStorage.getItem('vedharpan_autostart_newgame')) {
                btnStart.textContent = "Start Game";
            } else {
                btnStart.textContent = "Resume Game";
            }
        }

        const btnNewGame = document.getElementById('btn-new-game');
        if (btnNewGame) {
            btnNewGame.addEventListener('click', () => {
                sessionStorage.setItem('vedharpan_autostart_newgame', 'true');
                window.location.reload();
            });
        }

        if (btnStart) {
            btnStart.addEventListener('click', () => {
                btnStart.textContent = "Resume Game";
                const isFirstStart = !document.getElementById('hud').classList.contains('hidden');

                // FIRST: Instantly request Pointer Lock while the DOM button is still valid and visible
                this.renderer.domElement.requestPointerLock();

                // DANGEROUS CHROMIUM BUG AVOIDANCE: Defer hiding the menu by 50ms so Chromium 
                // doesn't instantly cancel the Pointer Lock Promise because the target vanished!
                setTimeout(() => {
                    document.getElementById('main-menu').classList.add('hidden');
                    document.getElementById('hud').classList.remove('hidden');
                    document.getElementById('game-hud').classList.remove('hidden');
                    document.getElementById('crosshair').classList.remove('hidden');
                }, 50);
            });
        }

        const btnQuit = document.getElementById('btn-quit');
        if (btnQuit) {
            btnQuit.addEventListener('click', () => {
                if (this.socket && this.socket.readyState === WebSocket.OPEN) {
                    this.socket.send(JSON.stringify({ command: "shutdown" }));
                } else {
                    window.close(); // Fallback if no socket connection
                }
            });
        }

        // ── Settings Panel wiring ────────────────────────────────────────────
        this._initSettingsPanel();

        window.addEventListener('keydown', (e) => {
            // Aggressive fallback: if Pointer Lock failed to engage on Play, capture it secretly on the first keystroke
            if (this.gameState === 'playing' && document.pointerLockElement !== this.renderer.domElement) {
                this.renderer.domElement.requestPointerLock();
            }

            const map = this.settingsManager.buildKeyToActionMap();
            const action = map[e.key.toLowerCase()] || map[e.code.toLowerCase()];
            const isEscape = e.key === 'Escape' || action === 'openMenu';
            const isToggleCam = e.key.toLowerCase() === 'v' || action === 'toggleCamera';
            const isRespawn = e.key.toLowerCase() === 'n' || action === 'respawn';

            // ESC / Menu Toggle
            if (isEscape) {
                const settingsPanel = document.getElementById('settings-panel');
                const menu = document.getElementById('main-menu');

                if (!settingsPanel.classList.contains('hidden')) {
                    // Settings is open — close it, go back to menu
                    settingsPanel.classList.add('hidden');
                    menu.classList.remove('hidden');
                    return;
                }

                if (menu.classList.contains('hidden')) {
                    // Open Menu
                    menu.classList.remove('hidden');
                    document.getElementById('hud').classList.add('hidden');
                    document.getElementById('game-hud').classList.add('hidden');
                    document.getElementById('crosshair').classList.add('hidden');
                    if (document.pointerLockElement) {
                        document.exitPointerLock();
                    }
                } else {
                    this.renderer.domElement.requestPointerLock();
                    setTimeout(() => {
                        menu.classList.add('hidden');
                        document.getElementById('hud').classList.remove('hidden');
                        document.getElementById('game-hud').classList.remove('hidden');
                        document.getElementById('crosshair').classList.remove('hidden');
                    }, 50);
                }
                return; // Disable other keystrokes if opening menu
            }

            if (isToggleCam) {
                this.cameraMode = (this.cameraMode + 1) % 4;
                if (this.hudCameraMode) {
                    this.hudCameraMode.textContent = this.cameraModeNames[this.cameraMode];
                }
                this._applyPointerLock();
            }

            if (isRespawn && this.mechaController && this.gameState === 'playing') {
                // Instantly reset the mecha back to its start position
                this.mechaController.body.position.set(0, 5, 2);
                this.mechaController.body.velocity.set(0, 0, 0);
                this.mechaController.body.angularVelocity.set(0, 0, 0);
            }
        });

        // Mouse controls: Free Roam = drag orbit, other modes = pointer-lock look
        this.renderer.domElement.addEventListener('mousedown', (e) => {
            if (e.button === 2 && this.gameState === 'playing') {
                // Right-click hold → Aiming View
                if (this.cameraMode !== 3) {
                    this.previousCameraMode = this.cameraMode;
                    this.cameraMode = 3;
                    if (this.hudCameraMode) this.hudCameraMode.textContent = this.cameraModeNames[3];
                }
                // Green aiming crosshair
                const xhair = document.getElementById('crosshair');
                if (xhair) xhair.classList.add('aiming');
            } else if (e.button === 0 && this.cameraMode === 0) {
                // Free Roam left-click drag restored
                this.isDragging = true;
            }
        });

        this.renderer.domElement.addEventListener('mouseup', (e) => {
            if (e.button === 2) {
                // Right-click release → restore previous camera mode
                if (this.previousCameraMode !== undefined) {
                    this.cameraMode = this.previousCameraMode;
                    if (this.hudCameraMode) this.hudCameraMode.textContent = this.cameraModeNames[this.cameraMode];
                    this.previousCameraMode = undefined;
                }
                // Revert crosshair to white
            } else {
                this.isDragging = false;
            }
        });

        this.renderer.domElement.addEventListener('mousemove', (e) => {
            const sensitivity = 0.003 * (this.settingsManager.graphics.sensitivity || 1.0);
            // Invert Y-axis multiplier from settings
            const pitchDir = this.settingsManager.graphics.invertMouse ? 1 : -1;
            if (this.gameState === 'playing') {
                this.orbitYaw -= e.movementX * sensitivity;
                this.orbitPitch += pitchDir * e.movementY * sensitivity;
                this.orbitPitch = Math.max(-Math.PI / 2 + 0.05, Math.min(Math.PI / 2 - 0.05, this.orbitPitch));
            }
        });

        this.renderer.domElement.addEventListener('mouseleave', () => { this.isDragging = false; });

        // Click canvas to request Pointer Lock (enables unbounded movementX/Y)
        this.renderer.domElement.addEventListener('click', () => {
            if (this.gameState === 'playing') {
                this.renderer.domElement.requestPointerLock();
            }
        });

        // ── Fire Mode Label ────────────────────────────────────────
        const fireModeNames = { 1: 'PLASMA', 2: 'RAPID', 3: 'MISSILE', 4: 'GRENADE' };
        const fireModeColors = { 1: '#9933ff', 2: '#ff8800', 3: '#ff5500', 4: '#ff0000' };

        // ── Ammo Meters ────────────────────────────────────────────
        const meterEls = {};
        [1, 2, 3, 4].forEach(m => {
            const card = document.getElementById(`meter-${m}`);
            if (!card) return;
            meterEls[m] = {
                card,
                fill: card.querySelector('.meter-fill'),
                count: card.querySelector('.meter-count'),
            };
        });

        const cooldownRAF = {};

        function fmtTime(ms) {
            const s = Math.ceil(ms / 1000);
            const m = Math.floor(s / 60), r = s % 60;
            return m > 0 ? `${m}:${String(r).padStart(2, '0')}` : `${r}s`;
        }

        function setMeterState(mode, rounds, max, isReloading, cooldownMs) {
            const m = meterEls[mode];
            if (!m) return;

            if (cooldownRAF[mode]) { cancelAnimationFrame(cooldownRAF[mode]); cooldownRAF[mode] = null; }

            if (isReloading) {
                m.card.classList.add('cooling');
                m.count.textContent = '⏳';
                m.fill.style.width = '0%';

                const start = performance.now();
                function animateCooldown() {
                    const elapsed = performance.now() - start;
                    const pct = Math.min(elapsed / cooldownMs, 1);
                    m.fill.style.width = `${pct * 100}%`;
                    m.count.textContent = pct < 1 ? `⏱ ${fmtTime(cooldownMs - elapsed)}` : '';
                    if (pct < 1) cooldownRAF[mode] = requestAnimationFrame(animateCooldown);
                }
                cooldownRAF[mode] = requestAnimationFrame(animateCooldown);
            } else {
                m.card.classList.remove('cooling');
                m.fill.style.width = `${max > 0 ? (rounds / max) * 100 : 100}%`;
                m.count.textContent = `${rounds}/${max}`;
            }
        }

        window.addEventListener('fireModeChanged', (e) => {
            const mode = e.detail;
            const el = document.getElementById('fire-mode-name');
            if (el) {
                el.textContent = fireModeNames[mode] ?? 'PLASMA';
                el.style.color = fireModeColors[mode] ?? '#9933ff';
            }
            [1, 2, 3, 4].forEach(m => meterEls[m]?.card.classList.toggle('active', m === mode));
            const mc = this.mechaController;
            if (mc?.ammo?.[mode]) {
                const a = mc.ammo[mode];
                window.dispatchEvent(new CustomEvent('ammoUpdate', {
                    detail: { mode, rounds: a.rounds, max: a.max, isReloading: a.isReloading, cooldownMs: a.cooldownMs }
                }));
            }
        });

        window.addEventListener('ammoUpdate', ({ detail: d }) => {
            setMeterState(d.mode, d.rounds, d.max, d.isReloading, d.cooldownMs ?? 60000);
        });

        // Highlight mode 1 as default active on load
        meterEls[1]?.card.classList.add('active');

    }

    /**
     * Initialise all Settings Panel interactivity:
     * • Main tab switching (Graphics / Controls)
     * • Sub-tab switching (Keyboard / Mouse)
     * • Keybind table row generation + COD-style key-capture
     * • Fullscreen toggle
     * • Save & Close / Restore Defaults
     */
    _initSettingsPanel() {
        const sm = this.settingsManager;

        // ── Open from Main Menu ─────────────────────────────────────────
        const btnOptions = document.getElementById('btn-options');
        const settingsPanel = document.getElementById('settings-panel');

        let targetSettingsScroll = 0;
        let currentSettingsScroll = 0;

        if (settingsPanel) {
            settingsPanel.addEventListener('wheel', (e) => {
                e.preventDefault();
                const maxScroll = settingsPanel.scrollHeight - settingsPanel.clientHeight;
                targetSettingsScroll += e.deltaY * 0.85;
                targetSettingsScroll = Math.max(0, Math.min(targetSettingsScroll, maxScroll));
            }, { passive: false });

            const smoothScrollLoop = () => {
                if (!settingsPanel.classList.contains('hidden')) {
                    currentSettingsScroll += (targetSettingsScroll - currentSettingsScroll) * 0.12;
                    settingsPanel.scrollTop = currentSettingsScroll;

                    if (Math.abs(settingsPanel.scrollTop - Math.round(currentSettingsScroll)) > 2) {
                        targetSettingsScroll = settingsPanel.scrollTop;
                        currentSettingsScroll = settingsPanel.scrollTop;
                    }
                } else {
                    targetSettingsScroll = settingsPanel.scrollTop;
                    currentSettingsScroll = targetSettingsScroll;
                }
                requestAnimationFrame(smoothScrollLoop);
            };
            requestAnimationFrame(smoothScrollLoop);
        }

        if (btnOptions) {
            btnOptions.addEventListener('click', () => {
                document.getElementById('main-menu').classList.add('hidden');
                settingsPanel.classList.remove('hidden');
                this._renderKeybindRows();
                // Sync fullscreen toggle state
                document.getElementById('fullscreen-toggle').checked = sm.graphics.fullscreen;
            });
        }

        // ── Close button ───────────────────────────────────────────
        const closeBtnEl = document.getElementById('settings-close-btn');
        if (closeBtnEl) {
            closeBtnEl.addEventListener('click', () => {
                document.getElementById('settings-panel').classList.add('hidden');
                document.getElementById('main-menu').classList.remove('hidden');
            });
        }

        // ── Main tab switching (Graphics / Controls) ───────────────────
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
                document.querySelectorAll('.tab-content').forEach(c => c.classList.add('hidden'));
                btn.classList.add('active');
                document.getElementById(`tab-${btn.dataset.tab}`).classList.remove('hidden');
            });
        });

        // ── Sub-tab switching (Keyboard / Mouse) ────────────────────
        document.querySelectorAll('.ctrl-tab-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.ctrl-tab-btn').forEach(b => b.classList.remove('active'));
                document.querySelectorAll('.ctrl-content').forEach(c => c.classList.add('hidden'));
                btn.classList.add('active');
                document.getElementById(`ctrl-${btn.dataset.ctrl}`).classList.remove('hidden');
            });
        });

        // ── Fullscreen toggle ──────────────────────────────────────
        const fsToggle = document.getElementById('fullscreen-toggle');
        if (fsToggle) {
            // Keep in sync if user presses F11 externally
            document.addEventListener('fullscreenchange', () => {
                fsToggle.checked = !!document.fullscreenElement;
                sm.graphics.fullscreen = fsToggle.checked;
            });
            fsToggle.addEventListener('change', () => {
                sm.graphics.fullscreen = fsToggle.checked;
                sm.applyGraphics();
            });
        }

        // ── Invert Mouse toggle ────────────────────────────────
        const invertToggle = document.getElementById('invert-mouse-toggle');
        if (invertToggle) {
            invertToggle.addEventListener('change', () => {
                sm.graphics.invertMouse = invertToggle.checked;
            });
        }

        // ── Mouse Sensitivity Slider ───────────────────────────
        const sensSlider = document.getElementById('mouse-sensitivity-slider');
        const sensValue = document.getElementById('mouse-sensitivity-value');
        if (sensSlider) {
            sensSlider.addEventListener('input', () => {
                const val = parseFloat(sensSlider.value);
                sensValue.textContent = `x${val.toFixed(1)}`;
                sm.graphics.sensitivity = val;
            });
        }

        // ── Save & Close ─────────────────────────────────────────
        const saveBtn = document.getElementById('settings-save-btn');
        if (saveBtn) {
            saveBtn.addEventListener('click', () => {
                sm.graphics.fullscreen = document.getElementById('fullscreen-toggle').checked;
                sm.graphics.invertMouse = document.getElementById('invert-mouse-toggle')?.checked ?? false;
                if (sensSlider) sm.graphics.sensitivity = parseFloat(sensSlider.value);
                sm.save();
                sm.applyGraphics();
                if (this.inputManager) sm.applyToInputManager(this.inputManager);
                document.getElementById('settings-panel').classList.add('hidden');
                document.getElementById('main-menu').classList.remove('hidden');
            });
        }

        // ── Restore Defaults ──────────────────────────────────────
        const restoreBtn = document.getElementById('settings-restore-btn');
        if (restoreBtn) {
            restoreBtn.addEventListener('click', () => {
                sm.restoreDefaults();
                document.getElementById('fullscreen-toggle').checked = false;
                const inv = document.getElementById('invert-mouse-toggle');
                if (inv) inv.checked = false;
                this._renderKeybindRows();
                if (this.inputManager) sm.applyToInputManager(this.inputManager);
            });
        }

        // Sync toggle states when opening
        document.getElementById('fullscreen-toggle').checked = sm.graphics.fullscreen;
        const invEl = document.getElementById('invert-mouse-toggle');
        if (invEl) invEl.checked = sm.graphics.invertMouse ?? false;

        if (sensSlider) {
            sensSlider.value = sm.graphics.sensitivity ?? 1.0;
            sensValue.textContent = `x${parseFloat(sensSlider.value).toFixed(1)}`;
        }

        // Apply saved settings on startup
        if (this.inputManager) sm.applyToInputManager(this.inputManager);
        sm.applyGraphics();
    }

    /**
     * Build keyboard binding table rows for all four groups:
     * Movement, Combat, System, and Free Roam Camera.
     * Called on open and after Restore Defaults.
     */
    _renderKeybindRows() {
        const sm = this.settingsManager;
        const groups = {
            'kb-movement-rows': ['moveForward', 'moveBackward', 'moveLeft', 'moveRight', 'jump'],
            'kb-combat-rows': ['fireMode1', 'fireMode2', 'fireMode3', 'fireMode4', 'toggleShield', 'holdShield'],
            'kb-system-rows': ['toggleCamera', 'respawn', 'openMenu'],
            'kb-freeroam-rows': ['freeRoamForward', 'freeRoamBackward', 'freeRoamLeft', 'freeRoamRight', 'camUp', 'camDown', 'freeRoamRecenter'],
        };

        for (const [tbodyId, actionIds] of Object.entries(groups)) {
            const tbody = document.getElementById(tbodyId);
            if (!tbody) continue;
            tbody.innerHTML = '';

            for (const actionId of actionIds) {
                const def = ACTIONS[actionId];
                if (!def) continue;
                const { defaultKey, customKey } = sm.getBinding(actionId);
                const displayDefault = def.displayDefault ?? defaultKey.toUpperCase();
                const displayCustom = customKey ? customKey.toUpperCase() : null;

                const tr = document.createElement('tr');
                tr.innerHTML = `
                    <td class="col-action">${def.label}</td>
                    <td class="col-default"><span class="key-badge">${displayDefault}</span></td>
                    <td class="col-custom">
                        <button
                            class="custom-bind-btn ${displayCustom ? 'assigned' : ''}"
                            data-action="${actionId}"
                        >${displayCustom ?? '+ Bind Key'}</button>
                    </td>
                `;
                tbody.appendChild(tr);

                const bindBtn = tr.querySelector('.custom-bind-btn');
                bindBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this._startKeyCapture(actionId, bindBtn);
                });
            }
        }
    }

    /**
     * Enter key-capture mode for a single bind button.
     * Listens for the next keydown; ESC cancels, any other key assigns.
     * Assigned state: button gets .assigned class and shows the key.
     * On re-click of an already assigned button → clear the custom bind.
     */
    _startKeyCapture(actionId, btnEl) {
        const sm = this.settingsManager;

        // If already assigned, clicking again clears the custom key
        if (btnEl.classList.contains('assigned')) {
            sm.clearCustomKey(actionId);
            btnEl.classList.remove('assigned');
            btnEl.textContent = '+ Bind Key';
            return;
        }

        // Prevent concurrent captures
        const existingListening = document.querySelector('.custom-bind-btn.listening');
        if (existingListening) return;

        const prevText = btnEl.textContent;
        btnEl.classList.add('listening');
        btnEl.textContent = 'Press a key…';

        const keydownHandler = (e) => {
            e.preventDefault();
            e.stopPropagation();
            window.removeEventListener('keydown', keydownHandler, true);
            btnEl.classList.remove('listening');
            btnEl.style.pointerEvents = '';

            if (e.key === 'Escape') {
                // Cancel — revert text
                btnEl.textContent = prevText;
                return;
            }

            const capturedKey = e.key.toLowerCase();
            sm.setCustomKey(actionId, capturedKey);

            const displayKey = (e.key === ' ') ? 'Space' : e.key.toUpperCase();
            btnEl.classList.add('assigned');
            btnEl.textContent = displayKey;
        };

        // Use capture phase so it fires before other listeners
        window.addEventListener('keydown', keydownHandler, true);
    }

    /**
     * Request Pointer Lock universally across all camera modes.
     */
    _applyPointerLock() {
        if (this.gameState !== 'playing') return;
        this.renderer.domElement.requestPointerLock();
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
    createHandRigs() {
        this.handRigs = [];

        // Shadow-only material: optically invisible, but rendered into shadow maps
        const shadowOnlyMat = new THREE.MeshStandardMaterial({
            color: 0x000000,
            transparent: true,
            opacity: 0.0,
            roughness: 1.0,
            metalness: 0.0,
        });

        const jointGeo = new THREE.SphereGeometry(0.22, 10, 10);

        // Cylinder geometry for bones.
        const boneGeo = new THREE.CylinderGeometry(0.22, 0.22, 1, 8);
        boneGeo.translate(0, 0.5, 0); // Translate so origin is at one end

        this.handConnections = [
            // Thumb
            [1, 2], [2, 3], [3, 4],
            // Index
            [5, 6], [6, 7], [7, 8],
            // Middle
            [9, 10], [10, 11], [11, 12],
            // Ring
            [13, 14], [14, 15], [15, 16],
            // Pinky
            [17, 18], [18, 19], [19, 20],

            // Palm Solid Fill
            [0, 1], [0, 5], [0, 9], [0, 13], [0, 17], // wrist to knuckles
            [1, 5], [5, 9], [9, 13], [13, 17],        // horizontal knuckle webbing
            [1, 17], [5, 17], [9, 17]                 // cross-palm fill
        ];

        for (let h = 0; h < 2; h++) {
            const rigGroup = new THREE.Group();
            const spheres = [];
            const bones = [];

            for (let i = 0; i < 21; i++) {
                const sphere = new THREE.Mesh(jointGeo, shadowOnlyMat);
                sphere.castShadow = true;
                sphere.receiveShadow = false;
                sphere.position.set(0, -10, 0); // Start out-of-frame
                rigGroup.add(sphere);
                spheres.push(sphere);
            }

            for (let i = 0; i < this.handConnections.length; i++) {
                const bone = new THREE.Mesh(boneGeo, shadowOnlyMat);
                bone.castShadow = true;
                bone.receiveShadow = false;
                bone.position.set(0, -10, 0);
                rigGroup.add(bone);
                bones.push(bone);
            }

            // Central palm volume proxy (slightly larger)
            const palmGeo = new THREE.SphereGeometry(0.2, 10, 10);
            const palm = new THREE.Mesh(palmGeo, shadowOnlyMat);
            palm.castShadow = true;
            palm.receiveShadow = false;
            palm.position.set(0, -10, 0);
            rigGroup.add(palm);

            this.scene.add(rigGroup);
            this.handRigs.push({ group: rigGroup, spheres, bones, palm });
        }
    }

    /**
     * Load GLB assets from the assets directory and configure shadow casting/receiving.
     */
    loadAssets(onComplete) {
        const loadingManager = new THREE.LoadingManager(
            () => {
                const bootOverlay = document.getElementById('boot-overlay');

                // CRITICAL GPU OPTIMIZATION: Force compilation of all complex ShaderMaterials off-screen completely synchronously BEFORE dropping the Loading UI.
                // This eliminates the savage lag spike when heavy Asteroid/Room geometry suddenly impacts the frustum natively!
                try {
                    this.renderer.compile(this.scene, this.camera);
                } catch (e) {
                    console.warn("GPU compilation hook suppressed:", e);
                }

                setTimeout(() => {
                    if (bootOverlay) {
                        bootOverlay.style.opacity = '0';
                        setTimeout(() => bootOverlay.style.display = 'none', 500);
                    }
                    if (onComplete) onComplete();
                }, 100);

                // Connect WebSocket strictly explicitly *after* physics loop unlocks
                this.connectTelemetry();
            },
            (url, itemsLoaded, itemsTotal) => {
                const bootProgress = document.getElementById('boot-progress-bar');
                const bootText = document.getElementById('boot-status-text');
                const percent = Math.floor((itemsLoaded / itemsTotal) * 100);
                if (bootProgress) bootProgress.style.width = percent + '%';
                if (bootText) bootText.textContent = `INITIALIZING SCENE... (${percent}%)`;
            }
        );

        const loader = new GLTFLoader(loadingManager);

        // Formally configure massive DRACO decompression WASM buffers natively to scale down loading times drastically block-by-block
        const dracoLoader = new DRACOLoader();
        dracoLoader.setDecoderPath('https://unpkg.com/three@0.165.0/examples/jsm/libs/draco/');
        loader.setDRACOLoader(dracoLoader);

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

                this.roomModel.updateMatrixWorld(true);
                this.roomModel.traverse((child) => {
                    if (child.isMesh) {
                        this.physicsWorld.addStaticTrimesh(child);
                        if (child.material) {
                            child.material.fog = false;
                            child.material.needsUpdate = true;
                        }
                    }
                });

                configureShadows(this.roomModel, false, true); // Room only receives shadows
                this.scene.add(this.roomModel);
                this.roomModel.traverse((child) => {
                    if (child.isMesh) {
                        this.collidableMeshes.push(child);
                    }
                });
                console.log('Loaded: Room Environment');

                // 2. Load Mecha — placed on the stairs (Moved inside Room load callback to ensure physics trimesh exists first)
                loader.load(
                    `${assetPath}mecha.glb`,
                    (gltf) => {
                        this.mechaWrapper = new THREE.Group();
                        this.mechaWrapper.position.set(0, 5, 2);
                        this.scene.add(this.mechaWrapper);

                        this.mechaModel = gltf.scene;
                        // Remove Math.PI rotation so it naturally faces its forward movement vector natively
                        this.mechaModel.rotation.set(0, 0, 0);
                        this.mechaModel.scale.set(0.6, 0.6, 0.6);
                        // Visually raise the mesh even higher so feet clear the geometry completely
                        this.mechaModel.position.set(0, 2.35, 0);

                        configureShadows(this.mechaModel, true, true);
                        this.mechaWrapper.add(this.mechaModel);

                        console.log('Loaded: Centerpiece Mecha');

                        // Initialize controller
                        this.mechaController = new MechaController(
                            this.scene,
                            this.physicsWorld,
                            this.camera,
                            this.mechaWrapper,
                            this.effects,
                            (pos, dir, mode) => this.spawnProjectile(pos, dir, mode)
                        );
                    },
                    undefined,
                    (error) => console.error('Error loading Mecha Model:', error)
                );
            },
            undefined,
            (error) => console.error('Error loading Room Model:', error)
        );

        // 3. Load Space Globe Background
        loader.load(
            `${assetPath}space_globe.glb`,
            (gltf) => {
                this.spaceBackground = gltf.scene;

                // Keep it at the origin, scale it to 500 
                this.spaceBackground.position.set(0, 0, 0);
                this.spaceBackground.scale.set(4500, 4500, 4500);

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

        // 4. Load Tires — scattered randomly across the void space
        loader.load(
            `${assetPath}game_ready_free_car_tires.glb`,
            (gltf) => {
                // Scatter 40 tire clones everywhere in the space globe
                for (let i = 0; i < 40; i++) {
                    const tireClone = gltf.scene.clone();

                    // Volumetric distribution: spread 300 units wide, 200 units tall
                    const rx = (Math.random() - 0.5) * 300;
                    const ry = -50 + Math.random() * 200;
                    const rz = (Math.random() - 0.5) * 300;

                    tireClone.position.set(rx, ry, rz);

                    // Random spherical tumbling rotations
                    tireClone.rotation.x = Math.random() * Math.PI * 2;
                    tireClone.rotation.y = Math.random() * Math.PI * 2;
                    tireClone.rotation.z = Math.random() * Math.PI * 2;

                    tireClone.scale.set(0.4, 0.4, 0.4);
                    configureShadows(tireClone, true, true);
                    this.scene.add(tireClone);

                    // Add to physics with a lighter mass of 5 for explosive deflection
                    const body = this.physicsWorld.addDynamicBody(tireClone, 5, 'cylinder', 0.4);
                    // Crucial: instruct Cannon.js anti-gravity fields in physics_world.js to suspend it
                    body.ignoreGravity = true;

                    // Eliminate vacuum friction so they coast infinitely
                    body.linearDamping = 0.0;
                    body.angularDamping = 0.0;

                    // Flag them for Lissajous swarm routing and map an arbitrary offset phase for visual randomness
                    body.isSwarmProp = true;
                    body.swarmPhaseOffset = Math.random() * 1000.0;

                    // Assign a slow perpetual tumble to tires
                    body.angularVelocity.set(
                        (Math.random() - 0.5) * 2,
                        (Math.random() - 0.5) * 2,
                        (Math.random() - 0.5) * 2
                    );
                }

                console.log('Loaded: 40 Zero-Gravity Tires Scattered in the Void');
            },
            undefined,
            (error) => console.error('Error loading Tires Model:', error)
        );

        // 4.5. Load 911 Singer Twin Turbo randomly tumbling in zero-g
        loader.load(
            'assets/porsche_911_singer_twin_turbo.glb',
            (gltf) => {
                const porscheClone = gltf.scene;

                // 1. Spawning right in front of the Mecha (Mecha is at 0, 5, 2 looking down Z)
                // We'll spawn it hovering perfectly in mid-air in front of the stairs!
                porscheClone.position.set(0, 15, -20);
                porscheClone.rotation.set(0, 0, 0); // Straight up

                // 2. Measure bounding and scale accurately compared to Mecha
                const pBox = new THREE.Box3().setFromObject(porscheClone);
                const pWidth = pBox.max.x - pBox.min.x;

                // Target width: 1.5 units (comparable to Mecha size)
                const pScale = 1.5 / pWidth;
                porscheClone.scale.set(pScale, pScale, pScale);

                // 3. Add Bright White Edge Detail Identifier
                porscheClone.traverse((child) => {
                    if (child.isMesh) {
                        const edges = new THREE.EdgesGeometry(child.geometry, 15);
                        const line = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0xffffff, linewidth: 2.0 }));
                        child.add(line);
                    }
                });

                configureShadows(porscheClone, true, true);
                this.scene.add(porscheClone);

                // Map reference for manual centripetal orbital pull!
                this.activePorscheObj = porscheClone;


                // Add to physics engine dynamically so bullets strike it
                const body = this.physicsWorld.addDynamicBody(porscheClone, 1500, 'sphere', 1.5);
                body.ignoreGravity = true;
                body.linearDamping = 0.0;
                body.angularDamping = 0.0;

                this.activePorscheBody = body;
                body.isSwarmProp = true;
                body.swarmPhaseOffset = 0.0; // Porsche follows the main path exactly

                body.velocity.set(
                    (Math.random() - 0.5) * 2.0,
                    (Math.random() - 0.5) * 2.0,
                    (Math.random() - 0.5) * 2.0
                );
                body.angularVelocity.set(
                    (Math.random() - 0.5),
                    (Math.random() - 0.5),
                    (Math.random() - 0.5)
                );

                console.log('Loaded: Zero-G Porsche Singer');
            },
            undefined,
            (error) => console.error('Error loading Porsche Model:', error)
        );

        // Universal Swarm Loader for injecting dynamic randomized geometry explicitly into the 3D Lissajous trajectory
        const spawnSwarmAsteroid = (fileName, targetWidth, mass) => {
            loader.load(
                `assets/${fileName}`,
                (gltf) => {
                    const astClone = gltf.scene;

                    // Compute absolute native scale to force specific size limits proportionally
                    astClone.updateMatrixWorld(true);
                    const pBox = new THREE.Box3().setFromObject(astClone);
                    const naturalWidth = pBox.max.x - pBox.min.x;
                    const pScale = targetWidth / naturalWidth;
                    astClone.scale.set(pScale, pScale, pScale);

                    // Randomly instantiate across the map initially
                    astClone.position.set(
                        (Math.random() - 0.5) * 400,
                        (Math.random() - 0.5) * 400,
                        (Math.random() - 0.5) * 400
                    );

                    // Suppress lighting/fog visual bleeding
                    astClone.traverse((child) => {
                        if (child.isMesh && child.material) child.material.fog = false;
                    });

                    configureShadows(astClone, true, true);
                    this.scene.add(astClone);

                    // Bind it strictly to the Cannon engine mapping its exact mesh limits to a bounding sphere for physics
                    const radiusScale = targetWidth * 0.5;
                    const body = this.physicsWorld.addDynamicBody(astClone, mass, 'sphere', radiusScale);

                    body.ignoreGravity = true;
                    body.linearDamping = 0.0;
                    body.angularDamping = 0.0;

                    // Bind exactly into the Lissajous loop!
                    body.isSwarmProp = true;
                    body.swarmPhaseOffset = Math.random() * 2000.0;

                    // Setup Kinetic Explosive Trigger native to the Cannon Event Framework!
                    body.addEventListener("collide", (e) => {
                        if (e.contact) {
                            const velocityImpact = Math.abs(e.contact.getImpactVelocityAlongNormal());
                            if (velocityImpact > 1.5) { // Threshold suppresses tiny gentle grazing bumps
                                const contactPoint = e.contact.rj;
                                const rigidPos = body.position;
                                // Resolve absolute geometry coordinate mapping
                                const visualImpactPoint = new THREE.Vector3(
                                    rigidPos.x + contactPoint.x,
                                    rigidPos.y + contactPoint.y,
                                    rigidPos.z + contactPoint.z
                                );
                                // Visually deploy the sparks/dust locally from effects.js!
                                if (this.effects) {
                                    this.effects.createExplosion(visualImpactPoint, 2);
                                }
                            }
                        }
                    });

                },
                undefined,
                (err) => console.error(`Error generating dynamic swarm object ${fileName}:`, err)
            );
        };

        // Mathematically deploy the structural varieties (2 clones of each to avoid utterly nuking the framerate)
        for (let i = 0; i < 2; i++) {
            // wandering_asteroids_of_andromeda -> Medium 
            spawnSwarmAsteroid('wandering_asteroids_of_andromeda.glb', 15.0, 800.0);

            // asteroid_field_100_x_medium-poly -> Small
            spawnSwarmAsteroid('asteroid_field_100_x_medium-poly.glb', 40.0, 1500.0);

            // asteroid.glb -> Big 
            spawnSwarmAsteroid('asteroid.glb', 25.0, 2500.0);
        }



        // 5. Load City Map
        loader.load(
            `${assetPath}scene.gltf`,
            (gltf) => {
                this.cityMap = gltf.scene;

                // Position roughly at first so we can compute the world bounding box
                this.cityMap.position.set(0, -450, 0);

                // Scale adjusted to be perfectly in the middle (between 5 and 50).
                this.cityMap.scale.set(27.5, 27.5, 27.5);

                // Rotate the map 180 degrees as requested.
                this.cityMap.rotation.y = Math.PI;

                // Compute exact geometric center 
                this.cityMap.updateMatrixWorld(true);
                const cityBox = new THREE.Box3().setFromObject(this.cityMap);
                const cityCenter = cityBox.getCenter(new THREE.Vector3());

                // Offset model so its geometric center is exactly at (0, -450, 0)
                // which perfectly aligns beneath the urban room's origin position (0, -2.7, 0)
                this.cityMap.position.x += (0 - cityCenter.x);
                this.cityMap.position.y += (-450 - cityCenter.y);
                this.cityMap.position.z += (0 - cityCenter.z);

                // Prevent fog from completely hiding the distant city map
                this.cityMap.traverse((child) => {
                    if (child.isMesh && child.material) {
                        child.material.fog = false;
                    }
                });

                let blueGlowMesh = null;
                this.cityMap.traverse((child) => {
                    if (child.isMesh && (child.name.includes('Earth') || (child.material && child.material.name.includes('Earth')))) {
                        blueGlowMesh = child;
                    }
                });

                if (blueGlowMesh) {
                    // Update matrices to ensure accurate world positions
                    this.cityMap.updateMatrixWorld(true);

                    const worldPos = new THREE.Vector3();
                    blueGlowMesh.getWorldPosition(worldPos);

                    // We want to move it to exactly (0, -480, 0) in world space
                    const worldOffset = new THREE.Vector3(0 - worldPos.x, -480 - worldPos.y, 0 - worldPos.z);

                    // Convert that world shift into its exact local shift
                    const parentQuat = new THREE.Quaternion();
                    blueGlowMesh.parent.getWorldQuaternion(parentQuat);

                    const parentScale = new THREE.Vector3();
                    blueGlowMesh.parent.getWorldScale(parentScale);

                    const localOffset = worldOffset.applyQuaternion(parentQuat.invert()).divide(parentScale);

                    // Safely apply the shift without breaking its parent rotations (which kept it flat on the ground)
                    blueGlowMesh.position.add(localOffset);
                }

                this.scene.add(this.cityMap);
                this.cityMap.traverse((child) => {
                    if (child.isMesh) {
                        this.collidableMeshes.push(child);
                    }
                });
                console.log('Loaded: City Map');
            },
            undefined,
            (error) => {
                console.error('Error loading City Map due to LFS pointer mismatch:', error);
            }
        );

        const loadHoveringBuilding = (fileName, scale, fixedPos) => {
            loader.load(
                `${assetPath}${fileName}`,
                (gltf) => {
                    const building = gltf.scene;
                    building.position.copy(fixedPos);
                    building.scale.set(scale, scale, scale);
                    building.rotation.y = (fixedPos.x * fixedPos.z) % (Math.PI * 2);

                    // Ensure world matrices are computed before passing to physics
                    building.updateMatrixWorld(true);

                    // Add trimesh physics to each mesh in the building to ensure
                    // it does not move and has surface-level collision accuracy.
                    building.traverse((child) => {
                        if (child.isMesh) {
                            this.physicsWorld.addStaticTrimesh(child);

                            // Override material to prevent fading into the background void
                            if (child.material) {
                                child.material.fog = false;
                                child.material.emissive = new THREE.Color(0x353535);
                                child.material.needsUpdate = true;
                            }
                        }
                    });

                    configureShadows(building, true, true);
                    this.scene.add(building);

                    console.log(`Loaded hovering asset at (${fixedPos.x.toFixed(0)}, ${fixedPos.y.toFixed(0)}, ${fixedPos.z.toFixed(0)}): ${fileName}`);
                },
                undefined,
                (error) => console.error(`Error loading physics building ${fileName}:`, error)
            );
        };

        // Pass the filename, scale, and a fixed position hovering randomly in space away from the hall
        loadHoveringBuilding('building.glb', 10.0, new THREE.Vector3(-150, 60, -250));
        loadHoveringBuilding('brutalist_building.glb', 10.0, new THREE.Vector3(200, 80, -180));
        loadHoveringBuilding('brutalist_building_1.glb', 10.0, new THREE.Vector3(120, 50, 220));

        // Load Massive Asteroid
        loader.load('assets/asteroid_42.glb', (gltf) => {
            const asteroid = gltf.scene;

            // 1. Group to handle looping sweeping rotation natively
            const orbitPivot = new THREE.Group();
            this.scene.add(orbitPivot);

            // Restoring pure vertical geometry and rotating 180 degrees natively across the internal vertical Y-axis
            asteroid.rotation.set(0, Math.PI, 0);
            asteroid.updateMatrixWorld(true);

            // 2. Measure dimensions natively on Y
            const box = new THREE.Box3().setFromObject(asteroid);
            const naturalHeight = box.max.y - box.min.y;

            // 3. Medium sizing logic mapping directly against the vertical stretch
            const targetScale = 1000.0 / naturalHeight;
            asteroid.scale.set(targetScale, targetScale, targetScale);

            // 4. Drop the structural altitude natively downwards from the top of the globe
            // Statically pull it outwards locally so it circles the room horizontally
            asteroid.position.set(-300, 100, 400);

            // Explicitly force position and scale parameters to mathematically resolve in engine before extracting vertices for Cannon JS Trimesh!
            asteroid.updateMatrixWorld(true);

            // Strip fog for total visibility from the ground
            asteroid.traverse((child) => {
                if (child.isMesh) {
                    if (child.material) child.material.fog = false;
                    this.physicsWorld.addStaticTrimesh(child);
                    this.collidableMeshes.push(child);
                }
            });

            orbitPivot.add(asteroid);
            this.activeAsteroidOrbit = orbitPivot;
            this.activeAsteroidMesh = asteroid;
        });

        // Load Second Asteroid (Tunnel System) explicit bypass
        loader.load('assets/asteroid_with_internal_tunnel_system.glb', (gltf) => {
            const tunnelAsteroid = gltf.scene;
            // Force horizontal alignment exactly like original asteroid parameters
            tunnelAsteroid.rotation.set(0, 0, 0);
            tunnelAsteroid.updateMatrixWorld(true);

            const tBox = new THREE.Box3().setFromObject(tunnelAsteroid);
            const naturalHeight = tBox.max.y - tBox.min.y;

            const targetScale = 200.0 / naturalHeight;
            tunnelAsteroid.scale.set(targetScale, targetScale, targetScale);

            // Physically buried directly underneath the atmospheric bounds of the hovering halls
            tunnelAsteroid.position.set(150, -200, 0);

            // Explicitly force position and scale parameters to mathematically resolve in engine before extracting vertices for Cannon JS Trimesh!
            tunnelAsteroid.updateMatrixWorld(true);

            tunnelAsteroid.traverse((child) => {
                if (child.isMesh) {
                    // Procedurally strip the native generic GLTF material wrapper and mathematically generate a jagged rock texture
                    child.material = new THREE.MeshStandardMaterial({
                        color: 0x47423d,        // Deep meteorite grey-brown
                        roughness: 0.95,        // Utterly unreflective
                        metalness: 0.1,         // Flat rock consistency
                        flatShading: true,      // Forces every single geometric polygon to render distinctly (creating jagged crags artificially!)
                        fog: false
                    });

                    // Enforce geometry update so flat shading computes strictly against the vertices inherently
                    if (child.geometry) child.geometry.computeVertexNormals();

                    // Generate complete raw terrain collisions inside the structural crater natively
                    this.physicsWorld.addStaticTrimesh(child);
                    this.collidableMeshes.push(child);
                }
            });

            this.scene.add(tunnelAsteroid);
            this.activeTunnelAsteroidMesh = tunnelAsteroid;
        });
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

                if (data.hands) {
                    this.latestHands = data.hands;
                    this.hudHand.textContent = `${data.hands.length} detected`;

                    if (this.inputManager && data.hands.length > 0) {
                        const hand = data.hands[0];
                        const gestures = hand.gesture ? [hand.gesture] : [];

                        // Map hand center to world space aim target (e.g., Z=-10)
                        const hx = THREE.MathUtils.mapLinear(hand.center.x, -1.0, 1.0, OCCLUDER_MIN_X, OCCLUDER_MAX_X);
                        const hy = THREE.MathUtils.mapLinear(hand.center.y, -1.0, 1.0, OCCLUDER_MIN_Y, OCCLUDER_MAX_Y);
                        const targetPos = new THREE.Vector3(hx, hy, -10);

                        this.inputManager.updateGestures(gestures, targetPos);
                    }
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
     * with integrated spherical mouse orbit control and continuous free-roam movement.
     */

    /**
     * Helper to perform GTA-style physical raycast bouncing for the camera against solid environment meshes.
     */
    _applyCameraCollision(centerPoint, idealPos) {
        if (!this.collidableMeshes || this.collidableMeshes.length === 0) return idealPos.clone();

        const dist = centerPoint.distanceTo(idealPos);
        if (dist <= 0.1) return idealPos.clone();

        const dir = new THREE.Vector3().subVectors(idealPos, centerPoint).normalize();
        if (!this.camRaycaster) {
            this.camRaycaster = new THREE.Raycaster();
        }
        this.camRaycaster.set(centerPoint, dir);
        this.camRaycaster.far = dist;

        const hits = this.camRaycaster.intersectObjects(this.collidableMeshes, true);
        if (hits.length > 0) {
            const safeDist = Math.max(0.0, hits[0].distance - 0.25);
            return centerPoint.clone().add(dir.multiplyScalar(safeDist));
        }
        return idealPos.clone();
    }

    applyParallax(dt) {
        const width = window.innerWidth;
        const height = window.innerHeight;

        // Continuous input-driven free roam offset
        if (this.cameraMode === 0 && this.gameState === 'playing' && this.inputManager) {
            const moveSpeed = 15.0 * (dt || 1 / 60);

            const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
            const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);

            // True 3D Flight forward calculation (do NOT flatten Y)
            const trueForward = forward.clone().normalize();

            // Ground-flattened variables for standard Numpad movement
            forward.y = 0; right.y = 0;
            forward.normalize(); right.normalize();

            const acts = this.inputManager.actions;

            if (acts['frFlight']) {
                const flightSpeed = 35.0 * (dt || 1 / 60);
                this.freeRoamOffset.add(trueForward.multiplyScalar(flightSpeed));
            }

            if (acts['frForward']) this.freeRoamOffset.add(forward.clone().multiplyScalar(moveSpeed));
            if (acts['frBackward']) this.freeRoamOffset.sub(forward.clone().multiplyScalar(moveSpeed));
            if (acts['frLeft']) this.freeRoamOffset.sub(right.clone().multiplyScalar(moveSpeed));
            if (acts['frRight']) this.freeRoamOffset.add(right.clone().multiplyScalar(moveSpeed));

            const rotSpeed = 2.0 * (dt || 1 / 60);
            if (acts['frRotLeft']) this.orbitYaw += rotSpeed;
            if (acts['frRotRight']) this.orbitYaw -= rotSpeed;

            if (acts['frUp']) this.freeRoamOffset.y += moveSpeed;
            if (acts['frDown']) this.freeRoamOffset.y -= moveSpeed;

            if (acts['frRecenter']) this.isRecentering = true;
        }

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

        // Auto-recenter logic
        if (this.isRecentering && this.mechaController && this.mechaController.mesh) {
            const mechaPos = this.mechaController.mesh.position;
            // Target is mecha pos, but down slightly so the orbit center matches
            const targetOffset = mechaPos.clone().sub(new THREE.Vector3(0, 1.5, 0));
            this.freeRoamOffset.lerp(targetOffset, 0.1);
            if (this.freeRoamOffset.distanceTo(targetOffset) < 0.1) {
                this.isRecentering = false;
            }
        }

        let targetCamX = this.freeRoamOffset.x + orbitX + (parallaxX * rightX);
        let targetCamY = this.freeRoamOffset.y + orbitY + parallaxY;
        let targetCamZ = this.freeRoamOffset.z + orbitZ + (parallaxX * rightZ);

        // --- GTA-Style Camera Collision Raycasting ---
        if (this.collidableMeshes && this.collidableMeshes.length > 0) {
            const centerPoint = new THREE.Vector3(this.freeRoamOffset.x, this.freeRoamOffset.y + 1.5, this.freeRoamOffset.z);
            const idealPos = new THREE.Vector3(targetCamX, targetCamY, targetCamZ);
            const dist = centerPoint.distanceTo(idealPos);

            if (dist > 0.1) {
                const dir = new THREE.Vector3().subVectors(idealPos, centerPoint).normalize();
                if (!this.camRaycaster) {
                    this.camRaycaster = new THREE.Raycaster();
                }
                this.camRaycaster.set(centerPoint, dir);
                this.camRaycaster.far = dist;

                const hits = this.camRaycaster.intersectObjects(this.collidableMeshes, true);
                if (hits.length > 0) {
                    // Push camera slightly inward off the wall, collapsing entirely to centerPoint if necessary
                    const safeDist = Math.max(0.0, hits[0].distance - 0.25);
                    const safePos = centerPoint.clone().add(dir.multiplyScalar(safeDist));
                    targetCamX = safePos.x;
                    targetCamY = safePos.y;
                    targetCamZ = safePos.z;
                }
            }
        }

        // Force direct geometry mappings with precisely ZERO camera interpolation lag physically clamping the position vector natively!
        this.camera.position.set(targetCamX, targetCamY, targetCamZ);

        // Perform Asymmetric Frustum Warping (Off-Axis Projection)
        const xOffset = -this.latestHead.x * FRUSTUM_WARP_SENSITIVITY_X;
        const yOffset = this.latestHead.y * FRUSTUM_WARP_SENSITIVITY_Y;

        this.camera.setViewOffset(
            width, height,
            xOffset, yOffset,
            width, height
        );

        // Camera always looks at the orbit center
        this.camera.lookAt(this.freeRoamOffset.x, this.freeRoamOffset.y + 1.5, this.freeRoamOffset.z);
    }

    /**
     * Process Hand coordinates and relocate the 21-joint skeleton occluder.
     */
    applyShadowOcclusion() {
        const up = new THREE.Vector3(0, 1, 0);

        for (let h = 0; h < 2; h++) {
            const rig = this.handRigs[h];
            const handData = (this.latestHands && h < this.latestHands.length) ? this.latestHands[h] : null;

            if (handData && handData.landmarks && handData.landmarks.length === 21) {
                // Position all 21 individual joint spheres
                for (let i = 0; i < 21; i++) {
                    const lm = handData.landmarks[i];
                    const lmX = THREE.MathUtils.mapLinear(lm.x, -1.0, 1.0, OCCLUDER_MIN_X, OCCLUDER_MAX_X);
                    const lmY = THREE.MathUtils.mapLinear(lm.y, -1.0, 1.0, OCCLUDER_MIN_Y, OCCLUDER_MAX_Y);
                    const lmZ = THREE.MathUtils.mapLinear(lm.z, -1.0, 1.0, OCCLUDER_MIN_Z, OCCLUDER_MAX_Z);

                    const sphere = rig.spheres[i];
                    sphere.position.x += (lmX - sphere.position.x) * 0.35;
                    sphere.position.y += (lmY - sphere.position.y) * 0.35;
                    sphere.position.z += (lmZ - sphere.position.z) * 0.35;
                }

                // Update bones based on spheres positions
                for (let i = 0; i < this.handConnections.length; i++) {
                    const [idxA, idxB] = this.handConnections[i];
                    const posA = rig.spheres[idxA].position;
                    const posB = rig.spheres[idxB].position;

                    const bone = rig.bones[i];
                    const distance = posA.distanceTo(posB);
                    if (distance > 0.001) {
                        bone.position.copy(posA);
                        bone.scale.set(1, distance, 1);

                        const dir = new THREE.Vector3().subVectors(posB, posA).normalize();
                        bone.quaternion.setFromUnitVectors(up, dir);
                    }
                }

                // Update palm position (average of key points)
                const palmIndices = [0, 5, 9, 13, 17];
                const palmCenter = new THREE.Vector3();
                for (const idx of palmIndices) {
                    palmCenter.add(rig.spheres[idx].position);
                }
                palmCenter.divideScalar(palmIndices.length);
                rig.palm.position.copy(palmCenter);

            } else {
                // Smoothly return all occluders out of frame when no hand detected
                for (let i = 0; i < rig.spheres.length; i++) {
                    const sphere = rig.spheres[i];
                    sphere.position.y += (-10.0 - sphere.position.y) * 0.1;
                }
                for (let i = 0; i < rig.bones.length; i++) {
                    const bone = rig.bones[i];
                    bone.position.y += (-10.0 - bone.position.y) * 0.1;
                }
                rig.palm.position.y += (-10.0 - rig.palm.position.y) * 0.1;
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
     * Spawns a projectile with mode-specific visuals, speed, and impact explosion.
     * @param {THREE.Vector3} position - Barrel tip world position
     * @param {THREE.Vector3} direction - Unit direction vector
     * @param {number} fireMode - 1=Plasma, 2=Rapid, 3=Spread, 4=Charged
     */
    spawnProjectile(position, direction, fireMode = 1) {
        // Tuned stats based on user request (Boosted ranges to survive the entire Void expanse)
        const speeds = { 1: 120, 2: 180, 3: 65, 4: 10 };
        const radii = { 1: 0.22, 2: 0.10, 3: 0.16, 4: 0.55 };
        const lifetimes = { 1: 15000, 2: 10000, 3: 2500, 4: 2000 };
        const scores = { 1: 10, 2: 5, 3: 8, 4: 25 };

        const speed = speeds[fireMode] ?? 22;
        const radius = radii[fireMode] ?? 0.22;
        const lifetime = lifetimes[fireMode] ?? 3000;

        // Mode 3 — Spread: fire 3 projectiles in a fan
        if (fireMode === 3) {
            const spread = 0.12;
            const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
            [-1, 0, 1].forEach(offset => {
                const fanned = direction.clone().addScaledVector(right, offset * spread).normalize();
                this.spawnProjectile(position, fanned, 30); // Mode 30 = spread sub-pellet
            });
            return;
        }

        // Resolve visual config (sub-mode 30 = spread pellet, use mode 3 look)
        const visualMode = fireMode === 30 ? 3 : fireMode;
        const mesh = this.effects.createProjectileMesh(visualMode);
        mesh.position.copy(position);

        // Orient the projectile mesh (+Z) to point along the flight direction
        mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), direction);
        this.scene.add(mesh);

        const body = this.physicsWorld.addDynamicBody(mesh, 0.5, 'sphere', radius);

        // Projectiles are Group 2, only collide with Environment (Group 1)
        body.collisionFilterGroup = 2;
        body.collisionFilterMask = 1;

        body.velocity.set(direction.x * speed, direction.y * speed, direction.z * speed);
        body.linearDamping = fireMode === 4 ? 0.6 : 0.0; // charged grenade has heavy air drag

        // Modes 1, 2, 3 fly in a straight laser line — neutralize gravity
        if (fireMode !== 4) {
            body.ignoreGravity = true;
        }

        // Auto-remove
        setTimeout(() => {
            if (mesh.parent) this.scene.remove(mesh);
        }, fireMode === 30 ? 1800 : lifetime);

        // Collision → explosion
        body.addEventListener('collide', () => {
            if (mesh.parent) {
                this.effects.createExplosion(mesh.position.clone(), visualMode);
                this.scene.remove(mesh);
                this.score += scores[fireMode] ?? 10;
                document.getElementById('score').textContent = this.score;
            }
        });
    }


    /**
     * Main Animation & Render loop. Runs at browser vertical refresh rate.
     */
    animate() {
        requestAnimationFrame(() => this.animate());

        const now = performance.now();
        const dt = (now - this.lastTime) / 1000;
        this.lastTime = now;

        // 1. Update camera based on mode
        switch (this.cameraMode) {
            case 0: // Free Roam
                // Apply dynamic camera parallax and offset calculations
                this.applyParallax(dt);

                // Override camera if hand gesture aiming in Free Roam
                if (this.inputManager && this.inputManager.gestureAimActive) {
                    if (this.handRigs.length > 0) {
                        const rig = this.handRigs[0];
                        const palmPos = rig.palm.position;
                        if (palmPos.y > -5) {
                            const targetCamPos = new THREE.Vector3(palmPos.x, palmPos.y + 0.5, palmPos.z + 2);
                            this.camera.position.lerp(targetCamPos, 0.1);
                            this.camera.lookAt(palmPos.x, palmPos.y, palmPos.z - 10);
                        }
                    }
                }
                break;

            case 1: // Third Person — orbit camera around mecha using orbitYaw/orbitPitch
                if (this.mechaController && this.mechaController.mesh) {
                    const mechaPos = this.mechaController.mesh.position;

                    // Build orbit quaternion from independent yaw/pitch
                    const yawQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.orbitYaw);
                    const pitchQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), this.orbitPitch);
                    const orbitQuat = yawQuat.multiply(pitchQuat);

                    const offset = new THREE.Vector3(0, 4.35, -6).applyQuaternion(orbitQuat);
                    let targetCamPos = mechaPos.clone().add(offset);
                    const centerPoint = mechaPos.clone().add(new THREE.Vector3(0, 4.35, 0));
                    targetCamPos = this._applyCameraCollision(centerPoint, targetCamPos);
                    this.camera.position.lerp(targetCamPos, 0.12);
                    this.camera.lookAt(mechaPos.clone().add(new THREE.Vector3(0, 3.85, 0)));
                    this.camera.clearViewOffset();
                }
                break;

            case 2: // First Person — cockpit position, look along orbit yaw
                if (this.mechaController && this.mechaController.mesh) {
                    const mechaPos = this.mechaController.mesh.position;

                    const yawQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.orbitYaw);
                    const pitchQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), this.orbitPitch);
                    const orbitQuat = yawQuat.multiply(pitchQuat);

                    const headOffset = new THREE.Vector3(0, 4.15, 0.3).applyQuaternion(orbitQuat);
                    const targetCamPos = mechaPos.clone().add(headOffset);
                    this.camera.position.copy(targetCamPos);

                    const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(orbitQuat);
                    this.camera.lookAt(targetCamPos.clone().add(forward.multiplyScalar(10)));
                    this.camera.clearViewOffset();
                }
                break;

            case 3: // Aiming View — tight over-shoulder, orbit-driven
                if (this.mechaController && this.mechaController.mesh) {
                    const mechaPos = this.mechaController.mesh.position;

                    const yawQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.orbitYaw);
                    const pitchQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), this.orbitPitch);
                    const orbitQuat = yawQuat.multiply(pitchQuat);

                    const shoulderOffset = new THREE.Vector3(0.8, 4.15, -2.8).applyQuaternion(orbitQuat);
                    let targetCamPos = mechaPos.clone().add(shoulderOffset);
                    const centerPoint = mechaPos.clone().add(new THREE.Vector3(0, 4.15, 0));
                    targetCamPos = this._applyCameraCollision(centerPoint, targetCamPos);
                    this.camera.position.lerp(targetCamPos, 0.18);

                    const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(orbitQuat);
                    this.camera.lookAt(targetCamPos.clone().add(forward.multiplyScalar(50)));
                    this.camera.clearViewOffset();
                }
                break;
        }

        // 2. Adjust dynamic shadow physics occluder positions
        this.applyShadowOcclusion();

        // 3. Update Physics and Logic (Always loops, even under menu)
        if (this.physicsWorld) this.physicsWorld.step(dt);
        if (this.inputManager) {
            // Provide collidable meshes for mouse raycasting
            const interactables = [];
            if (this.roomModel) interactables.push(this.roomModel);

            // Only process input manager updates if the menu is NOT open
            const menuOpen = !document.getElementById('main-menu').classList.contains('hidden');
            if (!menuOpen) {
                this.inputManager.update(interactables, this.cameraMode);
            }
        }

        // Mecha physics keep updating
        if (this.mechaController) {
            const menuOpen = !document.getElementById('main-menu').classList.contains('hidden');
            if (menuOpen) {
                // Clear inputs if menu is open so it stops walking/shooting
                this.inputManager.keys['w'] = false;
                this.inputManager.keys['s'] = false;
                this.inputManager.keys['a'] = false;
                this.inputManager.keys['d'] = false;
                this.inputManager.isShooting = false;
            }
            this.mechaController.update(this.inputManager, dt);
        }
        if (this.effects) this.effects.update(dt);

        // 4. Render main loop frame
        if (this.activeAsteroidOrbit) {
            // Sweeps massive horizontal orbit
            // Slowly tumbling internally
        }
        // Swarm all background zero-g components cleanly using 3D Lissajous path curves
        const baseTime = performance.now() * 0.00015; // Slow down orbital speed drastically
        for (let pair of this.physicsWorld.dynamicBodies) {
            if (pair.body.isSwarmProp) {
                const b = pair.body;
                const t = baseTime + b.swarmPhaseOffset;

                // Extremely erratic, shifting 3D geometry curve 
                // X radius constantly scales dynamically between -300 and 300 while crossing paths
                const targetX = Math.sin(t * 0.3) * Math.cos(t * 0.1) * 600;
                // Z radius swoops elliptically
                const targetZ = Math.cos(t * 0.4) * Math.sin(t * 0.15) * 600;
                // Y radius undulates massively from altitude 50 to 350
                const targetY = 150 + Math.sin(t * 0.2) * 200;

                // Generate a highly flexible spring force towards the random target node
                const dtF = 5.0; // Slow down the pull tension by 10x!
                const forceX = (targetX - b.position.x) * dtF;
                const forceY = (targetY - b.position.y) * dtF;
                const forceZ = (targetZ - b.position.z) * dtF;

                b.applyForce(new CANNON.Vec3(forceX, forceY, forceZ), b.position);

                // Ensure they don't break velocity limits when drifting tightly
                if (b.velocity.length() > 20) {
                    b.velocity.scale(0.95, b.velocity); // Cap orbital max velocity for smooth drift
                }

                // Force extremely slow, majestic cinematic tumbling universally inside Swarm physics arrays
                if (b.angularVelocity.length() > 0.02) { // 0.02 radians/sec ~ 1 degree per second max speed for giant boulders
                    b.angularVelocity.scale(0.85, b.angularVelocity);
                }

                // If it is the Porsche, explicitly steer its visual chassis directly into the wind vector smoothly
                if (b === this.activePorscheBody) {
                    const fw = b.velocity.clone();
                    // Cancel internal angular spin conflicts
                    b.angularVelocity.set(0, 0, 0);

                    if (fw.lengthSquared() > 0.1) {
                        fw.normalize();
                        // Orient the chassis facing the velocity mathematically
                        const targetQuat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(fw.x, fw.y, fw.z));
                        const bodyQ = new THREE.Quaternion(b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w);
                        bodyQ.slerp(targetQuat, 0.005); // EXTREMELY slow turning radius! 
                        b.quaternion.set(bodyQ.x, bodyQ.y, bodyQ.z, bodyQ.w);
                    }
                }
            }
        }

        this.renderer.render(this.scene, this.camera);

        // 5. Update Diagnostics
        this.updateFpsHud();
    }
}

// Instantiate scene manager once document loaded
window.addEventListener('DOMContentLoaded', () => {
    new DioramaScene();
});
