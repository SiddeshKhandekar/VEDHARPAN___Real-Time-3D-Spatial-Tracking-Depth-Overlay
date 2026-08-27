import re

with open("scene.js", "r", encoding="utf-8") as f:
    content = f.read()

helper = """
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

    applyParallax(dt) {"""

# Replace applyParallax with helper + applyParallax
content = re.sub(r'applyParallax\(dt\) \{', helper, content, count=1)

# Replace targetCam block in applyParallax
old_block1 = """        let targetCamX = this.freeRoamOffset.x + orbitX + (parallaxX * rightX);
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

        // Smoothly interpolate camera position (Lerp) for stability
        this.camera.position.x += (targetCamX - this.camera.position.x) * 0.15;
        this.camera.position.y += (targetCamY - this.camera.position.y) * 0.15;
        this.camera.position.z += (targetCamZ - this.camera.position.z) * 0.15;"""

new_block1 = """        let targetCamX = this.freeRoamOffset.x + orbitX + (parallaxX * rightX);
        let targetCamY = this.freeRoamOffset.y + orbitY + parallaxY;
        let targetCamZ = this.freeRoamOffset.z + orbitZ + (parallaxX * rightZ);

        const centerPoint = new THREE.Vector3(this.freeRoamOffset.x, this.freeRoamOffset.y + 1.5, this.freeRoamOffset.z);
        const idealPos = new THREE.Vector3(targetCamX, targetCamY, targetCamZ);
        
        const finalCamPos = this._applyCameraCollision(centerPoint, idealPos);

        // Smoothly interpolate camera position (Lerp) for stability
        this.camera.position.x += (finalCamPos.x - this.camera.position.x) * 0.15;
        this.camera.position.y += (finalCamPos.y - this.camera.position.y) * 0.15;
        this.camera.position.z += (finalCamPos.z - this.camera.position.z) * 0.15;"""

content = content.replace(old_block1, new_block1)

# Replace targetCam block in Mode 1 (Third Person)
old_block2 = """                    const offset = new THREE.Vector3(0, 4.35, -6).applyQuaternion(orbitQuat);
                    const targetCamPos = mechaPos.clone().add(offset);
                    this.camera.position.lerp(targetCamPos, 0.12);"""

new_block2 = """                    const offset = new THREE.Vector3(0, 4.35, -6).applyQuaternion(orbitQuat);
                    let targetCamPos = mechaPos.clone().add(offset);
                    const centerPoint = mechaPos.clone().add(new THREE.Vector3(0, 4.35, 0));
                    targetCamPos = this._applyCameraCollision(centerPoint, targetCamPos);
                    this.camera.position.lerp(targetCamPos, 0.12);"""

content = content.replace(old_block2, new_block2)

# Replace targetCam block in Mode 3 (Aiming)
old_block3 = """                    const shoulderOffset = new THREE.Vector3(0.8, 4.15, -2.8).applyQuaternion(orbitQuat);
                    const targetCamPos = mechaPos.clone().add(shoulderOffset);
                    this.camera.position.lerp(targetCamPos, 0.18);"""

new_block3 = """                    const shoulderOffset = new THREE.Vector3(0.8, 4.15, -2.8).applyQuaternion(orbitQuat);
                    let targetCamPos = mechaPos.clone().add(shoulderOffset);
                    const centerPoint = mechaPos.clone().add(new THREE.Vector3(0, 4.15, 0));
                    targetCamPos = this._applyCameraCollision(centerPoint, targetCamPos);
                    this.camera.position.lerp(targetCamPos, 0.18);"""

content = content.replace(old_block3, new_block3)

with open("scene.js", "w", encoding="utf-8") as f:
    f.write(content)

print(content.find("_applyCameraCollision"))
print(content.find("this._applyCameraCollision(centerPoint, targetCamPos)"))
