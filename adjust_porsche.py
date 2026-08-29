with open('frontend/js/scene.js', 'r', encoding='utf-8') as f:
    code = f.read()

target = """                const rx = (Math.random() - 0.5) * 300;
                const ry = Math.random() * 200;
                const rz = (Math.random() - 0.5) * 300;

                porscheClone.position.set(rx, ry, rz);
                porscheClone.rotation.x = Math.random() * Math.PI * 2;
                porscheClone.rotation.y = Math.random() * Math.PI * 2;
                porscheClone.scale.set(5.0, 5.0, 5.0); // Make it huge and visible visually
                
                configureShadows(porscheClone, true, true);
                this.scene.add(porscheClone);"""

replacement = """                // 1. Spawning right in front of the Mecha (Mecha is at 0, 5, 2 looking down Z)
                // We'll spawn it hovering perfectly in mid-air in front of the stairs!
                porscheClone.position.set(0, 15, -20);
                porscheClone.rotation.set(0, 0, 0); // Straight up

                // 2. Measure bounding and scale accurately compared to Mecha
                const pBox = new THREE.Box3().setFromObject(porscheClone);
                const pWidth = pBox.max.x - pBox.min.x;
                
                // Target width: 1.5 units (comparable to Mecha size)
                const pScale = 1.5 / pWidth;
                porscheClone.scale.set(pScale, pScale, pScale);
                
                // 3. Add Bright Green Identifier Border (BoxHelper)
                const greenBorder = new THREE.BoxHelper(porscheClone, 0x00ff00);
                // We must add the helper to the scene, and map it directly
                this.scene.add(greenBorder);

                configureShadows(porscheClone, true, true);
                this.scene.add(porscheClone);
                
                // Keep the helper synchronized in the rendering loop
                this.porscheHelper = greenBorder;
                this.activePorscheObj = porscheClone;
"""

if target in code:
    code = code.replace(target, replacement)

# We also need to add the bounding box helper update to the animate loop!
anim_target = "this.renderer.render(this.scene, this.camera);"
anim_rep = """if (this.porscheHelper && this.activePorscheObj) {
            this.porscheHelper.update();
        }
        this.renderer.render(this.scene, this.camera);"""

if anim_target in code and "this.porscheHelper.update()" not in code:
    code = code.replace(anim_target, anim_rep)

with open('frontend/js/scene.js', 'w', encoding='utf-8') as f:
    f.write(code)

print("PORSCHE RESCALED AND HIGHLIGHTED")
