import re

with open('frontend/js/scene.js', 'r', encoding='utf-8') as f:
    sc = f.read()

# Fix scale
t1 = """        // Mathematically deploy the structural varieties (2 clones of each to avoid utterly nuking the framerate)
        for (let i = 0; i < 2; i++) {
            // wandering_asteroids_of_andromeda -> Medium (4.5 units, larger than mecha)
            spawnSwarmAsteroid('wandering_asteroids_of_andromeda.glb', 4.5, 800.0);

            // asteroid_field_100_x_medium-poly -> Small (2.0 units) 
            spawnSwarmAsteroid('asteroid_field_100_x_medium-poly.glb', 2.0, 150.0);

            // asteroid.glb -> Big (8.0 units)
            spawnSwarmAsteroid('asteroid.glb', 8.0, 2500.0);
        }"""
        
r1 = """        // Mathematically deploy the structural varieties (2 clones of each to avoid utterly nuking the framerate)
        for (let i = 0; i < 2; i++) {
            // wandering_asteroids_of_andromeda -> Medium 
            spawnSwarmAsteroid('wandering_asteroids_of_andromeda.glb', 15.0, 800.0);

            // asteroid_field_100_x_medium-poly -> Small
            spawnSwarmAsteroid('asteroid_field_100_x_medium-poly.glb', 6.0, 150.0);

            // asteroid.glb -> Big 
            spawnSwarmAsteroid('asteroid.glb', 25.0, 2500.0);
        }"""

if t1 in sc:
    sc = sc.replace(t1, r1)
    print("SUCCESS T1")
else:
    print("FAILED T1")


# Fix Swarm Tumbling Velocity bounds
t2 = """                // Ensure they don't break velocity limits when drifting tightly
                if (b.velocity.length() > 20) {
                    b.velocity.scale(0.95, b.velocity); // Cap orbital max velocity for smooth drift
                }

                // If it is the Porsche, explicitly steer its visual chassis directly into the wind vector smoothly
                if (b === this.activePorscheBody) {"""

r2 = """                // Ensure they don't break velocity limits when drifting tightly
                if (b.velocity.length() > 20) {
                    b.velocity.scale(0.95, b.velocity); // Cap orbital max velocity for smooth drift
                }

                // Force extremely slow, graceful cinematic tumbling universally inside Swarm physics arrays
                if (b.angularVelocity.length() > 0.3) {
                    b.angularVelocity.scale(0.85, b.angularVelocity);
                }

                // If it is the Porsche, explicitly steer its visual chassis directly into the wind vector smoothly
                if (b === this.activePorscheBody) {"""

if t2 in sc:
    sc = sc.replace(t2, r2)
    print("SUCCESS T2")
else:
    print("FAILED T2")

with open('frontend/js/scene.js', 'w', encoding='utf-8') as f:
    f.write(sc)
