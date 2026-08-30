/**
 * VEDHARPAN — SettingsManager
 *
 * Manages all user-configurable settings: Graphics & Control bindings.
 * Settings are persisted to localStorage under the key 'vedharpan_settings'.
 *
 * Key-binding schema:
 *   Each action has a `defaultKey` (always present, read-only in UI)
 *   and an optional `customKey` (null = unset, user-assigned otherwise).
 *
 * In-game, BOTH the defaultKey AND the customKey trigger the action.
 */

export const ACTIONS = {
    // ── Movement ──────────────────────────────────────────────────────────
    moveForward: { label: 'Move Forward', group: 'movement', defaultKey: 'w' },
    moveBackward: { label: 'Move Backward', group: 'movement', defaultKey: 's' },
    moveLeft: { label: 'Move Left', group: 'movement', defaultKey: 'a' },
    moveRight: { label: 'Move Right', group: 'movement', defaultKey: 'd' },
    jump: { label: 'Jump', group: 'movement', defaultKey: ' ', displayDefault: 'Space' },

    // ── Combat ────────────────────────────────────────────────────────────
    fireMode1: { label: 'Fire Mode: Plasma', group: 'combat', defaultKey: '1' },
    fireMode2: { label: 'Fire Mode: Rapid', group: 'combat', defaultKey: '2' },
    fireMode3: { label: 'Fire Mode: Missile', group: 'combat', defaultKey: '3' },
    fireMode4: { label: 'Fire Mode: Grenade', group: 'combat', defaultKey: '4' },
    toggleShield: { label: 'Toggle Shield', group: 'combat', defaultKey: 'q', displayDefault: 'Q' },
    holdShield: { label: 'Hold Shield (Interrupt)', group: 'combat', defaultKey: 'e', displayDefault: 'E' },

    // ── Camera / System ───────────────────────────────────────────────────
    toggleCamera: { label: 'Toggle Camera Mode', group: 'system', defaultKey: 'v', displayDefault: 'V' },
    togglePhysicsCloak: { label: 'Toggle Physics Cloak', group: 'system', defaultKey: '`', displayDefault: '`' },
    respawn: { label: 'Respawn Mecha', group: 'system', defaultKey: 'n', displayDefault: 'N' },
    openMenu: { label: 'Open / Close Menu', group: 'system', defaultKey: 'escape', displayDefault: 'Escape' },

    // ── Free Roam Camera (Numpad) ─────────────────────────────────────────
    frForward: { label: 'Free Roam: Move Forward', group: 'freeRoam', defaultKey: 'numpad8', displayDefault: 'Num 8' },
    frBackward: { label: 'Free Roam: Move Backward', group: 'freeRoam', defaultKey: 'numpad2', displayDefault: 'Num 2' },
    frLeft: { label: 'Free Roam: Strafe Left', group: 'freeRoam', defaultKey: 'numpad1', displayDefault: 'Num 1' },
    frRight: { label: 'Free Roam: Strafe Right', group: 'freeRoam', defaultKey: 'numpad3', displayDefault: 'Num 3' },
    frRotLeft: { label: 'Free Roam: Rotate Left', group: 'freeRoam', defaultKey: 'numpad4', displayDefault: 'Num 4' },
    frRotRight: { label: 'Free Roam: Rotate Right', group: 'freeRoam', defaultKey: 'numpad6', displayDefault: 'Num 6' },
    frUp: { label: 'Free Roam: Camera Up', group: 'freeRoam', defaultKey: 'numpad7', displayDefault: 'Num 7' },
    frDown: { label: 'Free Roam: Camera Down', group: 'freeRoam', defaultKey: 'numpad9', displayDefault: 'Num 9' },
    frFlight: { label: 'Free Roam: Flight Mode', group: 'freeRoam', defaultKey: 'tab', displayDefault: 'Tab' },
    frRecenter: { label: 'Free Roam: Recenter', group: 'freeRoam', defaultKey: 'numpad5', displayDefault: 'Num 5' },

    // ── Flight Mode ────────────────────────────────────────────────────
    toggleFlight: { label: 'Toggle Flight Mode', group: 'flight', defaultKey: 'f', displayDefault: 'F' },
    flightUp: { label: 'Flight: Ascend', group: 'flight', defaultKey: 'numpad8', displayDefault: 'Num 8' },
    flightDown: { label: 'Flight: Descend', group: 'flight', defaultKey: 'numpad2', displayDefault: 'Num 2' },
    flightTurnLeft: { label: 'Flight: Yaw Left', group: 'flight', defaultKey: 'numpad4', displayDefault: 'Num 4' },
    flightTurnRight: { label: 'Flight: Yaw Right', group: 'flight', defaultKey: 'numpad6', displayDefault: 'Num 6' },
    flightBoost: { label: 'Flight: Speed Boost', group: 'flight', defaultKey: 'shiftleft', displayDefault: 'Left Shift' },
};

// ── Default graphics / mouse settings ────────────────────────────────────────
const DEFAULT_GRAPHICS = {
    fullscreen: false,
    invertMouse: true,
    sensitivity: 1.0
};

// ── localStorage key ──────────────────────────────────────────────────────────
const STORAGE_KEY = 'vedharpan_settings';

export class SettingsManager {
    constructor() {
        this.graphics = { ...DEFAULT_GRAPHICS };

        /** @type {Record<string, string|null>} actionId -> customKey (lowercased) */
        this.customKeys = {};

        this.load();
    }

    // ── Persistence ───────────────────────────────────────────────────────────

    load() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return;
            const saved = JSON.parse(raw);
            if (saved.graphics) Object.assign(this.graphics, saved.graphics);
            if (saved.customKeys) Object.assign(this.customKeys, saved.customKeys);
        } catch (e) {
            console.warn('[SettingsManager] Failed to load settings:', e);
        }
    }

    save() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify({
                graphics: this.graphics,
                customKeys: this.customKeys,
            }));
        } catch (e) {
            console.warn('[SettingsManager] Failed to save settings:', e);
        }
    }

    restoreDefaults() {
        this.graphics = { ...DEFAULT_GRAPHICS };
        this.customKeys = {};
        this.save();
    }

    // ── Key helpers ───────────────────────────────────────────────────────────

    /** Returns { defaultKey, customKey } for an action id */
    getBinding(actionId) {
        return {
            defaultKey: ACTIONS[actionId]?.defaultKey ?? null,
            customKey: this.customKeys[actionId] ?? null,
        };
    }

    setCustomKey(actionId, key) {
        if (key === null || key === '') {
            delete this.customKeys[actionId];
        } else {
            this.customKeys[actionId] = key.toLowerCase();
        }
    }

    clearCustomKey(actionId) {
        delete this.customKeys[actionId];
    }

    /**
     * Build a flat map of {lowercaseKey -> actionId} covering
     * BOTH default and custom keys. Used by InputManager and scene.js
     * to resolve any pressed key to an action.
     */
    buildKeyToActionMap() {
        const map = {};
        for (const [actionId, def] of Object.entries(ACTIONS)) {
            if (def.defaultKey) map[def.defaultKey.toLowerCase()] = actionId;
            const custom = this.customKeys[actionId];
            if (custom) map[custom.toLowerCase()] = actionId;
        }
        return map;
    }

    // ── Apply to InputManager ─────────────────────────────────────────────────

    /**
     * Push the current bindings into the InputManager so that both
     * default and custom keys trigger the corresponding action in-game.
     */
    applyToInputManager(inputManager) {
        inputManager.applyBindings(this.buildKeyToActionMap());
    }

    // ── Graphics helpers ──────────────────────────────────────────────────────

    applyGraphics() {
        if (this.graphics.fullscreen) {
            if (!document.fullscreenElement) {
                document.documentElement.requestFullscreen?.();
            }
        } else {
            if (document.fullscreenElement) {
                document.exitFullscreen?.();
            }
        }
    }
}
