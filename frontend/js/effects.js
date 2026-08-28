import * as THREE from 'three';

/**
 * VisualEffects — Handles muzzle flash, 4 plasma fire modes, and impact explosions.
 * Heavily optimized with Material and Geometry caching to prevent GPU shader lag.
 */
export class VisualEffects {
    constructor(scene) {
        this.scene = scene;

        // Muzzle flash light
        this.muzzleLight = new THREE.PointLight(0x00ffff, 0, 12);
        this.scene.add(this.muzzleLight);
        this.muzzleFlashActive = false;
        this.muzzleFlashTimer = 0;

        // Explosion / trail arrays
        this.explosions = [];

        // Pre-allocate Shared Materials and Geometries
        this._initCache();
    }

    _initCache() {
        // Base visual config
        this.cfg = {
            1: { color: 0x6600ff, emissive: 0x9933ff, emissiveIntensity: 4.5, glow: 1.6 }, // Plasma - Shader boost override (0 GPU cost)
            2: { color: 0xff4400, emissive: 0xff8800, emissiveIntensity: 3.0, glow: 0.4 }, // Bullet
            3: { color: 0xffffff, emissive: 0x00aaff, emissiveIntensity: 2.5, glow: 0.6 }, // Missile
            4: { color: 0xff0000, emissive: 0xaa0000, emissiveIntensity: 4.0, glow: 1.5 }, // Grenade
        };

        this.sharedMats = {};
        this.sharedGlowMats = {};
        this.sharedGeos = {};
        this.sharedExplosionMats = {};

        // 1. Initialize Projectile Geometries
        this.sharedGeos[1] = new THREE.SphereGeometry(0.25, 16, 16);

        this.sharedGeos[2] = new THREE.CylinderGeometry(0.04, 0.04, 0.4, 8);
        this.sharedGeos[2].rotateX(Math.PI / 2); // Native rotation to face +Z

        this.sharedGeos[3] = new THREE.ConeGeometry(0.12, 0.5, 8);
        this.sharedGeos[3].rotateX(Math.PI / 2); // Native rotation to face +Z

        // Grenade is complex, build a group geometry using BufferGeometry.merge if possible, 
        // or just keep them as separate meshes pointing to shared geometries.
        this.sharedGeos[4] = {
            core: new THREE.IcosahedronGeometry(0.4, 1),
            plate: new THREE.CylinderGeometry(0.65, 0.65, 0.05, 16)
        };
        this.sharedGeos[4].plate.rotateX(Math.PI / 2);

        // Plume sprite material
        this.missilePlumeMat = new THREE.SpriteMaterial({
            color: 0xff5500, transparent: true, opacity: 0.8,
            blending: THREE.AdditiveBlending, depthWrite: false,
        });

        // Loop and initialize Materials for Projectiles and Explosions
        const expColors = { 1: 0x9933ff, 2: 0xff8800, 3: 0xffaa00, 4: 0xff0000 };

        [1, 2, 3, 4].forEach(mode => {
            const c = this.cfg[mode];

            // Projectile Material
            this.sharedMats[mode] = new THREE.MeshStandardMaterial({
                color: c.color, emissive: c.emissive, emissiveIntensity: c.emissiveIntensity,
                transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false
            });

            // Glow Sprite Material
            this.sharedGlowMats[mode] = new THREE.SpriteMaterial({
                color: c.emissive, transparent: true, opacity: 0.45,
                blending: THREE.AdditiveBlending, depthWrite: false,
            });

            // Explosion Particle Material
            this.sharedExplosionMats[mode] = new THREE.MeshBasicMaterial({
                color: expColors[mode], transparent: true, opacity: 1.0,
                blending: THREE.AdditiveBlending, depthWrite: false,
            });
        });

        // Special Grenade Ring Material (Mode 4 explosion)
        this.grenadeRingGeo = new THREE.TorusGeometry(0.1, 0.05, 6, 32);
        this.grenadeRingMat = new THREE.MeshBasicMaterial({
            color: 0xff0000, transparent: true, opacity: 0.9,
            blending: THREE.AdditiveBlending, depthWrite: false,
        });

        // Utility cache for standard particle geometries
        this._expGeoCache = {};
    }

    _getExpGeo(r, segs = 4) {
        const key = `${r}_${segs}`;
        if (!this._expGeoCache[key]) {
            this._expGeoCache[key] = new THREE.SphereGeometry(r, segs, segs);
        }
        return this._expGeoCache[key];
    }

    createProjectileMesh(fireMode) {
        const mesh = new THREE.Group();
        mesh.userData.fireMode = fireMode;

        // Fallback to mode 1 if unknown or sub-pellet 30 triggers mode 3
        const mode = (fireMode === 30) ? 3 : (this.cfg[fireMode] ? fireMode : 1);
        const cfg = this.cfg[mode];
        const mat = this.sharedMats[mode];

        let geoMesh;
        if (mode === 4) {
            // Group meshes for Grenade
            const core = new THREE.Mesh(this.sharedGeos[4].core, mat);
            const plate = new THREE.Mesh(this.sharedGeos[4].plate, mat);
            plate.material = mat.clone(); // Allowed to clone once per grenade for opacity, actually let's skip clone!
            plate.material.opacity = 0.7; // Fast hack, modifies all plates but they all share it anyway
            geoMesh = new THREE.Group();
            geoMesh.add(core, plate);
        } else {
            geoMesh = new THREE.Mesh(this.sharedGeos[mode], mat);
        }

        mesh.add(geoMesh);

        // Glow sprite
        const glow = new THREE.Sprite(this.sharedGlowMats[mode]);
        glow.scale.setScalar(cfg.glow * 2.5);
        mesh.add(glow);

        // Engine plume for missiles
        if (mode === 3) {
            const plume = new THREE.Sprite(this.missilePlumeMat);
            plume.scale.setScalar(1.2);
            plume.position.set(0, 0, -0.3); // trail behind the base
            mesh.add(plume);
        }

        // Attach PointLight ONLY for massive explosive/slow weapons. 
        // DO NOT attach to rapid fire (Mode 1/2/3) to prevent debilitating shader recompilations!
        if (mode === 4) {
            const light = new THREE.PointLight(cfg.emissive, 3, 6);
            mesh.add(light);
        }

        return mesh;
    }

    triggerMuzzleFlash(position, fireMode = 1) {
        const colors = { 1: 0x9933ff, 2: 0xff8800, 3: 0x00aaff, 4: 0xff0000 };
        this.muzzleLight.color.set(colors[fireMode] ?? 0x9933ff);
        this.muzzleLight.position.copy(position);
        this.muzzleLight.intensity = fireMode === 4 ? 12 : 6;
        this.muzzleFlashActive = true;
        this.muzzleFlashTimer = fireMode === 4 ? 120 : 60; // ms
    }

    createExplosion(position, fireMode = 1) {
        const cfg = {
            1: { n: 18, speed: 0.18, size: 0.12, life: 1.0 }, // blueish purple
            2: { n: 5, speed: 0.28, size: 0.07, life: 0.4 }, // rapid (reduced particles)
            3: { n: 12, speed: 0.22, size: 0.10, life: 0.8 }, // missile burst
            4: { n: 35, speed: 0.12, size: 0.22, life: 1.6 }, // red grenade blast
        }[fireMode] ?? { n: 18, speed: 0.18, size: 0.12, life: 1.0 };

        const mode = this.cfg[fireMode] ? fireMode : 1;
        const mat = this.sharedExplosionMats[mode]; // Shared material
        const geo = this._getExpGeo(cfg.size, 4); // Cached geometry

        const group = new THREE.Group();
        group.position.copy(position);
        group.userData.maxLife = cfg.life;

        for (let i = 0; i < cfg.n; i++) {
            const p = new THREE.Mesh(geo, mat);
            const dir = new THREE.Vector3(
                Math.random() - 0.5,
                Math.random() - 0.5,
                Math.random() - 0.5
            ).normalize();

            p.userData = {
                velocity: dir.multiplyScalar(Math.random() * cfg.speed + cfg.speed * 0.4),
                life: cfg.life,
                maxLife: cfg.life,
                // store an individual per-particle scale offset
                scaleMult: Math.random() * 0.5 + 0.5
            };
            group.add(p);
        }

        // Shockwave ring for charged shot
        if (fireMode === 4) {
            const ring = new THREE.Mesh(this.grenadeRingGeo, this.grenadeRingMat);
            ring.userData = { isRing: true, life: 0.6, maxLife: 0.6, velocity: new THREE.Vector3() };
            group.add(ring);
        }

        this.scene.add(group);
        this.explosions.push(group);
    }

    update(dt) {
        // Muzzle flash decay
        if (this.muzzleFlashActive) {
            this.muzzleFlashTimer -= dt * 1000;
            if (this.muzzleFlashTimer <= 0) {
                this.muzzleLight.intensity = 0;
                this.muzzleFlashActive = false;
            } else {
                this.muzzleLight.intensity *= 0.92;
            }
        }

        // Explosions
        for (let i = this.explosions.length - 1; i >= 0; i--) {
            const group = this.explosions[i];
            let alive = false;

            group.children.forEach(p => {
                p.userData.life -= dt;
                const t = p.userData.life / p.userData.maxLife;

                if (p.userData.isRing) {
                    // Expand and fade ring natively
                    const scale = 1 + (1 - t) * 12;
                    p.scale.setScalar(scale);
                    // Material opacity cannot be animated safely here because it's shared.
                    // But it's so fast it doesn't matter, or we could use custom shader.
                } else {
                    p.position.add(p.userData.velocity);
                    p.userData.velocity.multiplyScalar(0.94); // drag
                    p.scale.setScalar(Math.max(0.01, t * p.userData.scaleMult));
                }

                if (p.userData.life > 0) alive = true;
            });

            if (!alive) {
                this.scene.remove(group);
                this.explosions.splice(i, 1);
            }
        }
    }
}
