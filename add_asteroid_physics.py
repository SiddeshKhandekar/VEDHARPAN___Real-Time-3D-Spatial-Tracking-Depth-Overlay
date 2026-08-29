import re

with open('frontend/js/scene.js', 'r', encoding='utf-8') as f:
    sc = f.read()

# 1. Modify Asteroid 42 (The gigantic atmospheric one)
target_42 = """            // Strip fog for total visibility from the ground
            asteroid.traverse((child) => {
                if (child.isMesh && child.material) child.material.fog = false;
            });"""

repl_42 = """            // Strip fog for total visibility from the ground, and deploy high-fidelity structural Trimesh arrays
            asteroid.traverse((child) => {
                if (child.isMesh) {
                    if (child.material) child.material.fog = false;
                    
                    // Physically weave 1:1 rigid constraints over all craters and antennae naturally!
                    this.physicsWorld.addStaticTrimesh(child);
                    
                    // Route geometry into bounding variables for Raycaster weapons/lasers mapping
                    this.collidableMeshes.push(child);
                }
            });"""
sc = sc.replace(target_42, repl_42)

# 2. Modify Tunnel Asteroid (The deep ground ring)
target_tunnel = """            tunnelAsteroid.traverse((child) => {
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
                }
            });"""

repl_tunnel = """            tunnelAsteroid.traverse((child) => {
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
                    
                    // Physically weave 1:1 structural Trimesh physics arrays seamlessly over the interior tunnels
                    this.physicsWorld.addStaticTrimesh(child);
                    
                    // Route geometry into weapon raycasting parameters natively!
                    this.collidableMeshes.push(child);
                }
            });"""
sc = sc.replace(target_tunnel, repl_tunnel)

with open('frontend/js/scene.js', 'w', encoding='utf-8') as f:
    f.write(sc)

print("SUCCESSFULLY INTEGRATED EXTREMELY HIGH FIDELITY TRIMESH PHYSICS ARRAYS INTO ASTEROID LOADERS")
