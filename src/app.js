import * as THREE from 'three';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';
import Stats from 'three/addons/libs/stats.module.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

document.addEventListener("DOMContentLoaded", function () {
    const app = new App();
    window.app = app;
});

// ─── Audio ────────────────────────────────────────────────────────────────────
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

function createSpatialTone(freq) {
    const osc    = audioCtx.createOscillator();
    const gain   = audioCtx.createGain();
    const panner = audioCtx.createPanner();

    osc.type            = 'sine';
    osc.frequency.value = freq;
    gain.gain.value     = 0.16;

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
    osc.start();

    return { osc, gain, panner };
}

// ─── Cmaj7: C3 · E3 · G3 · B3 ────────────────────────────────────────────────
const CHANNEL_CONFIG = [
    {
        label:      'CH1-L',
        color:      0x3399ff,
        freq:       130.8,
        moving:     false,
        trajectory: () => ({ x: -5, y: 1.6, z: -6 })
    },
    {
        label:      'CH1-R',
        color:      0x3399ff,
        freq:       130.8,
        moving:     false,
        trajectory: () => ({ x:  5, y: 1.6, z: -6 })
    },
    {
        label:      'CH2',
        color:      0x22cc88,
        freq:       164.8,
        moving:     false,
        trajectory: () => ({ x: 0, y: 1.6, z: -8 })
    },
    {
        label:      'CH3',
        color:      0xffaa22,
        freq:       196.0,
        moving:     true,
        trajectory: (t) => ({
            x:  Math.sin(t * 0.5) * 10,
            y:  1.6,
            z: -Math.cos(t * 0.5) * 10
        })
    },
    {
        label:      'CH4',
        color:      0xff4488,
        freq:       246.9,
        moving:     true,
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

// ─── Canvas button mesh ───────────────────────────────────────────────────────
function makeButtonMesh(label, r, g, b, w = 0.30, h = 0.10) {
    const CW = 512, CH = 160;
    const canvas = document.createElement('canvas');
    canvas.width = CW; canvas.height = CH;
    const ctx = canvas.getContext('2d');

    function draw(lr, lg, lb) {
        ctx.clearRect(0, 0, CW, CH);
        ctx.fillStyle = `rgb(${lr},${lg},${lb})`;
        const rad = 28;
        ctx.beginPath();
        ctx.moveTo(rad, 0);
        ctx.lineTo(CW - rad, 0);  ctx.quadraticCurveTo(CW, 0, CW, rad);
        ctx.lineTo(CW, CH - rad); ctx.quadraticCurveTo(CW, CH, CW - rad, CH);
        ctx.lineTo(rad, CH);      ctx.quadraticCurveTo(0, CH, 0, CH - rad);
        ctx.lineTo(0, rad);       ctx.quadraticCurveTo(0, 0, rad, 0);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.45)';
        ctx.lineWidth = 5;
        ctx.stroke();
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 68px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, CW / 2, CH / 2);
    }

    draw(r, g, b);
    const tex = new THREE.CanvasTexture(canvas);
    const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(w, h),
        new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, side: THREE.DoubleSide })
    );
    mesh.userData = {
        draw, tex,
        nr: r, ng: g, nb: b,              // normal color
        hr: Math.min(r+50,255), hg: Math.min(g+50,255), hb: Math.min(b+50,255),  // hover
        dr: Math.max(r-40,0),  dg: Math.max(g-40,0),  db: Math.max(b-40,0),      // pressed
        isBtn: true
    };
    return mesh;
}

class App {
    constructor() {
        const container = document.createElement('div');
        document.body.appendChild(container);

        this.clock   = new THREE.Timer();
        this.elapsed = 0;
        this.running = false;

        this.camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 200);
        this.camera.position.set(0, 1.6, 5);

        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x101820);
        this.scene.add(new THREE.HemisphereLight(0xffffff, 0x202020, 0.6));
        const dl = new THREE.DirectionalLight(0xffffff, 2);
        dl.position.set(1, 3, 2).normalize();
        this.scene.add(dl);

        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.renderer.setPixelRatio(window.devicePixelRatio);
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.outputColorSpace = THREE.SRGBColorSpace;
        container.appendChild(this.renderer.domElement);

        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.target.set(0, 1.6, 0);
        this.controls.update();

        this.stats     = new Stats();
        this.tmpQuat   = new THREE.Quaternion();
        this.raycaster = new THREE.Raycaster();

        // per-controller state
        this._c0 = { selectPressed: false, selectJustFired: false, hoveredBtn: null };
        this._c1 = { selectPressed: false, selectJustFired: false, hoveredBtn: null };

        this.initScene();
        this.setupAudio();
        this.setupVR();       // dolly created here → then buildVRPanel

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
        grid.material.opacity = 0.5;
        grid.material.transparent = true;
        this.scene.add(grid);

        const ring = new THREE.Mesh(
            new THREE.RingGeometry(0.3, 0.35, 32),
            new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, opacity: 0.25, transparent: true })
        );
        ring.rotation.x = -Math.PI / 2;
        ring.position.set(0, 0.01, 0);
        this.scene.add(ring);

        this.spheres = CHANNEL_CONFIG.map((cfg) => {
            const mat = new THREE.MeshStandardMaterial({
                color: cfg.color, emissive: cfg.color,
                emissiveIntensity: 0.3, roughness: 0.3, metalness: 0.1
            });
            const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.35, 32, 32), mat);

            const halo = new THREE.Mesh(
                new THREE.RingGeometry(0.38, 0.55, 32),
                new THREE.MeshBasicMaterial({
                    color: cfg.color, side: THREE.DoubleSide,
                    transparent: true, opacity: 0.2,
                    depthWrite: false, blending: THREE.AdditiveBlending
                })
            );
            mesh.add(halo);

            const canvas = document.createElement('canvas');
            canvas.width = 192; canvas.height = 48;
            const c2 = canvas.getContext('2d');
            c2.font = 'bold 22px sans-serif';
            c2.fillStyle = '#' + cfg.color.toString(16).padStart(6, '0');
            c2.fillText(cfg.label, 8, 34);
            const sprite = new THREE.Sprite(
                new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), transparent: true, depthTest: false })
            );
            sprite.scale.set(2.0, 0.5, 1);
            sprite.position.set(0, 0.65, 0);
            mesh.add(sprite);

            const p0 = cfg.trajectory(0);
            mesh.position.set(p0.x, p0.y, p0.z);
            this.scene.add(mesh);
            return { mesh, halo, cfg };
        });
    }

    // ─── Audio ────────────────────────────────────────────────────────────────
    setupAudio() {
        this.audioNodes = CHANNEL_CONFIG.map(cfg => createSpatialTone(cfg.freq));
        CHANNEL_CONFIG.forEach((cfg, i) => this.setPannerPos(i, cfg.trajectory(0)));
    }

    startAudio() {
        if (this.running) return;
        audioCtx.resume().then(() => {
            this.running = true;
            console.log('[Audio] started');
            this._refreshPanel();
        });
    }

    stopAudio() {
        if (!this.running) return;
        audioCtx.suspend().then(() => {
            this.running = false;
            console.log('[Audio] stopped');
            this._refreshPanel();
        });
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

    updateAudioListener() {
        const pos = new THREE.Vector3();
        const fwd = new THREE.Vector3();
        this.camera.getWorldPosition(pos);
        this.camera.getWorldDirection(fwd);
        const l = audioCtx.listener;
        if (l.positionX) {
            l.positionX.value = pos.x; l.positionY.value = pos.y; l.positionZ.value = pos.z;
            l.forwardX.value  = fwd.x; l.forwardY.value  = fwd.y; l.forwardZ.value  = fwd.z;
            l.upX.value = 0; l.upY.value = 1; l.upZ.value = 0;
        } else {
            l.setPosition(pos.x, pos.y, pos.z);
            l.setOrientation(fwd.x, fwd.y, fwd.z, 0, 1, 0);
        }
    }

    // ─── Spheres ──────────────────────────────────────────────────────────────
    updateSpheres(dt) {
        if (this.running) this.elapsed += dt;
        const t = this.elapsed;
        this.spheres.forEach(({ mesh, halo, cfg }, i) => {
            const pos = cfg.trajectory(t);
            mesh.position.set(pos.x, pos.y, pos.z);
            halo.lookAt(this.camera.position);
            mesh.material.emissiveIntensity = (this.running && cfg.moving)
                ? 0.5 + 0.25 * Math.sin(t * 2 + i)
                : 0.3;
            this.setPannerPos(i, pos);
        });
    }

    // ─── VR panel ─────────────────────────────────────────────────────────────
    buildVRPanel() {
        // Background card
        const CW = 560, CH = 240;
        const pc = document.createElement('canvas');
        pc.width = CW; pc.height = CH;
        const pctx = pc.getContext('2d');
        pctx.fillStyle = 'rgba(8,14,26,0.92)';
        pctx.roundRect(0, 0, CW, CH, 32);
        pctx.fill();
        pctx.strokeStyle = 'rgba(255,255,255,0.18)';
        pctx.lineWidth = 4;
        pctx.roundRect(2, 2, CW-4, CH-4, 30);
        pctx.stroke();
        pctx.fillStyle = 'rgba(255,255,255,0.5)';
        pctx.font = '40px sans-serif';
        pctx.textAlign = 'center';
        pctx.fillText('Spatial Audio Control', CW/2, 58);

        const ptex = new THREE.CanvasTexture(pc);
        const bg = new THREE.Mesh(
            new THREE.PlaneGeometry(0.80, 0.34),
            new THREE.MeshBasicMaterial({ map: ptex, transparent: true, depthTest: false, side: THREE.DoubleSide })
        );

        // Buttons
        this.vrBtnStart = makeButtonMesh('▶  Start', 40, 150, 80);
        this.vrBtnStart.position.set(-0.20, -0.06, 0.002);
        this.vrBtnStart.userData.action = 'start';

        this.vrBtnStop = makeButtonMesh('■  Stop', 170, 45, 45);
        this.vrBtnStop.position.set( 0.20, -0.06, 0.002);
        this.vrBtnStop.userData.action = 'stop';

        this.vrPanel = new THREE.Group();
        this.vrPanel.add(bg);
        this.vrPanel.add(this.vrBtnStart);
        this.vrPanel.add(this.vrBtnStop);

        // Fixed in front of player, attached to dolly (not camera)
        // so it doesn't move when you turn your head
        this.vrPanel.position.set(0, 1.15, -0.65);
        this.vrPanel.visible = false;
        this.dolly.add(this.vrPanel);

        this._refreshPanel();
    }

    _refreshPanel() {
        if (!this.vrBtnStart) return;
        const ud = this.vrBtnStart.userData;
        if (this.running) {
            ud.draw(20, 80, 40);   // dimmed when already running
        } else {
            ud.draw(ud.nr, ud.ng, ud.nb);
        }
        ud.tex.needsUpdate = true;

        const us = this.vrBtnStop.userData;
        if (!this.running) {
            us.draw(80, 20, 20);   // dimmed when already stopped
        } else {
            us.draw(us.nr, us.ng, us.nb);
        }
        us.tex.needsUpdate = true;
    }

    // ─── Raycast from one controller against buttons ──────────────────────────
    // Returns hit button mesh or null
    _castController(ctrl) {
        if (!ctrl || !this.vrPanel || !this.vrPanel.visible) return null;

        // Get controller world position and direction
        const origin = new THREE.Vector3();
        const direction = new THREE.Vector3();
        ctrl.getWorldPosition(origin);
        // Controller points along its local -Z
        direction.set(0, 0, -1).transformDirection(ctrl.matrixWorld).normalize();

        this.raycaster.set(origin, direction);
        const hits = this.raycaster.intersectObjects([this.vrBtnStart, this.vrBtnStop], false);
        return hits.length > 0 ? hits[0].object : null;
    }

    // ─── Per-frame button hover + click for one controller ────────────────────
    _processController(ctrl, state) {
        if (!ctrl) return;

        const hit = this._castController(ctrl);

        // Clear old hover
        if (state.hoveredBtn && state.hoveredBtn !== hit) {
            const ud = state.hoveredBtn.userData;
            ud.draw(ud.nr, ud.ng, ud.nb);
            ud.tex.needsUpdate = true;
            state.hoveredBtn = null;
        }

        if (hit) {
            // Apply hover tint
            if (state.hoveredBtn !== hit) {
                state.hoveredBtn = hit;
                const ud = hit.userData;
                ud.draw(ud.hr, ud.hg, ud.hb);
                ud.tex.needsUpdate = true;
            }

            // Fire on the rising edge of selectPressed
            if (state.selectJustFired) {
                const ud = hit.userData;
                ud.draw(ud.dr, ud.dg, ud.db);
                ud.tex.needsUpdate = true;
                if (hit.userData.action === 'start') this.startAudio();
                else                                  this.stopAudio();
            }
        }

        // consume justFired flag
        state.selectJustFired = false;
    }

    // ─── Locomotion (right controller, only if not hitting a button) ──────────
    handleLocomotion(dt) {
        const ctrl = this.controller;   // controller 0 = right hand typically
        if (!ctrl || !ctrl.userData.selectPressed) return;
        // If the ray is over a button, skip locomotion
        if (this._castController(ctrl)) return;

        const quaternion = this.dolly.quaternion.clone();
        this.dolly.quaternion.copy(this.dummyCam.getWorldQuaternion(this.tmpQuat));
        this.dolly.translateZ(-dt * 2);
        this.dolly.position.y = 0;
        this.dolly.quaternion.copy(quaternion);
    }

    // ─── VR setup ─────────────────────────────────────────────────────────────
    setupVR() {
        this.renderer.xr.enabled = true;
        document.body.appendChild(VRButton.createButton(this.renderer));

        this.renderer.xr.addEventListener('sessionstart', () => {
            this.controls.enabled = false;
            this.vrPanel.visible  = true;
        });
        this.renderer.xr.addEventListener('sessionend', () => {
            this.controls.enabled = true;
            this.vrPanel.visible  = false;
            if (this.running) this.stopAudio();
        });

        // Controller 0
        this.controller = this.renderer.xr.getController(0);
        this.controller.addEventListener('selectstart', () => {
            this._c0.selectPressed  = true;
            this._c0.selectJustFired = true;
        });
        this.controller.addEventListener('selectend', () => {
            this._c0.selectPressed  = false;
        });
        this.controller.addEventListener('connected', (event) => {
            const mesh = this.buildController(event.data);
            mesh.scale.z = 0;
            this.controller.add(mesh);
        });
        this.controller.addEventListener('disconnected', () => {
            this.controller.remove(this.controller.children[0]);
        });
        this.scene.add(this.controller);

        // Controller 1 (left hand) — also can click buttons
        this.controller1 = this.renderer.xr.getController(1);
        this.controller1.addEventListener('selectstart', () => {
            this._c1.selectPressed  = true;
            this._c1.selectJustFired = true;
        });
        this.controller1.addEventListener('selectend', () => {
            this._c1.selectPressed  = false;
        });
        this.controller1.addEventListener('connected', (event) => {
            const mesh = this.buildController(event.data);
            mesh.scale.z = 0;
            this.controller1.add(mesh);
        });
        this.controller1.addEventListener('disconnected', () => {
            this.controller1.remove(this.controller1.children[0]);
        });
        this.scene.add(this.controller1);

        // Grips
        const factory = new XRControllerModelFactory();
        this.controllerGrip  = this.renderer.xr.getControllerGrip(0);
        this.controllerGrip.add(factory.createControllerModel(this.controllerGrip));
        this.scene.add(this.controllerGrip);

        this.controllerGrip1 = this.renderer.xr.getControllerGrip(1);
        this.controllerGrip1.add(factory.createControllerModel(this.controllerGrip1));
        this.scene.add(this.controllerGrip1);

        // Dolly
        this.dolly = new THREE.Object3D();
        this.dolly.position.z = 5;
        this.dolly.add(this.camera);
        this.scene.add(this.dolly);

        this.dummyCam = new THREE.Object3D();
        this.camera.add(this.dummyCam);

        // Panel built after dolly exists
        this.buildVRPanel();
    }

    buildController(data) {
        if (data.targetRayMode === 'tracked-pointer') {
            const geo = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.Float32BufferAttribute([0,0,0, 0,0,-1], 3));
            geo.setAttribute('color',    new THREE.Float32BufferAttribute([0.5,0.5,0.5, 0,0,0], 3));
            return new THREE.Line(geo,
                new THREE.LineBasicMaterial({ vertexColors: true, blending: THREE.AdditiveBlending })
            );
        }
        const geo = new THREE.RingGeometry(0.02, 0.04, 32).translate(0, 0, -1);
        return new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ opacity: 0.5, transparent: true }));
    }

    resize() {
        this.camera.aspect = window.innerWidth / window.innerHeight;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(window.innerWidth, window.innerHeight);
    }

    render() {
        const dt = this.clock.getDelta();
        this.stats.update();

        // Process both controllers for button interaction
        this._processController(this.controller,  this._c0);
        this._processController(this.controller1, this._c1);

        // Locomotion on controller 0 (won't fire if ray is over a button)
        this.handleLocomotion(dt);

        this.updateSpheres(dt);
        this.updateAudioListener();
        this.renderer.render(this.scene, this.camera);
    }
}

export { App };
