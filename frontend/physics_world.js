import * as CANNON from 'cannon-es';
import * as THREE from 'three';

export class PhysicsWorld {
    constructor() {
        this.world = new CANNON.World();
        this.world.gravity.set(0, -9.82, 0); // Earth gravity
        this.world.broadphase = new CANNON.SAPBroadphase(this.world);
        this.world.solver.iterations = 10;
        
        // Physics materials
        this.defaultMaterial = new CANNON.Material('default');
        const defaultContactMaterial = new CANNON.ContactMaterial(this.defaultMaterial, this.defaultMaterial, {
            friction: 0.3,
            restitution: 0.2
        });
        this.world.addContactMaterial(defaultContactMaterial);

        // Keep track of all bodies paired with meshes
        this.dynamicBodies = [];
    }

    /**
     * Add a static plane (e.g., ground)
     */
    addStaticPlane() {
        const shape = new CANNON.Plane();
        const body = new CANNON.Body({ mass: 0, material: this.defaultMaterial });
        body.addShape(shape);
        // Plane in Cannon is facing Z, rotate to face Y
        body.quaternion.setFromAxisAngle(new CANNON.Vec3(1, 0, 0), -Math.PI / 2);
        this.world.addBody(body);
        return body;
    }

    /**
     * Add a dynamic body for a Three.js mesh. We approximate tires/projectiles as spheres or boxes.
     */
    addDynamicBody(mesh, mass, shapeType = 'sphere', radiusOrSize = 0.5) {
        let shape;
        if (shapeType === 'sphere') {
            shape = new CANNON.Sphere(radiusOrSize);
        } else if (shapeType === 'box') {
            shape = new CANNON.Box(new CANNON.Vec3(radiusOrSize.x, radiusOrSize.y, radiusOrSize.z));
        } else if (shapeType === 'cylinder') {
            shape = new CANNON.Cylinder(radiusOrSize, radiusOrSize, radiusOrSize*2, 16);
        }

        const body = new CANNON.Body({
            mass: mass,
            position: new CANNON.Vec3(mesh.position.x, mesh.position.y, mesh.position.z),
            quaternion: new CANNON.Quaternion(mesh.quaternion.x, mesh.quaternion.y, mesh.quaternion.z, mesh.quaternion.w),
            material: this.defaultMaterial
        });

        body.addShape(shape);
        // Linear damping prevents endless sliding
        body.linearDamping = 0.3;
        body.angularDamping = 0.3;
        this.world.addBody(body);
        
        this.dynamicBodies.push({ mesh, body });
        return body;
    }
    
    /**
     * Add static boxes to approximate stairs
     */
    addStairColliders() {
        const rampShape = new CANNON.Box(new CANNON.Vec3(3, 0.2, 3));
        const rampBody = new CANNON.Body({ mass: 0 });
        rampBody.addShape(rampShape);
        rampBody.position.set(0, 0.5, 2);
        // Angle the ramp
        rampBody.quaternion.setFromAxisAngle(new CANNON.Vec3(1, 0, 0), -Math.PI / 8);
        this.world.addBody(rampBody);
    }

    step(dt) {
        // Step physics
        this.world.step(1/60, dt, 3);
        
        // Sync graphics
        for (let i = this.dynamicBodies.length - 1; i >= 0; i--) {
            const pair = this.dynamicBodies[i];
            
            // Check if mesh has been removed/destroyed
            if (!pair.mesh.parent) {
                this.world.removeBody(pair.body);
                this.dynamicBodies.splice(i, 1);
                continue;
            }
            
            pair.mesh.position.copy(pair.body.position);
            pair.mesh.quaternion.copy(pair.body.quaternion);
        }
    }
}
