import * as THREE from 'three';

/**
 * VisualEffects — Handles muzzle flash, 4 plasma fire modes, and impact explosions.
 *
 * Fire Modes:
 *  1 — Plasma Ball   : Single large cyan sphere, medium speed, big explosion
 *  2 — Rapid Fire    : Small bright yellow bolts, very fast, light burst on hit
 *  3 — Spread Shot   : 3-way fan of orange orbs (scene.js spawns 3 calls)
 *  4 — Charged Shot  : Massive slow magenta sphere, screen-shaking mega explosion
 */
export class VisualEffects {
    constructor(scene) {
        this.scene = scene;

        // Muzzle flash light
        this.muzzleLight = new THREE.PointLight(0x00ffff, 0, 12);
        this.scene.add(this.muzzleLight);
        this.muzzleFlashActive = false;
        this.muzzleFlashTimer = 0;
        this.muzzleFlashColor = 0x00ffff;

        // Explosion / trail arrays
        this.explosions = [];

        // Shared geometry cache
        this._geoCache = {};
    }

    _getGeo(r, segs = 6) {
        const key = `${r}_${segs}`;
        if (!this._geoCache[key]) {
            this._geoCache[key] = new THREE.SphereGeometry(r, segs, segs);
        }
        return this._geoCache[key];
    }

    /**
     * Returns a THREE.Mesh projectile scaled and coloured by fire mode.
     * scene.js spawns and controls its physics velocity.
     */
    createProjectileMesh(fireMode) {
        const mesh = new THREE.Group();
        mesh.userData.fireMode = fireMode;

        // Base visual config
        const cfg = {
            1: { color: 0x6600ff, emissive: 0x9933ff, emissiveIntensity: 2.0, glow: 0.8 }, // Plasma
            2: { color: 0xff4400, emissive: 0xff8800, emissiveIntensity: 3.0, glow: 0.4 }, // Bullet
            3: { color: 0xffffff, emissive: 0x00aaff, emissiveIntensity: 2.5, glow: 0.6 }, // Missile
            4: { color: 0xff0000, emissive: 0xaa0000, emissiveIntensity: 4.0, glow: 1.5 }, // Grenade
        }[fireMode] ?? { color: 0x00ffff, emissive: 0x00ffff, emissiveIntensity: 2, glow: 0.8 };

        const mat = new THREE.MeshStandardMaterial({
            color: cfg.color, emissive: cfg.emissive, emissiveIntensity: cfg.emissiveIntensity,
            transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false
        });

        let geoMesh;
        if (fireMode === 1) {
            // Plasma: Smooth round ball
            geoMesh = new THREE.Mesh(new THREE.SphereGeometry(0.25, 16, 16), mat);
        } else if (fireMode === 2) {
            // Rapid: Stretched bullet
            geoMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.4, 8), mat);
            geoMesh.rotation.x = Math.PI / 2; // point along Z
        } else if (fireMode === 3 || fireMode === 30) {
            // Spread: Pointy Missile
            geoMesh = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.5, 8), mat);
            geoMesh.rotation.x = Math.PI / 2; // point along Z
        } else if (fireMode === 4) {
            // Charged: Red Space Grenade with a plate
            const core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.4, 1), mat);
            const plateGeo = new THREE.CylinderGeometry(0.65, 0.65, 0.05, 16);
            const plate = new THREE.Mesh(plateGeo, mat.clone());
            plate.material.opacity = 0.7;
            plate.rotation.x = Math.PI / 2; // plate facing forward
            geoMesh = new THREE.Group();
            geoMesh.add(core, plate);
        } else {
            geoMesh = new THREE.Mesh(new THREE.SphereGeometry(0.2, 8, 8), mat);
        }

        mesh.add(geoMesh);

        // Glow sprite (billboard)
        const glowMat = new THREE.SpriteMaterial({
            color: cfg.emissive,
            transparent: true,
            opacity: 0.45,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
        });
        const glow = new THREE.Sprite(glowMat);
        glow.scale.setScalar(cfg.glow * 2.5);
        mesh.add(glow);

        // Fire trailing engine plume for missiles (mode 3)
        if (fireMode === 3 || fireMode === 30) {
            const plumeMat = new THREE.SpriteMaterial({
                color: 0xff5500,
                transparent: true,
                opacity: 0.8,
                blending: THREE.AdditiveBlending,
                depthWrite: false,
            });
            const plume = new THREE.Sprite(plumeMat);
            plume.scale.setScalar(1.2);
            plume.position.set(0, 0, -0.3); // trail behind the cone base
            mesh.add(plume);
        }

        // Point light riding the projectile
        const light = new THREE.PointLight(cfg.emissive, 3, 6);
        mesh.add(light);

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
            1: { n: 18, color: 0x9933ff, speed: 0.18, size: 0.12, life: 1.0 }, // blueish purple
            2: { n: 8, color: 0xff8800, speed: 0.28, size: 0.07, life: 0.5 }, // fire
            3: { n: 14, color: 0xffaa00, speed: 0.22, size: 0.10, life: 0.8 }, // missile burst (fire color)
            4: { n: 40, color: 0xff0000, speed: 0.12, size: 0.22, life: 1.6 }, // red grenade blast
        }[fireMode] ?? { n: 18, color: 0x9933ff, speed: 0.18, size: 0.12, life: 1.0 };

        const mat = new THREE.MeshBasicMaterial({
            color: cfg.color,
            transparent: true,
            opacity: 1.0,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
        });
        const geo = this._getGeo(cfg.size, 4);

        const group = new THREE.Group();
        group.position.copy(position);
        group.userData.maxLife = cfg.life;

        for (let i = 0; i < cfg.n; i++) {
            const p = new THREE.Mesh(geo, mat.clone());
            const dir = new THREE.Vector3(
                Math.random() - 0.5,
                Math.random() - 0.5,
                Math.random() - 0.5
            ).normalize();
            p.userData = {
                velocity: dir.multiplyScalar(Math.random() * cfg.speed + cfg.speed * 0.4),
                life: cfg.life,
                maxLife: cfg.life,
            };
            group.add(p);
        }

        // Shockwave ring for charged shot
        if (fireMode === 4) {
            const ringGeo = new THREE.TorusGeometry(0.1, 0.05, 6, 32);
            const ringMat = new THREE.MeshBasicMaterial({
                color: 0xff0000, transparent: true, opacity: 0.9,
                blending: THREE.AdditiveBlending, depthWrite: false,
            });
            const ring = new THREE.Mesh(ringGeo, ringMat);
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
                    // Expand and fade ring
                    const scale = 1 + (1 - t) * 12;
                    p.scale.setScalar(scale);
                    p.material.opacity = t * 0.8;
                } else {
                    p.position.add(p.userData.velocity);
                    p.userData.velocity.multiplyScalar(0.94); // drag
                    p.material.opacity = t;
                    p.scale.setScalar(t * 0.8 + 0.2);
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
