import re

with open('frontend/js/scene.js', 'r', encoding='utf-8') as f:
    sc = f.read()

# I will find the City Map Loader block and insert the universal Swarm Loader right above it!
target = "        // 5. Load City Map"
start_idx = sc.find(target)

if start_idx != -1:
    new_loader_logic = """        // Universal Swarm Loader for injecting dynamic randomized geometry explicitly into the 3D Lissajous trajectory
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
        for(let i=0; i<2; i++) {
            // wandering_asteroids_of_andromeda -> Medium (4.5 units, larger than mecha)
            spawnSwarmAsteroid('wandering_asteroids_of_andromeda.glb', 4.5, 800.0);
            
            // asteroid_field_100_x_medium-poly -> Small (2.0 units) 
            spawnSwarmAsteroid('asteroid_field_100_x_medium-poly.glb', 2.0, 150.0);
            
            // asteroid.glb -> Big (8.0 units)
            spawnSwarmAsteroid('asteroid.glb', 8.0, 2500.0);
        }

"""
    sc = sc[:start_idx] + new_loader_logic + sc[start_idx:]
    with open('frontend/js/scene.js', 'w', encoding='utf-8') as f:
        f.write(sc)
        print("SUCCESSFULLY INJECTED ASTEROID SWARM LOGIC")
else:
    print("FAILED TO FIND TARGET INDEX")

