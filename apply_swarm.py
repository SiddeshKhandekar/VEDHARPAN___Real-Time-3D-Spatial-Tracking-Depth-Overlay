import re

with open('frontend/js/scene.js', 'r', encoding='utf-8') as f:
    sc = f.read()

# I will find the exact index of "if (this.activePorscheBody) {"
target_str = "if (this.activePorscheBody) {"
start_idx = sc.find(target_str)

if start_idx != -1:
    # Find the end of the block. We know it ends before "this.renderer.render(this.scene, this.camera);"
    end_str = "this.renderer.render(this.scene, this.camera);"
    end_idx = sc.find(end_str, start_idx)
    
    if end_idx != -1:
        old_block = sc[start_idx:end_idx]
        
        new_swarm_loop = """// Swarm all background zero-g components cleanly using 3D Lissajous path curves
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

                // If it is the Porsche, explicitly steer its visual chassis directly into the wind vector smoothly
                if (b === this.activePorscheBody) {
                    const fw = b.velocity.clone();
                    // Cancel internal angular spin conflicts
                    b.angularVelocity.set(0, 0, 0); 
                    
                    if (fw.lengthSquared() > 0.1) {
                        fw.normalize();
                        // Orient the chassis facing the velocity mathematically
                        const targetQuat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,0,1), new THREE.Vector3(fw.x, fw.y, fw.z));
                        const bodyQ = new THREE.Quaternion(b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w);
                        bodyQ.slerp(targetQuat, 0.005); // EXTREMELY slow turning radius! 
                        b.quaternion.set(bodyQ.x, bodyQ.y, bodyQ.z, bodyQ.w);
                    }
                }
            }
        }
        
        """
        
        sc = sc[:start_idx] + new_swarm_loop + sc[end_idx:]
        
        with open('frontend/js/scene.js', 'w', encoding='utf-8') as f:
            f.write(sc)
            print("SUCCESSFULLY REPLACED OLD LOOP WITH NEW SLOW SWARM LOOP")
    else:
        print("FAILED TO FIND END OF BLOCK")
else:
    print("FAILED TO FIND START OF BLOCK")
