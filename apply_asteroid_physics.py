import re

with open('frontend/js/scene.js', 'r', encoding='utf-8') as f:
    code = f.read()

# Asteroid 42 Replacement
t42 = r"(asteroid\.traverse\(\(child\) => \{\s*if \(child\.isMesh && child\.material\) child\.material\.fog = false;\s*\}\);)"
r42 = """asteroid.traverse((child) => {
                if (child.isMesh) {
                    if (child.material) child.material.fog = false;
                    this.physicsWorld.addStaticTrimesh(child);
                    this.collidableMeshes.push(child);
                }
            });"""

if re.search(t42, code):
    code = re.sub(t42, r42, code)
    print("SUCCESS on ASTEROID 42")
else:
    print("FAILED ASTEROID 42 MATCH")


# Tunnel Asteroid Replacement
tt = r"(\/\/\s*Enforce geometry update so flat shading computes strictly against the vertices inherently\s*if\s*\(child\.geometry\)\s*child\.geometry\.computeVertexNormals\(\);\s*\})"
rt = """// Enforce geometry update so flat shading computes strictly against the vertices inherently
                    if (child.geometry) child.geometry.computeVertexNormals();

                    // Map static trimesh physics accurately over every internal tunnel ring!
                    this.physicsWorld.addStaticTrimesh(child);
                    this.collidableMeshes.push(child);
                }"""

if re.search(tt, code):
    code = re.sub(tt, rt, code)
    print("SUCCESS on TUNNEL ASTEROID")
else:
    print("FAILED TUNNEL ASTEROID MATCH")

with open('frontend/js/scene.js', 'w', encoding='utf-8') as f:
    f.write(code)
