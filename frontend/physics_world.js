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
     * Add a static Trimesh from a Three.js Mesh.
     * This is used for complex static environment geometry (walls, floors, stairs).
     */
    addStaticTrimesh(mesh) {
        if (!mesh.geometry || !mesh.geometry.attributes.position) {
            console.warn('Mesh does not have valid geometry for Trimesh physics', mesh);
            return;
        }

        const geometry = mesh.geometry;

        // Cannon.js Trimesh needs an array of vertices and indices
        let vertices;
        if (geometry.attributes.position.array instanceof Float32Array) {
            vertices = Array.from(geometry.attributes.position.array);
        } else {
            vertices = geometry.attributes.position.array;
        }

        let indices;
        if (geometry.index) {
            if (geometry.index.array instanceof Uint16Array || geometry.index.array instanceof Uint32Array) {
                indices = Array.from(geometry.index.array);
            } else {
                indices = geometry.index.array;
            }
        } else {
            // Generate non-indexed indices if no index buffer exists
            indices = [];
            for (let i = 0; i < vertices.length / 3; i++) {
                indices.push(i);
            }
        }

        // The Trimesh uses the vertices and indices to build the collision surface
        const trimeshShape = new CANNON.Trimesh(vertices, indices);

        const body = new CANNON.Body({
            mass: 0, // static body
            material: this.defaultMaterial
        });

        body.addShape(trimeshShape);

        // Position, rotate, and scale based on world matrix
        const worldPos = new THREE.Vector3();
        const worldQuat = new THREE.Quaternion();
        const worldScale = new THREE.Vector3();
        mesh.getWorldPosition(worldPos);
        mesh.getWorldQuaternion(worldQuat);
        mesh.getWorldScale(worldScale);

        // Apply scale to the vertices of the shape itself by scaling the body shape
        // Wait, CANNON.Trimesh does not have a setScale directly on the instance, it scales via the constructor or by scaling the vertices before passing them.
        // Let's scale vertices before creating the Trimesh shape instead!

        const scaledVertices = [];
        for (let i = 0; i < vertices.length; i += 3) {
            scaledVertices.push(vertices[i] * worldScale.x);
            scaledVertices.push(vertices[i + 1] * worldScale.y);
            scaledVertices.push(vertices[i + 2] * worldScale.z);
        }

        const scaledTrimeshShape = new CANNON.Trimesh(scaledVertices, indices);
        const scaledBody = new CANNON.Body({
            mass: 0,
            material: this.defaultMaterial,
            position: new CANNON.Vec3(worldPos.x, worldPos.y, worldPos.z),
            quaternion: new CANNON.Quaternion(worldQuat.x, worldQuat.y, worldQuat.z, worldQuat.w)
        });
        scaledBody.addShape(scaledTrimeshShape);

        this.world.addBody(scaledBody);
        return scaledBody;
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
            shape = new CANNON.Cylinder(radiusOrSize, radiusOrSize, radiusOrSize * 2, 16);
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



    step(dt) {
        // Enforce anti-gravity for straight-flying projectiles
        for (let pair of this.dynamicBodies) {
            if (pair.body.ignoreGravity) {
                // Apply upward force exactly equal and opposite to gravity
                pair.body.force.y -= pair.body.mass * this.world.gravity.y;
            }
        }

        // Step physics
        this.world.step(1 / 60, dt, 3);

        // Sync graphics
        for (let i = this.dynamicBodies.length - 1; i >= 0; i--) {
            const pair = this.dynamicBodies[i];

            // Check if mesh has been removed/destroyed OR plummeted hopelessly out of bounds
            if (!pair.mesh.parent || pair.body.position.y < -300) {
                if (pair.mesh.parent) pair.mesh.parent.remove(pair.mesh);
                this.world.removeBody(pair.body);
                this.dynamicBodies.splice(i, 1);
                continue;
            }

            pair.mesh.position.copy(pair.body.position);
            pair.mesh.quaternion.copy(pair.body.quaternion);
        }
    }
}
