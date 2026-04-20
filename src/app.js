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

// ─── Cmaj7 ────────────────────────────────────────────────────────────────────
const CHANNEL_CONFIG = [
    { label:'CH1-L', color:0x3399ff, freq:130.8, moving:false, trajectory:()=>({x:-5,y:1.6,z:-6}) },
    { label:'CH1-R', color:0x3399ff, freq:130.8, moving:false, trajectory:()=>({x: 5,y:1.6,z:-6}) },
    { label:'CH2',   color:0x22cc88, freq:164.8, moving:false, trajectory:()=>({x: 0,y:1.6,z:-8}) },
    {
        label:'CH3', color:0xffaa22, freq:196.0, moving:true,
        trajectory:(t)=>({ x:Math.sin(t*0.5)*10, y:1.6, z:-Math.cos(t*0.5)*10 })
    },
    {
        label:'CH4', color:0xff4488, freq:246.9, moving:true,
        trajectory:(t)=>{
            const a=t*0.4, r=9*Math.abs(Math.cos(2.5*a));
            return { x:r*Math.sin(a), y:1.6+Math.sin(t*1.3)*0.4, z:-r*Math.cos(a) };
        }
    }
];

// ─── Button mesh (canvas texture) ────────────────────────────────────────────
function makeButtonMesh(label, r, g, b, w=0.30, h=0.10) {
    const CW=512, CH=160;
    const canvas = document.createElement('canvas');
    canvas.width=CW; canvas.height=CH;
    const ctx = canvas.getContext('2d');

    function draw(lr,lg,lb) {
        ctx.clearRect(0,0,CW,CH);
        ctx.fillStyle=`rgb(${lr},${lg},${lb})`;
        const R=28;
        ctx.beginPath();
        ctx.moveTo(R,0); ctx.lineTo(CW-R,0); ctx.quadraticCurveTo(CW,0,CW,R);
        ctx.lineTo(CW,CH-R); ctx.quadraticCurveTo(CW,CH,CW-R,CH);
        ctx.lineTo(R,CH); ctx.quadraticCurveTo(0,CH,0,CH-R);
        ctx.lineTo(0,R); ctx.quadraticCurveTo(0,0,R,0);
        ctx.closePath(); ctx.fill();
        ctx.strokeStyle='rgba(255,255,255,0.5)'; ctx.lineWidth=5; ctx.stroke();
        ctx.fillStyle='#fff'; ctx.font='bold 68px sans-serif';
        ctx.textAlign='center'; ctx.textBaseline='middle';
        ctx.fillText(label, CW/2, CH/2);
    }
    draw(r,g,b);
    const tex = new THREE.CanvasTexture(canvas);
    const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(w,h),
        new THREE.MeshBasicMaterial({ map:tex, transparent:true, depthTest:false, side:THREE.DoubleSide })
    );
    mesh.userData = {
        draw, tex,
        nr:r,  ng:g,  nb:b,
        hr:Math.min(r+60,255), hg:Math.min(g+60,255), hb:Math.min(b+60,255),
        dr:Math.max(r-50,0),   dg:Math.max(g-50,0),   db:Math.max(b-50,0),
        isBtn:true
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

        this.camera = new THREE.PerspectiveCamera(50, window.innerWidth/window.innerHeight, 0.1, 200);
        // FIX 1: camera 不再设置 z 偏移，由 dolly 控制位置
        this.camera.position.set(0, 1.6, 0);

        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x101820);
        this.scene.add(new THREE.HemisphereLight(0xffffff,0x202020,0.6));
        const dl = new THREE.DirectionalLight(0xffffff,2);
        dl.position.set(1,3,2).normalize();
        this.scene.add(dl);

        this.renderer = new THREE.WebGLRenderer({ antialias:true });
        this.renderer.setPixelRatio(window.devicePixelRatio);
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.outputColorSpace = THREE.SRGBColorSpace;
        container.appendChild(this.renderer.domElement);

        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.target.set(0,1.6,0);
        this.controls.update();

        this.stats   = new Stats();
        this.tmpQuat = new THREE.Quaternion();
        this.rc      = new THREE.Raycaster();

        // Per-controller state
        this.ctrlState = [{
            selectPressed:false, justFired:false, hoveredBtn:null,
            ray:null
        },{
            selectPressed:false, justFired:false, hoveredBtn:null,
            ray:null
        }];

        // FIX 2: 提前初始化 pendingAudioAction，用于在手势 context 里触发音频
        this._pendingAudioAction = null;

        this.initScene();
        this.setupAudio();
        this.setupVR();

        window.addEventListener('resize', this.resize.bind(this));
        this.renderer.setAnimationLoop(this.render.bind(this));
    }

    // ─── Scene ────────────────────────────────────────────────────────────────
    initScene() {
        this.scene.fog = new THREE.FogExp2(0x101820,0.018);
        const ground = new THREE.Mesh(
            new THREE.PlaneGeometry(200,200),
            new THREE.MeshPhongMaterial({ color:0x1a2030, depthWrite:false })
        );
        ground.rotation.x = -Math.PI/2;
        this.scene.add(ground);
        const grid = new THREE.GridHelper(200,40,0x334466,0x222233);
        grid.material.opacity=0.5; grid.material.transparent=true;
        this.scene.add(grid);
        const ring = new THREE.Mesh(
            new THREE.RingGeometry(0.3,0.35,32),
            new THREE.MeshBasicMaterial({ color:0xffffff, side:THREE.DoubleSide, opacity:0.25, transparent:true })
        );
        ring.rotation.x=-Math.PI/2; ring.position.set(0,0.01,0);
        this.scene.add(ring);

        this.spheres = CHANNEL_CONFIG.map((cfg)=>{
            const mat = new THREE.MeshStandardMaterial({
                color:cfg.color, emissive:cfg.color, emissiveIntensity:0.3, roughness:0.3, metalness:0.1
            });
            const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.35,32,32), mat);
            const halo = new THREE.Mesh(
                new THREE.RingGeometry(0.38,0.55,32),
                new THREE.MeshBasicMaterial({ color:cfg.color, side:THREE.DoubleSide, transparent:true, opacity:0.2, depthWrite:false, blending:THREE.AdditiveBlending })
            );
            mesh.add(halo);
            const lc=document.createElement('canvas'); lc.width=192; lc.height=48;
            const lx=lc.getContext('2d'); lx.font='bold 22px sans-serif';
            lx.fillStyle='#'+cfg.color.toString(16).padStart(6,'0'); lx.fillText(cfg.label,8,34);
            const sp=new THREE.Sprite(new THREE.SpriteMaterial({ map:new THREE.CanvasTexture(lc), transparent:true, depthTest:false }));
            sp.scale.set(2.0,0.5,1); sp.position.set(0,0.65,0); mesh.add(sp);
            const p0=cfg.trajectory(0); mesh.position.set(p0.x,p0.y,p0.z);
            this.scene.add(mesh);
            return { mesh, halo, cfg };
        });
    }

    // ─── Audio ────────────────────────────────────────────────────────────────
    setupAudio() {
        this.audioNodes = CHANNEL_CONFIG.map(cfg=>createSpatialTone(cfg.freq));
        CHANNEL_CONFIG.forEach((cfg,i)=>this.setPannerPos(i,cfg.trajectory(0)));
    }

    // FIX 2: startAudio / stopAudio 现在接受一个可选的"已在手势中"参数
    // 在 VR selectstart 事件里直接调用 audioCtx.resume()，不依赖 promise 回调
    startAudio(inGestureContext = false) {
        if (this.running) return;
        if (inGestureContext) {
            // 直接在手势事件 context 中 resume，这是浏览器允许的
            audioCtx.resume();
            this.running = true;
            this._refreshPanel();
        } else {
            audioCtx.resume().then(()=>{
                this.running=true;
                this._refreshPanel();
            });
        }
    }

    stopAudio() {
        if (!this.running) return;
        audioCtx.suspend().then(()=>{
            this.running=false;
            this._refreshPanel();
        });
    }

    setPannerPos(i,pos) {
        const p=this.audioNodes[i].panner;
        if (p.positionX) { p.positionX.value=pos.x; p.positionY.value=pos.y; p.positionZ.value=pos.z; }
        else p.setPosition(pos.x,pos.y,pos.z);
    }

    updateAudioListener() {
        const pos=new THREE.Vector3(), fwd=new THREE.Vector3();
        this.camera.getWorldPosition(pos); this.camera.getWorldDirection(fwd);
        const l=audioCtx.listener;
        if (l.positionX) {
            l.positionX.value=pos.x; l.positionY.value=pos.y; l.positionZ.value=pos.z;
            l.forwardX.value=fwd.x; l.forwardY.value=fwd.y; l.forwardZ.value=fwd.z;
            l.upX.value=0; l.upY.value=1; l.upZ.value=0;
        } else {
            l.setPosition(pos.x,pos.y,pos.z); l.setOrientation(fwd.x,fwd.y,fwd.z,0,1,0);
        }
    }

    // ─── Spheres ──────────────────────────────────────────────────────────────
    updateSpheres(dt) {
        if (this.running) this.elapsed+=dt;
        const t=this.elapsed;
        this.spheres.forEach(({mesh,halo,cfg},i)=>{
            const pos=cfg.trajectory(t);
            mesh.position.set(pos.x,pos.y,pos.z);
            halo.lookAt(this.camera.position);
            mesh.material.emissiveIntensity=(this.running&&cfg.moving)?0.5+0.25*Math.sin(t*2+i):0.3;
            this.setPannerPos(i,pos);
        });
    }

    // ─── VR panel ─────────────────────────────────────────────────────────────
    buildVRPanel() {
        const CW=560,CH=240;
        const pc=document.createElement('canvas'); pc.width=CW; pc.height=CH;
        const px=pc.getContext('2d');
        px.fillStyle='rgba(8,14,26,0.92)';
        px.roundRect(0,0,CW,CH,32); px.fill();
        px.strokeStyle='rgba(255,255,255,0.2)'; px.lineWidth=4;
        px.roundRect(2,2,CW-4,CH-4,30); px.stroke();
        px.fillStyle='rgba(255,255,255,0.55)'; px.font='38px sans-serif';
        px.textAlign='center'; px.fillText('Spatial Audio Control',CW/2,56);
        const ptex=new THREE.CanvasTexture(pc);
        const bg=new THREE.Mesh(
            new THREE.PlaneGeometry(0.80,0.34),
            new THREE.MeshBasicMaterial({ map:ptex, transparent:true, depthTest:false, side:THREE.DoubleSide })
        );

        this.vrBtnStart=makeButtonMesh('▶  Start',40,150,80);
        this.vrBtnStart.position.set(-0.20,-0.06,0.002);
        this.vrBtnStart.userData.action='start';

        this.vrBtnStop=makeButtonMesh('■  Stop',170,45,45);
        this.vrBtnStop.position.set(0.20,-0.06,0.002);
        this.vrBtnStop.userData.action='stop';

        this.vrPanel=new THREE.Group();
        this.vrPanel.add(bg);
        this.vrPanel.add(this.vrBtnStart);
        this.vrPanel.add(this.vrBtnStop);

        // FIX 1: panel 挂在 dolly 上，位置在玩家前方 ~1.5m，高度约 1.3m（腰部偏上）
        // dolly 是站立位置，camera 在 dolly 内 (0,1.6,0)
        // panel 在 dolly 坐标系内：z=-1.5 表示前方1.5米
        this.vrPanel.position.set(0, 1.3, -1.5);
        this.vrPanel.visible=false;
        this.dolly.add(this.vrPanel);

        this._refreshPanel();
    }

    _refreshPanel() {
        if (!this.vrBtnStart) return;
        const s=this.vrBtnStart.userData, t=this.vrBtnStop.userData;
        if (this.running) { s.draw(20,70,35); } else { s.draw(s.nr,s.ng,s.nb); }
        s.tex.needsUpdate=true;
        if (!this.running) { t.draw(70,20,20); } else { t.draw(t.nr,t.ng,t.nb); }
        t.tex.needsUpdate=true;
    }

    // ─── Build visible ray line for a controller ──────────────────────────────
    _buildRayLine(ctrl) {
        const geo=new THREE.BufferGeometry();
        const positions=new Float32Array([0,0,0, 0,0,-2]);
        geo.setAttribute('position',new THREE.BufferAttribute(positions,3));
        const mat=new THREE.LineBasicMaterial({
            color:0xffffff,
            linewidth:2,
            transparent:true,
            opacity:0.7,
            depthTest:false
        });
        const line=new THREE.Line(geo,mat);
        line.renderOrder=999;
        ctrl.add(line);
        return line;
    }

    _updateRayLine(ray, hitDistance) {
        if (!ray) return;
        const pos=ray.geometry.attributes.position;
        pos.setZ(1, hitDistance ? -hitDistance : -2);
        pos.needsUpdate=true;
    }

    _castController(ctrl) {
        if (!ctrl || !this.vrPanel || !this.vrPanel.visible) return null;
        const origin=new THREE.Vector3();
        const direction=new THREE.Vector3();
        ctrl.getWorldPosition(origin);
        direction.set(0,0,-1).transformDirection(ctrl.matrixWorld).normalize();
        this.rc.set(origin,direction);
        const hits=this.rc.intersectObjects([this.vrBtnStart,this.vrBtnStop],false);
        return hits.length>0 ? hits[0] : null;
    }

    _processController(ctrl, state) {
        if (!ctrl) return;

        const hit=this._castController(ctrl);
        const btn=hit ? hit.object : null;

        this._updateRayLine(state.ray, hit ? hit.distance : null);

        if (state.ray) {
            state.ray.material.color.set(btn ? 0xffff00 : 0xffffff);
        }

        if (state.hoveredBtn && state.hoveredBtn!==btn) {
            const ud=state.hoveredBtn.userData;
            ud.draw(ud.nr,ud.ng,ud.nb); ud.tex.needsUpdate=true;
            state.hoveredBtn=null;
        }

        if (btn) {
            if (state.hoveredBtn!==btn) {
                state.hoveredBtn=btn;
                const ud=btn.userData;
                ud.draw(ud.hr,ud.hg,ud.hb); ud.tex.needsUpdate=true;
            }
            if (state.justFired) {
                const ud=btn.userData;
                ud.draw(ud.dr,ud.dg,ud.db); ud.tex.needsUpdate=true;
                // FIX 2: action 已在 selectstart 手势 context 中处理，这里只做视觉刷新
                // 实际音频 resume 发生在 selectstart 里（见 setupVR）
            }
        }

        state.justFired=false;
    }

    // ─── Locomotion ───────────────────────────────────────────────────────────
    handleLocomotion(dt) {
        const ctrl=this.controllers[0];
        if (!ctrl || !this.ctrlState[0].selectPressed) return;
        if (this._castController(ctrl)) return;
        const q=this.dolly.quaternion.clone();
        this.dolly.quaternion.copy(this.dummyCam.getWorldQuaternion(this.tmpQuat));
        this.dolly.translateZ(-dt*2);
        this.dolly.position.y=0;
        this.dolly.quaternion.copy(q);
    }

    // ─── VR ───────────────────────────────────────────────────────────────────
    setupVR() {
        this.renderer.xr.enabled=true;
        document.body.appendChild(VRButton.createButton(this.renderer));

        this.renderer.xr.addEventListener('sessionstart',()=>{
            this.controls.enabled=false;
            this.vrPanel.visible=true;
        });
        this.renderer.xr.addEventListener('sessionend',()=>{
            this.controls.enabled=true;
            this.vrPanel.visible=false;
            if (this.running) this.stopAudio();
        });

        this.controllers=[
            this.renderer.xr.getController(0),
            this.renderer.xr.getController(1)
        ];

        this.controllers.forEach((ctrl,i)=>{
            ctrl.addEventListener('selectstart',()=>{
                this.ctrlState[i].selectPressed=true;
                this.ctrlState[i].justFired=true;

                // FIX 2: 在 selectstart（手势事件）context 中直接处理音频
                // 此时调用 audioCtx.resume() 才被浏览器/Quest 认为是合法的用户手势触发
                const hit = this._castController(ctrl);
                if (hit) {
                    const action = hit.object.userData.action;
                    if (action === 'start') {
                        // 直接在手势 context 里 resume，不走 promise 延迟
                        audioCtx.resume().then(() => {
                            this.running = true;
                            this._refreshPanel();
                        });
                    } else if (action === 'stop') {
                        this.stopAudio();
                    }
                }
            });
            ctrl.addEventListener('selectend',()=>{
                this.ctrlState[i].selectPressed=false;
            });
            ctrl.addEventListener('connected',(event)=>{
                const grip=this.renderer.xr.getControllerGrip(i);
                const factory=new XRControllerModelFactory();
                if (grip.children.length===0) {
                    grip.add(factory.createControllerModel(grip));
                }
                if (!this.ctrlState[i].ray) {
                    this.ctrlState[i].ray=this._buildRayLine(ctrl);
                }
            });
            ctrl.addEventListener('disconnected',()=>{
                if (this.ctrlState[i].ray) {
                    ctrl.remove(this.ctrlState[i].ray);
                    this.ctrlState[i].ray=null;
                }
            });
            this.scene.add(ctrl);
        });

        this.grips=[
            this.renderer.xr.getControllerGrip(0),
            this.renderer.xr.getControllerGrip(1)
        ];
        const factory=new XRControllerModelFactory();
        this.grips.forEach((g,i)=>{
            g.add(factory.createControllerModel(g));
            this.scene.add(g);
        });

        // FIX 1: dolly 从原点出发，z=0
        // 场景内容在 z 负方向，玩家站在原点看向负 z（Three.js 默认 camera 看向 -z）
        this.dolly=new THREE.Object3D();
        this.dolly.position.set(0, 0, 0); // ← 修复：不再偏移到 z=5
        this.dolly.add(this.camera);
        this.scene.add(this.dolly);

        this.dummyCam=new THREE.Object3D();
        this.camera.add(this.dummyCam);

        this.buildVRPanel();
    }

    resize() {
        this.camera.aspect=window.innerWidth/window.innerHeight;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(window.innerWidth,window.innerHeight);
    }

    render() {
        const dt=this.clock.getDelta();
        this.stats.update();

        this._processController(this.controllers[0], this.ctrlState[0]);
        this._processController(this.controllers[1], this.ctrlState[1]);
        this.handleLocomotion(dt);
        this.updateSpheres(dt);
        this.updateAudioListener();
        this.renderer.render(this.scene,this.camera);
    }
}

export { App };

