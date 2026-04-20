import * as THREE from 'three';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';
import Stats from 'three/addons/libs/stats.module.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

document.addEventListener("DOMContentLoaded", function () {
    const app = new App();
    window.app = app;
});

// ─── Audio context — suspended until user clicks Start ────────────────────────
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

// ─── Create a looping oscillator tone fed through a PannerNode ────────────────
function createSpatialTone(freq) {
    const osc    = audioCtx.createOscillator();
    const gain   = audioCtx.createGain();
    const panner = audioCtx.createPanner();

    osc.type            = 'sine';
    osc.frequency.value = freq;
    gain.gain.value     = 0.18;

    panner.panningModel   = 'HRTF';
    panner.distanceModel  = 'inverse';
    panner.refDistance    = 1;
    panner.maxDistance    = 60;
    panner.rolloffFactor  = 1.2;
    panner.coneInnerAngle = 360;
    panner.coneOuterAngle = 360;
    panner.coneOuterGain  = 0;

    osc.connect(gain);
    gain.connect(panner);
    panner.connect(audioCtx.destination);
    osc.start();   // oscillator runs, but audioCtx suspended = silent

    return { osc, gain, panner };
}

// ─── Channel config ───────────────────────────────────────────────────────────
//
//  CH1-L  : fixed left-front, static
//  CH1-R  : fixed right-front, static (same freq, mirrored position)
//  CH2    : fixed front, gentle Y bob
//  CH3    : clockwise horizontal orbit
//  CH4    : 5-pointed star (polar rose)
//
const CHANNEL_CONFIG = [
    {
        label: 'CH1-L',
        color: 0x3399ff,
        freq:  220,
        trajectory: (_t) => ({ x: -5, y: 1.6, z: -6 })   // fixed left-front
    },
    {
        label: 'CH1-R',
        color: 0x3399ff,
        freq:  220,
        trajectory: (_t) => ({ x:  5, y: 1.6, z: -6 })   // fixed right-front
    },
    {
        label: 'CH2',
        color: 0x22cc88,
        freq:  330,
        trajectory: (t) => ({
            x: 0,
            y: 1.6 + Math.sin(t * 1.1) * 0.5,
            z: -8
        })
    },
    {
        label: 'CH3',
        color: 0xffaa22,
        freq:  440,
        trajectory: (t) => ({
            x:  Math.sin(t * 0.5) * 10,
            y:  1.6,
            z: -Math.cos(t * 0.5) * 10
        })
    },
    {
        label: 'CH4',
        color: 0xff4488,
        freq:  550,
        trajectory: (t) => {
            const a = t * 0.4;
            const r = 9 * Math.abs(Math.cos(2.5 * a));
            return {
                x: r * Math.sin(a),
                y: 1.6 + Math.sin(t * 1.3) * 0.4,
                z: -r * Math.cos(a)
            };
        }
    }
];

class App {
    constructor() {
        const container = document.createElement('div');
        document.body.appendChild(container);

        this.clock   = new THREE.Timer();
        this.elapsed = 0;
        this.running = false;   // motion + audio off until Start

        this.camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 200);
        this.camera.position.set(0, 1.6, 5);

        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x101820);

        this.scene.add(new THREE.HemisphereLight(0xffffff, 0x202020, 0.6));
        const dirLight = new THREE.DirectionalLight(0xffffff, 2);
        dirLight.position.set(1, 3, 2).normalize();
        this.scene.add(dirLight);

        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.renderer.setPixelRatio(window.devicePixelRatio);
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.outputColorSpace = THREE.SRGBColorSpace;
        container.appendChild(this.renderer.domElement);

        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.target.set(0, 1.6, 0);
        this.controls.update();

        this.stats = new Stats();

        this.tmpQuat       = new THREE.Quaternion();
        this.raycaster     = new THREE.Raycaster();
        this.workingMatrix = new THREE.Matrix4();
        this.workingVector = new THREE.Vector3();
        this.origin        = new THREE.Vector3();

        this.initScene();
        this.setupVR();
        this.setupAudio();

        window.addEventListener('resize', this.resize.bind(this));
        this.renderer.setAnimationLoop(this.render.bind(this));
    }

    // ─── Scene ────────────────────────────────────────────────────────────────
    initScene() {
        this.scene.fog = new THREE.FogExp2(0x101820, 0.018);

        const ground = new THREE.Mesh(
            new THREE.PlaneGeometry(200, 200),
            new THREE.MeshPhongMaterial({ color: 0x1a2030, depthWrite: false })
        );
        ground.rotation.x = -Math.PI / 2;
        this.scene.add(ground);

        const grid = new THREE.GridHelper(200, 40, 0x334466, 0x222233);
        grid.material.opacity     = 0.5;
        grid.material.transparent = true;
        this.scene.add(grid);

        // Listener marker (ring on floor)
        const ring = new THREE.Mesh(
            new THREE.RingGeometry(0.3, 0.35, 32),
            new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, opacity: 0.25, transparent: true })
        );
        ring.rotation.x = -Math.PI / 2;
        ring.position.set(0, 0.01, 0);
        this.scene.add(ring);

        // ── Spheres ──
        this.spheres = CHANNEL_CONFIG.map((cfg) => {
            const geo = new THREE.SphereGeometry(0.35, 32, 32);
            const mat = new THREE.MeshStandardMaterial({
                color:             cfg.color,
                emissive:          cfg.color,
                emissiveIntensity: 0.3,   // dim until Start
                roughness:         0.3,
                metalness:         0.1
            });
            const mesh = new THREE.Mesh(geo, mat);

            // Halo
            const halo = new THREE.Mesh(
                new THREE.RingGeometry(0.38, 0.55, 32),
                new THREE.MeshBasicMaterial({
                    color: cfg.color, side: THREE.DoubleSide,
                    transparent: true, opacity: 0.2,
                    depthWrite: false, blending: THREE.AdditiveBlending
                })
            );
            mesh.add(halo);

            // Label sprite
            const canvas  = document.createElement('canvas');
            canvas.width  = 192; canvas.height = 48;
            const ctx2d   = canvas.getContext('2d');
            ctx2d.font    = 'bold 22px sans-serif';
            ctx2d.fillStyle = '#' + cfg.color.toString(16).padStart(6, '0');
            ctx2d.fillText(cfg.label, 8, 34);
            const sprite  = new THREE.Sprite(
                new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), transparent: true, depthTest: false })
            );
            sprite.scale.set(2.0, 0.5, 1);
            sprite.position.set(0, 0.65, 0);
            mesh.add(sprite);

            // Place at rest position (t = 0) so spheres visible before Start
            const p0 = cfg.trajectory(0);
            mesh.position.set(p0.x, p0.y, p0.z);

            this.scene.add(mesh);
            return { mesh, halo, cfg };
        });
    }

    // ─── Audio + Start button ─────────────────────────────────────────────────
    setupAudio() {
        this.audioNodes = CHANNEL_CONFIG.map(cfg => createSpatialTone(cfg.freq));

        // Set initial panner positions
        CHANNEL_CONFIG.forEach((cfg, i) => this.setPannerPos(i, cfg.trajectory(0)));

        // Start button
        const btn = document.createElement('button');
        btn.textContent = '▶  Start Audio';
        btn.style.cssText = `
            position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
            padding: 12px 32px; font-size: 16px; font-weight: 600; border-radius: 28px;
            background: rgba(255,255,255,0.12); color: #fff;
            border: 1px solid rgba(255,255,255,0.35); cursor: pointer;
            backdrop-filter: blur(10px); z-index: 999; letter-spacing: 0.04em;
            transition: background 0.2s, opacity 0.4s;
        `;
        btn.addEventListener('mouseenter', () => { btn.style.background = 'rgba(255,255,255,0.22)'; });
        btn.addEventListener('mouseleave', () => { btn.style.background = 'rgba(255,255,255,0.12)'; });

        btn.addEventListener('click', () => {
            audioCtx.resume().then(() => {
                this.running = true;
                btn.textContent  = '🔊 Running';
                btn.style.opacity       = '0.4';
                btn.style.pointerEvents = 'none';
            });
        });

        document.body.appendChild(btn);
    }

    setPannerPos(i, pos) {
        const p = this.audioNodes[i].panner;
        if (p.positionX) {
            p.positionX.value = pos.x;
            p.positionY.value = pos.y;
            p.positionZ.value = pos.z;
        } else {
            p.setPosition(pos.x, pos.y, pos.z);
        }
    }

    // ─── Listener tracks camera every frame ───────────────────────────────────
    updateAudioListener() {
        const pos = new THREE.Vector3();
        const fwd = new THREE.Vector3();

        this.camera.getWorldPosition(pos);
        this.camera.getWorldDirection(fwd);

        const l = audioCtx.listener;
        if (l.positionX) {
            l.positionX.value = pos.x;  l.positionY.value = pos.y;  l.positionZ.value = pos.z;
            l.forwardX.value  = fwd.x;  l.forwardY.value  = fwd.y;  l.forwardZ.value  = fwd.z;
            l.upX.value = 0; l.upY.value = 1; l.upZ.value = 0;
        } else {
            l.setPosition(pos.x, pos.y, pos.z);
            l.setOrientation(fwd.x, fwd.y, fwd.z, 0, 1, 0);
        }
    }

    // ─── Spheres + panners ────────────────────────────────────────────────────
    updateSpheres(dt) {
        if (this.running) this.elapsed += dt;
        const t = this.elapsed;

        this.spheres.forEach(({ mesh, halo, cfg }, i) => {
            const pos = cfg.trajectory(t);
            mesh.position.set(pos.x, pos.y, pos.z);
            halo.lookAt(this.camera.position);

            // Pulse emissive only when running
            mesh.material.emissiveIntensity = this.running
                ? 0.5 + 0.25 * Math.sin(t * 2 + i)
                : 0.3;

            this.setPannerPos(i, pos);
        });
    }

    // ─── VR ───────────────────────────────────────────────────────────────────
    setupVR() {
        this.renderer.xr.enabled = true;
        document.body.appendChild(VRButton.createButton(this.renderer));

        this.renderer.xr.addEventListener('sessionstart', () => { this.controls.enabled = false; });
        this.renderer.xr.addEventListener('sessionend',   () => { this.controls.enabled = true; });

        const self = this;
        function onSelectStart() { this.userData.selectPressed = true;  }
        function onSelectEnd()   { this.userData.selectPressed = false; }

        this.controller = this.renderer.xr.getController(0);
        this.controller.addEventListener('selectstart', onSelectStart);
        this.controller.addEventListener('selectend',   onSelectEnd);
        this.controller.addEventListener('connected', function (event) {
            const mesh = self.buildController.call(self, event.data);
            mesh.scale.z = 0;
            this.add(mesh);
        });
        this.controller.addEventListener('disconnected', function () {
            this.remove(this.children[0]);
            self.controller = null;
            self.controllerGrip = null;
        });
        this.scene.add(this.controller);

        const controllerModelFactory = new XRControllerModelFactory();
        this.controllerGrip = this.renderer.xr.getControllerGrip(0);
        this.controllerGrip.add(controllerModelFactory.createControllerModel(this.controllerGrip));
        this.scene.add(this.controllerGrip);

        this.dolly = new THREE.Object3D();
        this.dolly.position.z = 5;
        this.dolly.add(this.camera);
        this.scene.add(this.dolly);

        this.dummyCam = new THREE.Object3D();
        this.camera.add(this.dummyCam);
    }

    buildController(data) {
        switch (data.targetRayMode) {
            case 'tracked-pointer': {
                const geo = new THREE.BufferGeometry();
                geo.setAttribute('position', new THREE.Float32BufferAttribute([0,0,0, 0,0,-1], 3));
                geo.setAttribute('color',    new THREE.Float32BufferAttribute([0.5,0.5,0.5, 0,0,0], 3));
                return new THREE.Line(geo,
                    new THREE.LineBasicMaterial({ vertexColors: true, blending: THREE.AdditiveBlending })
                );
            }
            case 'gaze': {
                const geo = new THREE.RingGeometry(0.02, 0.04, 32).translate(0, 0, -1);
                return new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ opacity: 0.5, transparent: true }));
            }
        }
    }

    handleController(controller, dt) {
        if (controller.userData.selectPressed) {
            const quaternion = this.dolly.quaternion.clone();
            this.dolly.quaternion.copy(this.dummyCam.getWorldQuaternion(this.tmpQuat));
            this.dolly.translateZ(-dt * 2);
            this.dolly.position.y = 0;
            this.dolly.quaternion.copy(quaternion);
        }
    }

    resize() {
        this.camera.aspect = window.innerWidth / window.innerHeight;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(window.innerWidth, window.innerHeight);
    }

    render() {
        const dt = this.clock.getDelta();
        this.stats.update();
        if (this.controller) this.handleController(this.controller, dt);
        this.updateSpheres(dt);
        this.updateAudioListener();
        this.renderer.render(this.scene, this.camera);
    }
}

export { App };
