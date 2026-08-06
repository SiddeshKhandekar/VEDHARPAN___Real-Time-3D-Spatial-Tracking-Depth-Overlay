import * as THREE from 'three';

export class VisualEffects {
    constructor(scene) {
        this.scene = scene;
        
        // Muzzle flash light
        this.muzzleLight = new THREE.PointLight(0x00ffff, 0, 10);
        this.scene.add(this.muzzleLight);
        this.muzzleFlashActive = false;
        this.muzzleFlashTimer = 0;
        
        // Particle arrays
        this.explosions = [];
        this.projectiles = [];
        
        // Particle material
        this.particleMaterial = new THREE.MeshBasicMaterial({
            color: 0x00ffff,
            transparent: true,
            opacity: 0.8,
            blending: THREE.AdditiveBlending
        });
        this.particleGeo = new THREE.SphereGeometry(0.1, 4, 4);
    }

    triggerMuzzleFlash(position) {
        this.muzzleLight.position.copy(position);
        this.muzzleLight.intensity = 5;
        this.muzzleFlashActive = true;
        this.muzzleFlashTimer = 50; // ms
    }
    
    createExplosion(position) {
        const explosionGroup = new THREE.Group();
        explosionGroup.position.copy(position);
        
        const numParticles = 15;
        for (let i = 0; i < numParticles; i++) {
            const p = new THREE.Mesh(this.particleGeo, this.particleMaterial);
            // Random direction
            const dir = new THREE.Vector3(
                Math.random() - 0.5,
                Math.random() - 0.5,
                Math.random() - 0.5
            ).normalize();
            
            p.userData = {
                velocity: dir.multiplyScalar(Math.random() * 0.2 + 0.1),
                life: 1.0
            };
            
            explosionGroup.add(p);
        }
        
        this.scene.add(explosionGroup);
        this.explosions.push(explosionGroup);
    }
    
    update(dt) {
        // Update muzzle flash
        if (this.muzzleFlashActive) {
            this.muzzleFlashTimer -= dt * 1000;
            if (this.muzzleFlashTimer <= 0) {
                this.muzzleLight.intensity = 0;
                this.muzzleFlashActive = false;
            } else {
                this.muzzleLight.intensity = (this.muzzleFlashTimer / 50) * 5;
            }
        }
        
        // Update explosions
        for (let i = this.explosions.length - 1; i >= 0; i--) {
            const exp = this.explosions[i];
            let alive = false;
            
            exp.children.forEach(p => {
                p.position.add(p.userData.velocity);
                p.userData.life -= dt * 2.0;
                p.material.opacity = p.userData.life;
                if (p.userData.life > 0) alive = true;
            });
            
            if (!alive) {
                this.scene.remove(exp);
                this.explosions.splice(i, 1);
            }
        }
    }
}
