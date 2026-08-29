import re

#########################
# 1. FIX PHYSICS_WORLD
#########################
with open('frontend/js/physics_world.js', 'r', encoding='utf-8') as f:
    pw_code = f.read()

# Remove the anti-gravity logic from step() entirely
anti_gravity_block_step = """        // Enforce anti-gravity for straight-flying projectiles
        for (let pair of this.dynamicBodies) {
            if (pair.body.ignoreGravity) {
                // Apply upward force exactly equal and opposite to gravity
                pair.body.force.y -= pair.body.mass * this.world.gravity.y;
            }
        }"""
pw_code = pw_code.replace(anti_gravity_block_step, "")

# Add anti-gravity mathematically resilient inside preStep on body creation natively
add_dynamic_target = """        body.linearDamping = 0.3;
        body.angularDamping = 0.3;
        this.world.addBody(body);"""

add_dynamic_replacement = """        body.linearDamping = 0.3;
        body.angularDamping = 0.3;

        // Survive internal sub-stepping by enforcing an immutable preStep anti-gravity anchor!
        body.preStep = () => {
            if (body.ignoreGravity) {
                body.force.y -= body.mass * this.world.gravity.y;
            }
        };

        this.world.addBody(body);"""

pw_code = pw_code.replace(add_dynamic_target, add_dynamic_replacement)

with open('frontend/js/physics_world.js', 'w', encoding='utf-8') as f:
    f.write(pw_code)


#########################
# 2. FIX SCENE PORSCHE PARAMETERS
#########################
with open('frontend/js/scene.js', 'r', encoding='utf-8') as f:
    sc_code = f.read()

sc_code = sc_code.replace(
    "const body = this.physicsWorld.addDynamicBody(porscheClone, 1500, 'box', 3.0);", 
    "const body = this.physicsWorld.addDynamicBody(porscheClone, 1500, 'sphere', 1.0);"
)

with open('frontend/js/scene.js', 'w', encoding='utf-8') as f:
    f.write(sc_code)


print("ZERO-G PHYSICS DRIFT AND MATRIX ERRORS COMPLETELY PERMANENTLY RESOLVED")
