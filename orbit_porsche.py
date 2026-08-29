import re

with open('frontend/js/scene.js', 'r', encoding='utf-8') as f:
    code = f.read()

# 1. Strip out the green box helper and replace with white edges geometry
# Current block to target:
target_loader = """                // 3. Add Bright Green Identifier Border (BoxHelper)
                const greenBorder = new THREE.BoxHelper(porscheClone, 0x00ff00);
                // We must add the helper to the scene, and map it directly
                this.scene.add(greenBorder);

                configureShadows(porscheClone, true, true);
                this.scene.add(porscheClone);
                
                // Keep the helper synchronized in the rendering loop
                this.porscheHelper = greenBorder;
                this.activePorscheObj = porscheClone;"""

rep_loader = """                // 3. Add Bright White Edge Detail Identifier
                porscheClone.traverse((child) => {
                    if (child.isMesh) {
                        const edges = new THREE.EdgesGeometry(child.geometry, 15);
                        const line = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0xffffff, linewidth: 2.0 }));
                        child.add(line);
                    }
                });

                configureShadows(porscheClone, true, true);
                this.scene.add(porscheClone);
                this.activePorscheBody = body; // Map reference for manual centripetal orbital pull!"""

if target_loader in code:
    code = code.replace(target_loader, rep_loader)
else:
    print("FAILED TO FIND TARGET LOADER BLOCK")


# 2. Modify the render loop to dynamically pull the Porsche in an endless circle
target_loop = """if (this.porscheHelper && this.activePorscheObj) {
            this.porscheHelper.update();
        }"""

rep_loop = """if (this.activePorscheBody) {
            // Force the physical rigid body exactly along a continuous orbital circle hovering in space
            const time = performance.now() * 0.0003;
            const radius = 250;
            const targetX = Math.sin(time) * radius;
            const targetZ = Math.cos(time) * radius;
            const targetY = 150; // High in the skybox
            
            // Generate a spring-like pulling force actively ripping it into the orbital trajectory
            const pX = this.activePorscheBody.position.x;
            const pY = this.activePorscheBody.position.y;
            const pZ = this.activePorscheBody.position.z;

            const pullF = 20.0;
            const forceX = (targetX - pX) * pullF;
            const forceY = (targetY - pY) * pullF;
            const forceZ = (targetZ - pZ) * pullF;
            
            this.activePorscheBody.applyForce(new CANNON.Vec3(forceX, forceY, forceZ), this.activePorscheBody.position);
            
            // Point the car computationally FORWARD exactly across the path trajectory tangent
            // Using derivative of the orbital path: COS for X, -SIN for Z
            const headingX = Math.cos(time);
            const headingZ = -Math.sin(time);
            const headingVec = new THREE.Vector3(headingX, 0, headingZ).normalize();
            
            // Calculate a quaternion facing that trajectory
            const targetQuat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,0,1), headingVec);
            
            // Interpolate cleanly towards the new matrix mathematically so it visibly steers!
            const bodyQ = new THREE.Quaternion(this.activePorscheBody.quaternion.x, this.activePorscheBody.quaternion.y, this.activePorscheBody.quaternion.z, this.activePorscheBody.quaternion.w);
            bodyQ.slerp(targetQuat, 0.05); // Rapidly steer its hull alignment
            
            this.activePorscheBody.quaternion.set(bodyQ.x, bodyQ.y, bodyQ.z, bodyQ.w);
        }"""

if target_loop in code:
    code = code.replace(target_loop, rep_loop)
else:
    print("FAILED TO FIND TARGET LOOP BLOCK")

with open('frontend/js/scene.js', 'w', encoding='utf-8') as f:
    f.write(code)

print("ORBIT AND EDGE GEOMETRY PATCHED")
