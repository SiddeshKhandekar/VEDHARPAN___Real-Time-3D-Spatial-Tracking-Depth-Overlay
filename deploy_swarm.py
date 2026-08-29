import re
import os

############################
# 1. FIX PHYSICS_WORLD.JS
############################
with open('frontend/js/physics_world.js', 'r', encoding='utf-8') as f:
    pw_code = f.read()

# Remove the broken preStep block on initialization we added in step 2568
t1 = """        // Survive internal sub-stepping by enforcing an immutable preStep anti-gravity anchor!
        body.preStep = () => {
            if (body.ignoreGravity) {
                body.force.y -= (body.mass * this.world.gravity.y);
            }
        };"""
pw_code = pw_code.replace(t1, "")

# Add the explicit dispatcher to the constructor:
if "this.world.addEventListener('preStep'" not in pw_code:
    constructor_target = """        this.dynamicBodies = [];
    }"""
    
    constructor_replacement = """        this.dynamicBodies = [];

        // Correctly hook anti-gravity into the explicit Cannon.js preStep dispatcher!
        this.world.addEventListener('preStep', () => {
            for (let pair of this.dynamicBodies) {
                if (pair.body.ignoreGravity) {
                    pair.body.force.y -= pair.body.mass * this.world.gravity.y;
                }
            }
        });
    }"""
    pw_code = pw_code.replace(constructor_target, constructor_replacement)

with open('frontend/js/physics_world.js', 'w', encoding='utf-8') as f:
    f.write(pw_code)


############################
# 2. FIX SCENE.JS TIRE LOADER (Add offset IDs)
############################
with open('frontend/js/scene.js', 'r', encoding='utf-8') as f:
    sc = f.read()

# Add phaseOffset and tag them all for swarming array loop
tire_target = """                    const body = this.physicsWorld.addDynamicBody(tireClone, 5, 'cylinder', 0.4);
                    // Crucial: instruct Cannon.js anti-gravity fields in physics_world.js to suspend it
                    body.ignoreGravity = true;

                    // Eliminate vacuum friction so they coast infinitely
                    body.linearDamping = 0.0;
                    body.angularDamping = 0.0;

                    // Assign a randomized kinetic drift vector
                    const drift = 4.0;
                    body.velocity.set(
                        (Math.random() - 0.5) * drift,
                        (Math.random() - 0.5) * drift,
                        (Math.random() - 0.5) * drift
                    );

                    // Assign a slow perpetual tumble
                    body.angularVelocity.set(
                        (Math.random() - 0.5) * 2,
                        (Math.random() - 0.5) * 2,
                        (Math.random() - 0.5) * 2
                    );
                }"""

tire_replacement = """                    const body = this.physicsWorld.addDynamicBody(tireClone, 5, 'cylinder', 0.4);
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
                }"""
sc = sc.replace(tire_target, tire_replacement)

# Apply swarm props to Porsche too
porsche_target = """                this.activePorscheBody = body;"""
porsche_replacement = """                this.activePorscheBody = body;
                body.isSwarmProp = true;
                body.swarmPhaseOffset = 0.0; // Porsche follows the main path exactly"""
sc = sc.replace(porsche_target, porsche_replacement)


# Rip out old Porsche manual 2D circle loop and substitute the universal 3D Lissajous Swarm loop
old_loop_target = """        if (this.activePorscheBody) {
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

new_swarm_loop = """        // Swarm all background zero-g components cleanly using 3D Lissajous path curves
        const baseTime = performance.now() * 0.0003;
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
                const dtF = 50.0;
                const forceX = (targetX - b.position.x) * dtF;
                const forceY = (targetY - b.position.y) * dtF;
                const forceZ = (targetZ - b.position.z) * dtF;
                
                b.applyForce(new CANNON.Vec3(forceX, forceY, forceZ), b.position);

                // Ensure they don't break velocity limits when drifting tightly
                if (b.velocity.length() > 60) {
                    b.velocity.scale(0.98, b.velocity);
                }

                // If it is the Porsche, explicitly steer its visual chassis directly into the wind vector smoothly
                if (b === this.activePorscheBody) {
                    const fw = b.velocity.clone();
                    if (fw.lengthSquared() > 0.1) {
                        fw.normalize();
                        // Orient the chassis facing the velocity mathematically
                        const targetQuat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,0,1), new THREE.Vector3(fw.x, fw.y, fw.z));
                        const bodyQ = new THREE.Quaternion(b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w);
                        bodyQ.slerp(targetQuat, 0.05);
                        b.quaternion.set(bodyQ.x, bodyQ.y, bodyQ.z, bodyQ.w);
                    }
                }
            }
        }"""
sc = sc.replace(old_loop_target, new_swarm_loop)

with open('frontend/js/scene.js', 'w', encoding='utf-8') as f:
    f.write(sc)

print("COMPLETED SWARM DEPLOYMENT NATVIELY ALONG LISSAJOUS CURVES")
