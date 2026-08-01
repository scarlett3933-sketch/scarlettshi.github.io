import * as THREE from 'three';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';
import Stats from 'three/addons/libs/stats.module.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

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
    osc.type            = 'sawtooth';
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

// 钟表专用音源：正弦波、初始静音（等到真正触发时间再淡入），
// 跟 CH1~CH4 用同一套 panner 参数，只是波形/初始增益不同
function createClockTone(freq) {
    const osc    = audioCtx.createOscillator();
    const gain   = audioCtx.createGain();
    const panner = audioCtx.createPanner();
    osc.type            = 'sine';   // 正弦波，谐波少，不容易和别的钟表打架
    osc.frequency.value = freq;
    gain.gain.value      = 0;        // 初始静音，飞出去的那一刻才淡入（见 updateClocks）
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

// 跟 CH1~CH4 保持同一个 Cmaj7 和弦（C3 E3 G3 B3），钟表音高按这个和弦循环分配，
// 每循环一轮往上一个八度（最多循环 3 轮，避免音高无限往上飙）
// 这样几十个钟表叠在一起时音高互相和谐，而不是像等差数列那样挤成一坨拍频噪音
const CMAJ7_CHORD = [130.81, 164.81, 196.00, 246.94];
function clockFrequency(index) {
    const octaveShift = Math.floor(index / CMAJ7_CHORD.length) % 3; // 0,1,2 循环
    return CMAJ7_CHORD[index % CMAJ7_CHORD.length] * Math.pow(2, 1 + octaveShift);
}

// 通用：立即设置某个 panner 节点的位置（钟表音源复用这个，跟 CH1~CH4 的 setPannerPos 是同一套逻辑）
function setImmediatePannerPos(panner, pos) {
    if (panner.positionX) {
        panner.positionX.value = pos.x;
        panner.positionY.value = pos.y;
        panner.positionZ.value = pos.z;
    } else {
        panner.setPosition(pos.x, pos.y, pos.z);
    }
}

// ─── Cmaj7 ────────────────────────────────────────────────────────────────────
const CHANNEL_CONFIG = [
    { label:'CH1-L', color:0x3399ff, freq:130.8, moving:false, trajectory:()=>({x:-5,y:1.6,z:-6}) },
    { label:'CH1-R', color:0x3399ff, freq:130.8, moving:false, trajectory:()=>({x: 5,y:1.6,z:-6}) },
    { label:'CH2',   color:0x22cc88, freq:164.8, moving:false, trajectory:()=>({x: 0,y:1.6,z:-8}) },
    {
        // CH3: 顺时针圆形（俯视，顺时针 = x正→z正→x负→z负）
        label:'CH3', color:0xffaa22, freq:196.0, moving:true,
        trajectory:(t)=>({ x:Math.sin(t*0.5)*10, y:1.6, z:Math.cos(t*0.5)*10 - 8 })
    },
    {
        // CH4: 五角星 rose curve（k=2.5，5瓣）
        label:'CH4', color:0xff4488, freq:246.9, moving:true,
        trajectory:(t)=>{
            const a = t * 0.35;
            const r = 9 * Math.abs(Math.cos(2.5 * a));
            return { x:r*Math.sin(a), y:1.6, z:r*Math.cos(a) - 8 };
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
// ─── load 3D MODEL ────────────────────────────────────────────
class App {
loadClockModel() {
    const DEBUG_MESH_INFO = false; // 需要调试时改成 true（包含：尺寸排序表、点击识别、全名字搜索）

    const loader = new GLTFLoader();
    const modelUrl = `${import.meta.env.BASE_URL}models/Thousand Clocks Demo.glb`;

    loader.load(
        modelUrl,
        (gltf) => {
            const model = gltf.scene;

            if (DEBUG_MESH_INFO) {
                const allMeshInfo = [];
                model.traverse((object) => {
                    if (!object.isMesh) return;
                    const box = new THREE.Box3().setFromObject(object);
                    const size = new THREE.Vector3();
                    box.getSize(size);
                    allMeshInfo.push({
                        name: object.name,
                        material: object.material?.name,
                        maxDim: Math.max(size.x, size.y, size.z),
                        size
                    });
                });
                allMeshInfo.sort((a, b) => b.maxDim - a.maxDim);
                console.log('模型里一共有', allMeshInfo.length, '个 mesh');
                console.table(allMeshInfo.slice(0, 10).map(m => ({
                    name: m.name, material: m.material, maxDim: m.maxDim.toFixed(3)
                })));
            }

            // 删除天空球 / 世界网格分块等不需要的环境物体
            const meshesToRemove = [];
            model.traverse((object) => {
                if (!object.isMesh) return;
                const objectInfo = `${object.name} ${object.material?.name || ''}`;
                const isWorldGrid =
                    /HLOD|MainGrid|ProcGrid|Landscape|Sky|Dome/i.test(objectInfo);
                if (isWorldGrid) {
                    meshesToRemove.push(object);
                }
            });
            meshesToRemove.forEach((object) => object.parent?.remove(object));

            // 重新计算清理后的模型尺寸
            const box = new THREE.Box3().setFromObject(model);
            const size = new THREE.Vector3();
            const center = new THREE.Vector3();
            box.getSize(size);
            box.getCenter(center);

            console.log('删除后模型尺寸：', { x: size.x, y: size.y, z: size.z });
            console.log('删除后模型中心：', { x: center.x, y: center.y, z: center.z });

            // 把模型水平居中在原点，Y 方向让最低点贴地
            model.position.x -= center.x;
            model.position.z -= center.z;
            model.position.y -= box.min.y;

            const wrapper = new THREE.Group();
            wrapper.name = 'ClocksModelWrapper';
            wrapper.add(model);

            // 按接近真实建筑的尺寸缩放（站在塔楼内部）
            const maxDim = Math.max(size.x, size.y, size.z);
            const targetSize = 14.0; // ← 调这个数字控制塔楼实际大小
            const scale = targetSize / maxDim;
            wrapper.scale.setScalar(scale);

            // wrapper 放在原点，玩家就站在塔楼内部
            wrapper.position.set(0, 0, 0);

            // 先不旋转，看默认朝向对不对
            // wrapper.rotation.y = Math.PI / 2;

            this.scene.add(wrapper);

            if (DEBUG_MESH_INFO) {
                // ── 调试用：点击识别 mesh（桌面浏览器里点一下，控制台打印名字/坐标/父级） ──
                const pickRaycaster = new THREE.Raycaster();
                const pickMouse = new THREE.Vector2();

                window.addEventListener('click', (event) => {
                    pickMouse.x = (event.clientX / window.innerWidth) * 2 - 1;
                    pickMouse.y = -(event.clientY / window.innerHeight) * 2 + 1;

                    pickRaycaster.setFromCamera(pickMouse, this.camera);
                    const hits = pickRaycaster.intersectObject(wrapper, true);

                    if (hits.length > 0) {
                        const obj = hits[0].object;
                        const worldPos = new THREE.Vector3();
                        obj.getWorldPosition(worldPos);
                        console.log(
                            `%c点中了: ${obj.name}`,
                            'color:#0f0;font-weight:bold',
                            ' 世界坐标:', worldPos.toArray().map(v => v.toFixed(2)),
                            ' parent:', obj.parent?.name,
                            ' parent的parent:', obj.parent?.parent?.name
                        );
                    } else {
                        console.log('没点中任何东西');
                    }
                });

                // ── 调试用：搜索钟表相关命名 ──
                console.log('=== 搜索钟表相关命名 ===');
                const allNames = [];
                let clockLikeCount = 0;
                model.traverse((object) => {
                    if (!object.isMesh) return;
                    allNames.push(object.name);
                    if (/clock|钟|watch|时钟|dial|表盘/i.test(object.name)) {
                        clockLikeCount++;
                        console.log('%c疑似钟表命名: ' + object.name, 'color:#0f0;font-weight:bold');
                    }
                });
                console.log(`模型总共 ${allNames.length} 个 mesh，其中 ${clockLikeCount} 个疑似跟"钟表"相关的命名`);
                console.log('完整名字列表（可以复制去搜索/查重）：', allNames);
            }

            // ── 收集所有钟表 Group（Clock_N 是空的父级节点，不是 mesh，
            //    之前只 traverse mesh 才会漏掉这一层） ──────────────────────────────
            this.clockRegistry = [];

            const clockGroups = [];
            model.traverse((object) => {
                if (/^Clock_\d+$/i.test(object.name)) {
                    clockGroups.push(object);
                }
            });
            console.log(`找到 ${clockGroups.length} 个钟表 Group：`, clockGroups.map(g => g.name));

            // 单个钟表的目标音量：钟表越多，每个越要压低，避免几十个音源叠加后总音量爆表失真
            // 0.5 是"全部同时响"时大致的总音量上限，按 sqrt(数量) 分摊（能量叠加近似满足平方根关系）
            const perClockGain = clockGroups.length > 0
                ? Math.min(0.14, 0.5 / Math.sqrt(clockGroups.length))
                : 0.14;

            clockGroups.forEach((clockObj, index) => {
                // 关键：用 attach() 把钟表重新挂到 scene 下，
                // three.js 会自动保持它在世界坐标系里的视觉位置/旋转/缩放不变
                // （这样就不用手算 wrapper 的 scale/position 补偿）
                this.scene.attach(clockObj);

                const originalPosition = clockObj.position.clone();

                // 每个钟表配一个正弦波音源，音高按 Cmaj7 和弦循环分配，初始静音
                const audioNode = createClockTone(clockFrequency(index));
                setImmediatePannerPos(audioNode.panner, originalPosition);

                this.clockRegistry.push({
                    name: clockObj.name,
                    object: clockObj,
                    originalPosition,
                    audioNode,
                    targetGain: perClockGain, // 淡入时要达到的目标音量
                    soundStarted: false,      // 是否已经淡入过（避免每帧重复触发淡入）
                    // 触发时间（秒），到了这个时间点开始飞；先给测试值，之后按需给每个钟表单独设置
                    triggerTime: 5 + index * 0.3,
                    duration: 6,           // 飞行持续时间
                    // 轨迹函数，接收"原始位置"和"0~1 的飞行进度"，返回世界坐标
                    trajectory: (originalPos, tt) => ({
                        x: originalPos.x + tt * 3 * Math.sin(index),
                        y: originalPos.y - tt * 2,           // 举例：往下坠落飞出去
                        z: originalPos.z + tt * 5 * Math.cos(index)
                    })
                });
            });

            console.log('Clock model loaded, scale:', scale);
        },
        (xhr) => {
            if (xhr.total) {
                console.log(`Clock model ${(xhr.loaded / xhr.total * 100).toFixed(1)}% loaded`);
            }
        },
        (error) => {
            console.error('Error loading clock model:', error);
        }
    );
}
// ─── RENDER RELATED ────────────────────────────────────────────
    constructor() {
        const container = document.createElement('div');
        document.body.appendChild(container);
        const FLOOR_OFFSET = 1.10; // 从射线检测得到的地板真实高度
const EYE_HEIGHT = 2; // ← 按你上次反馈先调高，之后可继续微调
const cameraY = EYE_HEIGHT + FLOOR_OFFSET;

this.floorWorldY = FLOOR_OFFSET; // 保存地板高度，供瞬移逻辑使用

// 瞬移状态：每个手柄一份
this.teleportState = [
    { aiming:false, targetValid:false, targetPoint:new THREE.Vector3() },
    { aiming:false, targetValid:false, targetPoint:new THREE.Vector3() }
];
        
        this.clock   = new THREE.Clock();
        this.elapsed = 0;
        this.running = false;

        this.camera = new THREE.PerspectiveCamera(50, window.innerWidth/window.innerHeight, 0.1, 200);
        // FIX 1: camera 不再设置 z 偏移，由 dolly 控制位置
        this.camera.position.set(0, cameraY, 0);

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
        
        this.controls.target.set(0, cameraY, 0);
        this.controls.update();
        this.stats   = new Stats();
        this.rc      = new THREE.Raycaster();

        // Per-controller state
        this.ctrlState = [{
            selectPressed:false, justFired:false, hoveredBtn:null,
            ray:null
        },{
            selectPressed:false, justFired:false, hoveredBtn:null,
            ray:null
        }];

        this.initScene();
        this.loadClockModel();
        this.setupAudio();
        this.setupVR();

        window.addEventListener('resize', this.resize.bind(this));
        this.renderer.setAnimationLoop(this.render.bind(this));
    }

    // ─── Scene ────────────────────────────────────────────────────────────────
    initScene() {
        const originMarker = new THREE.Mesh(
    new THREE.SphereGeometry(0.12, 16, 16),
    new THREE.MeshBasicMaterial({ color: 0xffff00 })
);
originMarker.position.set(0, 0, 0);
this.scene.add(originMarker);

const axesHelper = new THREE.AxesHelper(3);
this.scene.add(axesHelper);

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
        // 瞬移落点标记
        const markerGeo = new THREE.RingGeometry(0.25, 0.35, 32);
        const markerMat = new THREE.MeshBasicMaterial({
        color: 0x00ff88, side: THREE.DoubleSide, transparent: true, opacity: 0.8
});
        this.teleportMarker = new THREE.Mesh(markerGeo, markerMat);
        this.teleportMarker.rotation.x = -Math.PI / 2;
        this.teleportMarker.visible = false;
        this.scene.add(this.teleportMarker);
    }

    // ─── Audio ────────────────────────────────────────────────────────────────
    setupAudio() {
        this.audioNodes = CHANNEL_CONFIG.map(cfg=>createSpatialTone(cfg.freq));
        CHANNEL_CONFIG.forEach((cfg,i)=>this.setPannerPos(i,cfg.trajectory(0)));
    }

    // FIX 2: startAudio / stopAudio 现在接受一个可选的"已在手势中"参数
    // 在 VR selectstart 事件里直接调用 audioCtx.resume()，不依赖 promise 回调
    // 注：VR 手柄按钮现在走的是 setupVR() 里内联的逻辑，不调用这两个方法，
    // 但这两个方法保留着，方便桌面浏览器控制台直接敲
    // window.app.startAudio() / window.app.stopAudio() 测试音频，不用戴头显
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
        if (this.running) this.elapsed += dt;
        const t = this.elapsed;
        // DEBUG: 每 60 帧打一次日志，确认 running 和 elapsed 在增加
        if (!this._dbgFrame) this._dbgFrame = 0;
        if (++this._dbgFrame % 60 === 0) {
            console.log(`[Sounding Space] running=${this.running} elapsed=${t.toFixed(2)} dt=${dt.toFixed(4)}`);
        }
        this.spheres.forEach(({mesh, halo, cfg}, i) => {
            const pos = cfg.trajectory(t);
            mesh.position.set(pos.x, pos.y, pos.z);
            halo.lookAt(this.camera.position);
            mesh.material.emissiveIntensity = (this.running && cfg.moving) ? 0.5 + 0.25 * Math.sin(t * 2 + i) : 0.3;
            this.setPannerPos(i, pos);
        });
    }

    // ─── Clocks ───────────────────────────────────────────────────────────────
    // 跟 updateSpheres 完全对称：到了 triggerTime 就沿 trajectory 更新钟表的位置和音源位置
    updateClocks(dt) {
        if (!this.clockRegistry || !this.running) return;
        const t = this.elapsed;

        this.clockRegistry.forEach((clockData) => {
            if (t < clockData.triggerTime) return; // 还没到触发时间

            // 第一次越过触发时间：淡入音量（0.8 秒线性淡入），而不是瞬间跳到目标音量
            if (!clockData.soundStarted) {
                clockData.soundStarted = true;
                const gainParam = clockData.audioNode.gain.gain;
                gainParam.cancelScheduledValues(audioCtx.currentTime);
                gainParam.setValueAtTime(0, audioCtx.currentTime);
                gainParam.linearRampToValueAtTime(clockData.targetGain, audioCtx.currentTime + 0.8);
            }

            const tt = Math.min((t - clockData.triggerTime) / clockData.duration, 1);
            const pos = clockData.trajectory(clockData.originalPosition, tt);

            clockData.object.position.set(pos.x, pos.y, pos.z);
            setImmediatePannerPos(clockData.audioNode.panner, pos);
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

    // ─── Teleport ─────────────────────────────────────────────────────────────
updateTeleport() {
    for (let i = 0; i < this.controllers.length; i++) {
        const ctrl = this.controllers[i];
        const ts = this.teleportState[i];
        if (!ctrl || !ts.aiming) continue;

        const origin = new THREE.Vector3();
        const direction = new THREE.Vector3();
        ctrl.getWorldPosition(origin);
        direction.set(0,0,-1).transformDirection(ctrl.matrixWorld).normalize();

        // 与地板平面（y = floorWorldY）求交点
        // 只有当射线朝下（direction.y < 0）时才有有效落点
        if (direction.y < -0.001) {
            const t = (this.floorWorldY - origin.y) / direction.y;
            if (t > 0) {
                ts.targetPoint.copy(origin).addScaledVector(direction, t);
                ts.targetValid = true;
            } else {
                ts.targetValid = false;
            }
        } else {
            ts.targetValid = false;
        }

        if (ts.targetValid) {
            this.teleportMarker.position.set(
                ts.targetPoint.x, this.floorWorldY + 0.01, ts.targetPoint.z
            );
            this.teleportMarker.material.color.set(0x00ff88); // 绿色=可传送
            this.teleportMarker.visible = true;
        } else {
            this.teleportMarker.visible = false;
        }

        // 只处理正在瞄准的第一个手柄，避免双手同时瞄准冲突
        break;
    }
}
    // ─── VR ───────────────────────────────────────────────────────────────────
  setupVR() {
    this.renderer.xr.enabled=true;
    this.renderer.xr.setReferenceSpaceType('local-floor')
    document.body.appendChild(VRButton.createButton(this.renderer));

    // dolly 提前创建，后面 controller/grip 都要挂在它下面
    this.dolly=new THREE.Object3D();
    this.dolly.position.set(0, 0, 0);
    this.dolly.add(this.camera);
    this.scene.add(this.dolly);

    this.renderer.xr.addEventListener('sessionstart',()=>{
        this.controls.enabled=false;
        this.vrPanel.visible=true;
        this.dolly.position.y = this.floorWorldY; // ← 修复眼高
    });
    this.renderer.xr.addEventListener('sessionend',()=>{
        this.controls.enabled=true;
        this.vrPanel.visible=false;
        this.dolly.position.y = 0;
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

            const hit = this._castController(ctrl);
            if (hit) {
                const action = hit.object.userData.action;
                if (action === 'start' && !this.running) {
                    audioCtx.resume();
                    this.running = true;
                    this._refreshPanel();
                } else if (action === 'stop' && this.running) {
                    this.running = false;
                    audioCtx.suspend();
                    this._refreshPanel();
                }
            }
        });
        ctrl.addEventListener('selectend',()=>{
            this.ctrlState[i].selectPressed=false;
        });
        ctrl.addEventListener('squeezestart',()=>{
            this.teleportState[i].aiming = true;
        });
        ctrl.addEventListener('squeezeend',()=>{
            const ts = this.teleportState[i];
            if (ts.aiming && ts.targetValid) {
                this.dolly.position.x = ts.targetPoint.x;
                this.dolly.position.z = ts.targetPoint.z;
            }
            ts.aiming = false;
            this.teleportMarker.visible = false;
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
        this.dolly.add(ctrl); // ← 改成挂在 dolly 下面
    });

    this.grips=[
        this.renderer.xr.getControllerGrip(0),
        this.renderer.xr.getControllerGrip(1)
    ];
    const factory=new XRControllerModelFactory();
    this.grips.forEach((g,i)=>{
        g.add(factory.createControllerModel(g));
        this.dolly.add(g); // ← 改成挂在 dolly 下面
    });

    this.buildVRPanel();
}

    resize() {
        this.camera.aspect=window.innerWidth/window.innerHeight;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(window.innerWidth,window.innerHeight);
    }

    render() {
        const dt = this.clock.getDelta();   // THREE.Clock: 直接返回正确 delta
        this.stats.update();

        this._processController(this.controllers[0], this.ctrlState[0]);
        this._processController(this.controllers[1], this.ctrlState[1]);
        this.updateTeleport();
        this.updateSpheres(dt);
        this.updateClocks(dt);
        this.updateAudioListener();
        this.renderer.render(this.scene,this.camera);
    }
}

export { App };