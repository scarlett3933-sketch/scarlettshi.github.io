import * as THREE from 'three';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';
import Stats from 'three/addons/libs/stats.module.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

document.addEventListener('DOMContentLoaded', function () {
    const app = new App();
    window.app = app;
});

// ============================================================================
// AUDIO / MASTER TIMELINE
// ============================================================================
//
// 设计逻辑：
//
// DAW 已经决定音乐时间轴。
// 所有 Clock_N 音频都从 0:00 同时开始播放。
//
// WebXR 只负责：
//
// 1. 每个声音来自哪个 Clock
// 2. Clock 什么时候开始移动
// 3. Clock 移动时，空间声音跟着移动
//
// ============================================================================

const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

// public/audio/Clock_1.mp3
// public/audio/Clock_2.mp3
// public/audio/Clock_3.mp3
// ...

const CLOCK_AUDIO_FOLDER = 'audio';
const CLOCK_AUDIO_EXTENSION = 'mp3';

// 每个 stem 自己的 gain。
// 1.0 = 保留 DAW bounce 出来的相对音量。

const CLOCK_STEM_GAIN = 1.0;

// 整体总输出音量。
// 如果以后发现整体太响，可以改成 0.6 / 0.5。

const MASTER_GAIN = 1.0;

// Quest 不要一次同时 decode 太多音频。
// 一次并行处理 6 个。

const AUDIO_LOAD_CONCURRENCY = 6;

// ============================================================================
// MOVEMENT TIMELINE
// ============================================================================
//
// 注意：
// 这里完全不控制 audio start。
//
// 所有 audio 永远都是从 0:00 同时开始。
//
// 这里的 start 只表示：
// "这个 Clock 在作品第几秒开始运动。"
//
// 单位 = 秒。
//
// 例如：
// 1:13.420
//
// 就是：
// 60 + 13.420 = 73.420 秒
//
// ============================================================================

const CLOCK_MOVEMENT = {
    // 以后正式时间写在这里。
    // 例如：
    // Clock_1: {
    //     start: 35.20,
    //     duration: 6
    // },
    // Clock_7: {
    //     start: 62.50,
    //     duration: 6
    // },
    // Clock_12: {
    //     start: 73.42,
    //     duration: 8
    // }
};

// ============================================================================
// CLOCK HELPERS
// ============================================================================

// Clock_12 → 12

function getClockNumber(name) {
    const match = /^Clock_(\d+)$/i.exec(name);
    return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

// 找某个 Clock 的 movement cue。

function getMovementConfig(clockName, index) {
    const custom = CLOCK_MOVEMENT[clockName];

    // 如果我们已经给它写了正式时间，
    // 就使用正式时间。

    if (custom) {
        return {
            start: custom.start,
            duration: custom.duration ?? 6,
        };
    }

    // ------------------------------------------------------------
    // 临时测试 movement
    // ------------------------------------------------------------
    //
    // 在你还没有填写正式 movement 时间之前：
    //
    // Clock_1  = 5.0 sec
    // Clock_2  = 5.3 sec
    // Clock_3  = 5.6 sec
    //
    // ...
    //
    // 这样我们可以先看到钟确实在动。
    //
    // 正式做作品时我们会把这个 fallback 删除。
    // ------------------------------------------------------------

    return {
        start: 5 + index * 0.3,
        duration: 6,
    };
}

// ============================================================================
// SPATIAL AUDIO HELPERS
// ============================================================================

function createSpatialPanner() {
    const panner = audioCtx.createPanner();

    // HRTF = headphone binaural spatialization

    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';

    // 参考距离

    panner.refDistance = 4;

    // 超过这个距离基本不继续计算明显距离变化

    panner.maxDistance = 40;

    // 距离衰减程度

    panner.rolloffFactor = 0.5;

    // 360° 发声。
    // 也就是说 Clock 现在是 omnidirectional point source。

    panner.coneInnerAngle = 360;
    panner.coneOuterAngle = 360;
    panner.coneOuterGain = 0;

    return panner;
}

// 每一个 Clock 的 signal flow:
//
// Audio File
// ↓
// Gain
// ↓
// Panner
// ↓
// Master Gain
// ↓
// Headphones

function createClockSpatialChain(outputNode, initialPosition) {
    const gain = audioCtx.createGain();
    const panner = createSpatialPanner();

    gain.gain.value = CLOCK_STEM_GAIN;
    gain.connect(panner);
    panner.connect(outputNode);

    setImmediatePannerPos(panner, initialPosition);

    return {
        gain,
        panner,
        source: null,
    };
}

// 加载并 decode 一个真正的音频文件。

async function loadAudioBuffer(url) {
    const response = await fetch(url);

    if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return await audioCtx.decodeAudioData(arrayBuffer);
}

// 把 Web Audio Panner 放到
// Three.js 的世界坐标。

function setImmediatePannerPos(panner, pos) {
    if (panner.positionX) {
        panner.positionX.value = pos.x;
        panner.positionY.value = pos.y;
        panner.positionZ.value = pos.z;
    } else {
        panner.setPosition(pos.x, pos.y, pos.z);
    }
}

// ============================================================================
// VR BUTTON
// ============================================================================

function makeButtonMesh(label, r, g, b, w = 0.3, h = 0.1) {
    const CW = 512;
    const CH = 160;

    const canvas = document.createElement('canvas');
    canvas.width = CW;
    canvas.height = CH;

    const ctx = canvas.getContext('2d');

    // ------------------------------------------------------------
    // 只画一次按钮的 NORMAL / 最亮状态
    // hover 和 pressed 不再重新画 canvas
    // ------------------------------------------------------------

    ctx.clearRect(0, 0, CW, CH);
    ctx.fillStyle = `rgb(${r},${g},${b})`;

    const R = 28;

    ctx.beginPath();
    ctx.moveTo(R, 0);
    ctx.lineTo(CW - R, 0);
    ctx.quadraticCurveTo(CW, 0, CW, R);
    ctx.lineTo(CW, CH - R);
    ctx.quadraticCurveTo(CW, CH, CW - R, CH);
    ctx.lineTo(R, CH);
    ctx.quadraticCurveTo(0, CH, 0, CH - R);
    ctx.lineTo(0, R);
    ctx.quadraticCurveTo(0, 0, R, 0);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 5;
    ctx.stroke();

    ctx.fillStyle = '#fff';
    ctx.font = 'bold 68px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, CW / 2, CH / 2);

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;

    const material = new THREE.MeshBasicMaterial({
        map: tex,

        // NORMAL 状态保持 texture 原本的亮度
        color: 0xffffff,

        transparent: true,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide,

        // UI 不受 tone mapping 影响
        toneMapped: false,
    });

    const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(w, h),
        material,
    );

    // Panel background = 100
    // Button = 101
    // 保证按钮永远画在 panel 背景上面
    mesh.renderOrder = 101;

    mesh.userData = {
        isBtn: true,

        // 当前视觉状态
        visualState: 'normal',

        // --------------------------------------------------------
        // 三个按钮亮度
        //
        // normal  = 常亮
        // hover   = 变暗
        // pressed = 最暗
        // --------------------------------------------------------

        brightnessNormal: 1.0,
        brightnessHover: 0.58,
        brightnessPressed: 0.28,
    };

    return mesh;
}

// ============================================================================
// APP
// ============================================================================

class App {
    // ========================================================================
    // CONSTRUCTOR
    // ========================================================================

    constructor() {
        const container = document.createElement('div');
        document.body.appendChild(container);

        this.teleportDebugFrame = 0;

        // ------------------------------------------------------------
        // FLOOR / EYE HEIGHT
        // ------------------------------------------------------------
        //
        // FLOOR_OFFSET 用于 dolly / 玩家高度。
        // teleport 单独使用真正的视觉地面 Y = 0。
        // ------------------------------------------------------------

        // FLOOR_OFFSET = 0
        //
        // 因为我们用的是 local-floor reference space。
        //
        // Quest 已经自己知道你的眼睛离真实地面多高，
        // 而模型地板也已经对齐到世界坐标 y = 0。
        //
        // 所以这里再加任何数值，
        // 都等于把人整个抬到空中。
        //
        // 如果以后发现还是偏高 / 偏低，
        // 只改这一个数字就够了。

        const FLOOR_OFFSET = 1.30;

        // 桌面端（非 VR）的相机高度。
        // 进入 VR 后这个值会被 WebXR 覆盖。

        const EYE_HEIGHT = 1.6;
        const cameraY = EYE_HEIGHT + FLOOR_OFFSET;

        this.floorWorldY = FLOOR_OFFSET;
        this.teleportFloorY = 0;

        // ------------------------------------------------------------
        // VR PANEL PLACEMENT
        // ------------------------------------------------------------
        //
        // 面板放在视线略下方，
        // 不用低头也不用抬头。

        this.panelDistance = 1.2;
        this.panelVerticalOffset = -0.25;

        // ------------------------------------------------------------
        // TELEPORT STATE
        // ------------------------------------------------------------

        this.teleportState = [
            {
                aiming: false,
                targetValid: false,
                targetPoint: new THREE.Vector3(),
            },
            {
                aiming: false,
                targetValid: false,
                targetPoint: new THREE.Vector3(),
            },
        ];

        // ------------------------------------------------------------
        // THREE CLOCK
        //
        // 现在它只负责普通 render tick。
        //
        // 不再负责音乐作品时间轴。
        // ------------------------------------------------------------

        this.clock = new THREE.Clock();

        // ------------------------------------------------------------
        // MASTER TIMELINE STATE
        // ------------------------------------------------------------

        this.running = false;
        this.timelineStarted = false;
        this.timelineStartAt = null;
        this.audioReady = false;
        this.audioLoading = false;
        this.audioLoadErrors = [];

        // ------------------------------------------------------------
        // CAMERA
        // ------------------------------------------------------------

        this.camera = new THREE.PerspectiveCamera(
            50,
            window.innerWidth / window.innerHeight,
            0.1,
            200,
        );
        this.camera.position.set(0, cameraY, 0);

        // ------------------------------------------------------------
        // SCENE
        // ------------------------------------------------------------

        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x101820);
        this.scene.add(new THREE.HemisphereLight(0xffffff, 0x202020, 0.6));

        const dl = new THREE.DirectionalLight(0xffffff, 2);
        dl.position.set(1, 3, 2).normalize();
        this.scene.add(dl);

        // ------------------------------------------------------------
        // RENDERER
        // ------------------------------------------------------------

        this.renderer = new THREE.WebGLRenderer({
            antialias: true,
        });
        this.renderer.setPixelRatio(window.devicePixelRatio);
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.outputColorSpace = THREE.SRGBColorSpace;
        container.appendChild(this.renderer.domElement);

        // ------------------------------------------------------------
        // DESKTOP CONTROLS
        // ------------------------------------------------------------

        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.target.set(0, cameraY, 0);
        this.controls.update();

        // ------------------------------------------------------------
        // DEBUG / RAYCASTER
        // ------------------------------------------------------------

        this.stats = new Stats();
        this.rc = new THREE.Raycaster();

        // ------------------------------------------------------------
        // CONTROLLER STATE
        // ------------------------------------------------------------

        this.ctrlState = [
            {
                selectPressed: false,
                justFired: false,
                hoveredBtn: null,
                pressedBtn: null,
                debugLastAction: null,
                ray: null,
            },
            {
                selectPressed: false,
                justFired: false,
                hoveredBtn: null,
                pressedBtn: null,
                debugLastAction: null,
                ray: null,
            },
        ];

        // ------------------------------------------------------------
        // INITIALIZE
        // ------------------------------------------------------------

        this.initScene();

        // 必须先建立 masterGain，
        // 然后才能给 Clock 创建 panner chain。

        this.setupAudio();
        this.loadClockModel();
        this.setupVR();

        window.addEventListener('resize', this.resize.bind(this));
        this.renderer.setAnimationLoop(this.render.bind(this));
    }

    // ========================================================================
    // LOAD GLB
    // ========================================================================

    loadClockModel() {
        const DEBUG_MESH_INFO = false;

        const loader = new GLTFLoader();
        const modelUrl = `${import.meta.env.BASE_URL}models/Thousand Clocks Demo.glb`;

        loader.load(
            modelUrl,

            // ------------------------------------------------------------
            // SUCCESS
            // ------------------------------------------------------------

            (gltf) => {
                const model = gltf.scene;

                // --------------------------------------------------------
                // DEBUG MODEL INFO
                // --------------------------------------------------------

                if (DEBUG_MESH_INFO) {
                    const allMeshInfo = [];

                    model.traverse((object) => {
                        if (!object.isMesh) {
                            return;
                        }

                        const meshBox = new THREE.Box3().setFromObject(object);
                        const meshSize = new THREE.Vector3();
                        meshBox.getSize(meshSize);

                        allMeshInfo.push({
                            name: object.name,
                            material: object.material?.name,
                            maxDim: Math.max(meshSize.x, meshSize.y, meshSize.z),
                            size: meshSize,
                        });
                    });

                    allMeshInfo.sort((a, b) => b.maxDim - a.maxDim);

                    console.log('模型里一共有', allMeshInfo.length, '个 mesh');
                    console.table(
                        allMeshInfo.slice(0, 10).map((m) => ({
                            name: m.name,
                            material: m.material,
                            maxDim: m.maxDim.toFixed(3),
                        })),
                    );
                }

                // --------------------------------------------------------
                // REMOVE SKY / WORLD GRID
                // --------------------------------------------------------

                const meshesToRemove = [];

                model.traverse((object) => {
                    if (!object.isMesh) {
                        return;
                    }

                    const objectInfo = `${object.name} ${object.material?.name || ''}`;
                    const isWorldGrid = /HLOD|MainGrid|ProcGrid|Landscape|Sky|Dome/i.test(
                        objectInfo,
                    );

                    if (isWorldGrid) {
                        meshesToRemove.push(object);
                    }
                });

                meshesToRemove.forEach((object) => {
                    object.parent?.remove(object);
                });

                // --------------------------------------------------------
                // CALCULATE MODEL SIZE
                // --------------------------------------------------------

                const box = new THREE.Box3().setFromObject(model);
                const size = new THREE.Vector3();
                const center = new THREE.Vector3();

                box.getSize(size);
                box.getCenter(center);

                console.log('删除后模型尺寸：', {
                    x: size.x,
                    y: size.y,
                    z: size.z,
                });
                console.log('删除后模型中心：', {
                    x: center.x,
                    y: center.y,
                    z: center.z,
                });

                // --------------------------------------------------------
                // CENTER MODEL
                // --------------------------------------------------------

                model.position.x -= center.x;
                model.position.z -= center.z;
                model.position.y -= box.min.y;

                // --------------------------------------------------------
                // WRAPPER
                // --------------------------------------------------------

                const wrapper = new THREE.Group();
                wrapper.name = 'ClocksModelWrapper';
                wrapper.add(model);

                const maxDim = Math.max(size.x, size.y, size.z);
                const targetSize = 14.0;
                const scale = targetSize / maxDim;

                wrapper.scale.setScalar(scale);
                wrapper.position.set(0, 0, 0);
                this.scene.add(wrapper);

                // --------------------------------------------------------
                // OPTIONAL CLICK DEBUG
                // --------------------------------------------------------

                if (DEBUG_MESH_INFO) {
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
                                '世界坐标:',
                                worldPos.toArray().map((v) => v.toFixed(2)),
                                'parent:',
                                obj.parent?.name,
                                'parent的parent:',
                                obj.parent?.parent?.name,
                            );
                        } else {
                            console.log('没点中任何东西');
                        }
                    });
                }

                // ========================================================
                // FIND ALL Clock_N GROUPS
                // ========================================================

                this.clockRegistry = [];
                const clockGroups = [];

                model.traverse((object) => {
                    if (/^Clock_\d+$/i.test(object.name)) {
                        clockGroups.push(object);
                    }
                });

                // GLB traverse 顺序不一定是：
                //
                // Clock_1
                // Clock_2
                // Clock_3
                //
                // 所以我们手动按数字排序。

                clockGroups.sort((a, b) => getClockNumber(a.name) - getClockNumber(b.name));

                console.log(
                    `找到 ${clockGroups.length} 个钟表 Group：`,
                    clockGroups.map((g) => g.name),
                );

                // ========================================================
                // BUILD CLOCK REGISTRY
                // ========================================================

                clockGroups.forEach((clockObj, index) => {
                    // ------------------------------------------------
                    // 把 Clock 从 wrapper 中 detach 出来。
                    //
                    // scene.attach() 会保持视觉上的
                    // 世界坐标 / rotation / scale 不变。
                    // ------------------------------------------------

                    this.scene.attach(clockObj);
                    const originalPosition = clockObj.position.clone();

                    // ------------------------------------------------
                    // MOVEMENT DATA
                    // ------------------------------------------------

                    const movement = getMovementConfig(clockObj.name, index);

                    // ------------------------------------------------
                    // AUDIO FILE
                    //
                    // Clock_12
                    //
                    // 自动变成：
                    //
                    // public/audio/Clock_12.mp3
                    // ------------------------------------------------

                    const audioUrl =
                        `${import.meta.env.BASE_URL}` +
                        `${CLOCK_AUDIO_FOLDER}/` +
                        `${clockObj.name}.` +
                        `${CLOCK_AUDIO_EXTENSION}`;

                    // ------------------------------------------------
                    // SPATIAL AUDIO CHAIN
                    // ------------------------------------------------

                    const audioNode = createClockSpatialChain(this.masterGain, originalPosition);

                    // ------------------------------------------------
                    // REGISTER CLOCK
                    // ------------------------------------------------

                    this.clockRegistry.push({
                        name: clockObj.name,
                        object: clockObj,
                        originalPosition,

                        // ---------------- AUDIO ----------------

                        audioUrl,
                        audioBuffer: null,
                        audioNode,

                        // ------------- MOVEMENT ---------------

                        movementStart: movement.start,
                        duration: movement.duration,

                        // ------------------------------------------------
                        // TEST TRAJECTORY
                        //
                        // 先继续用上一版的测试轨迹。
                        //
                        // 后面我们会正式设计每个钟的运动。
                        // ------------------------------------------------

                        trajectory: (originalPos, tt) => ({
                            x: originalPos.x + tt * 3 * Math.sin(index),
                            y: originalPos.y - tt * 2,
                            z: originalPos.z + tt * 5 * Math.cos(index),
                        }),
                    });
                });

                // ========================================================
                // LOAD REAL DAW STEMS
                // ========================================================

                this.loadClockAudioFiles();
                console.log('Clock model loaded, scale:', scale);
            },

            // ------------------------------------------------------------
            // LOADING PROGRESS
            // ------------------------------------------------------------

            (xhr) => {
                if (xhr.total) {
                    console.log(
                        `Clock model ${((xhr.loaded / xhr.total) * 100).toFixed(1)}% loaded`,
                    );
                }
            },

            // ------------------------------------------------------------
            // ERROR
            // ------------------------------------------------------------

            (error) => {
                console.error('Error loading clock model:', error);
            },
        );
    }

    // ========================================================================
    // SCENE
    // ========================================================================

    initScene() {
        // ------------------------------------------------------------
        // ORIGIN DEBUG
        // ------------------------------------------------------------

        const originMarker = new THREE.Mesh(
            new THREE.SphereGeometry(0.12, 16, 16),
            new THREE.MeshBasicMaterial({
                color: 0xffff00,
            }),
        );
        originMarker.position.set(0, 0, 0);
        this.scene.add(originMarker);

        const axesHelper = new THREE.AxesHelper(3);
        this.scene.add(axesHelper);

        // ------------------------------------------------------------
        // FOG
        // ------------------------------------------------------------

        this.scene.fog = new THREE.FogExp2(0x101820, 0.018);

        // ------------------------------------------------------------
        // GROUND
        // ------------------------------------------------------------

        const ground = new THREE.Mesh(
            new THREE.PlaneGeometry(200, 200),
            new THREE.MeshPhongMaterial({
                color: 0x1a2030,
                depthWrite: false,
            }),
        );
        ground.rotation.x = -Math.PI / 2;
        this.scene.add(ground);

        // ------------------------------------------------------------
        // GRID
        // ------------------------------------------------------------

        const grid = new THREE.GridHelper(200, 40, 0x334466, 0x222233);
        grid.material.opacity = 0.5;
        grid.material.transparent = true;
        this.scene.add(grid);

        // ------------------------------------------------------------
        // ORIGIN RING
        // ------------------------------------------------------------

        const ring = new THREE.Mesh(
            new THREE.RingGeometry(0.3, 0.35, 32),
            new THREE.MeshBasicMaterial({
                color: 0xffffff,
                side: THREE.DoubleSide,
                opacity: 0.25,
                transparent: true,
            }),
        );
        ring.rotation.x = -Math.PI / 2;
        ring.position.set(0, 0.01, 0);
        this.scene.add(ring);

        // ------------------------------------------------------------
        // TELEPORT MARKER
        // ------------------------------------------------------------

        const markerGeo = new THREE.RingGeometry(0.32, 0.48, 48);

        const markerMat = new THREE.MeshBasicMaterial({
            color: 0x00ff88,
            side: THREE.DoubleSide,
            transparent: true,
            opacity: 1,
            depthTest: false,
            depthWrite: false,
        });

        this.teleportMarker = new THREE.Mesh(markerGeo, markerMat);
        this.teleportMarker.rotation.x = -Math.PI / 2;
        this.teleportMarker.renderOrder = 1000;
        this.teleportMarker.visible = false;
        this.scene.add(this.teleportMarker);
    }

    // ========================================================================
    // AUDIO SETUP
    // ========================================================================

    setupAudio() {
        this.masterGain = audioCtx.createGain();
        this.masterGain.gain.value = MASTER_GAIN;
        this.masterGain.connect(audioCtx.destination);
    }

    // ========================================================================
    // LOAD ALL CLOCK AUDIO FILES
    // ========================================================================

    async loadClockAudioFiles() {
        if (!this.clockRegistry || this.clockRegistry.length === 0 || this.audioLoading) {
            return;
        }

        this.audioLoading = true;
        this.audioReady = false;
        this.audioLoadErrors = [];

        const queue = [...this.clockRegistry];
        let loadedCount = 0;

        const worker = async () => {
            while (queue.length > 0) {
                const clockData = queue.shift();

                if (!clockData) {
                    break;
                }

                try {
                    clockData.audioBuffer = await loadAudioBuffer(clockData.audioUrl);
                    loadedCount++;

                    console.log(
                        `[Audio] ${loadedCount}/${this.clockRegistry.length} loaded: ${clockData.name}`,
                    );
                } catch (error) {
                    this.audioLoadErrors.push({
                        name: clockData.name,
                        url: clockData.audioUrl,
                        error,
                    });

                    console.error(
                        `[Audio] Failed to load ${clockData.name}:`,
                        clockData.audioUrl,
                        error,
                    );
                }
            }
        };

        const workerCount = Math.min(AUDIO_LOAD_CONCURRENCY, queue.length);

        await Promise.all(
            Array.from(
                {
                    length: workerCount,
                },
                () => worker(),
            ),
        );

        this.audioLoading = false;
        this.audioReady =
            this.audioLoadErrors.length === 0 &&
            this.clockRegistry.every((clockData) => clockData.audioBuffer);

        // ------------------------------------------------------------
        // ALL AUDIO READY
        // ------------------------------------------------------------

        if (this.audioReady) {
            const durations = this.clockRegistry.map((clockData) => clockData.audioBuffer.duration);
            const minDuration = Math.min(...durations);
            const maxDuration = Math.max(...durations);

            console.log(
                `%c[Audio] READY — ` +
                    `${this.clockRegistry.length} stems decoded. ` +
                    `Duration range: ` +
                    `${minDuration.toFixed(3)}s–` +
                    `${maxDuration.toFixed(3)}s`,
                'color:#00ff88;font-weight:bold',
            );

            // --------------------------------------------------------
            // CHECK DAW EXPORT LENGTH
            // --------------------------------------------------------

            if (maxDuration - minDuration > 0.02) {
                console.warn(
                    '[Audio] Stem lengths are not identical. ' + 'Check DAW export boundaries.',
                );
            }
        }

        // ------------------------------------------------------------
        // AUDIO LOAD ERROR
        // ------------------------------------------------------------
        else {
            console.error(
                `[Audio] NOT READY — ` + `${this.audioLoadErrors.length} file(s) failed.`,
                this.audioLoadErrors,
            );
        }

        this._refreshPanel();
    }

    // ========================================================================
    // CREATE & SCHEDULE ALL AUDIO SOURCES
    // ========================================================================
    //
    // AudioBufferSourceNode 是 one-shot。
    //
    // 所以第一次按 Start 的时候，
    // 才真正创建所有 source。
    //
    // ========================================================================

    _createAndScheduleClockSources(startAt) {
        this.clockRegistry.forEach((clockData) => {
            const source = audioCtx.createBufferSource();
            source.buffer = clockData.audioBuffer;
            source.connect(clockData.audioNode.gain);

            // ====================================================
            // 最重要的同步点
            //
            // 每一个音频都收到完全相同的 startAt。
            // ====================================================

            source.start(startAt, 0);
            clockData.audioNode.source = source;
        });
    }

    // ========================================================================
    // MASTER TIMELINE TIME
    // ========================================================================

    getTimelineTime() {
        if (!this.timelineStarted || this.timelineStartAt === null) {
            return 0;
        }

        // AudioContext.currentTime
        // 是真正的作品 master clock。

        return Math.max(0, audioCtx.currentTime - this.timelineStartAt);
    }

    // ========================================================================
    // START / RESUME
    // ========================================================================

    async startAudio() {
        if (this.running) {
            return;
        }

        // ------------------------------------------------------------
        // DON'T START UNTIL EVERY STEM IS READY
        // ------------------------------------------------------------

        if (!this.audioReady) {
            console.warn(
                '[Audio] Audio is not ready yet. ' +
                    'Wait for all Clock_N files to finish loading.',
            );
            console.log(this.audioLoadErrors);
            return;
        }

        // ------------------------------------------------------------
        // RESUME AUDIO CONTEXT
        // ------------------------------------------------------------

        await audioCtx.resume();

        // ------------------------------------------------------------
        // FIRST START ONLY
        // ------------------------------------------------------------

        if (!this.timelineStarted) {
            // 安排到未来 120ms。
            //
            // 所有 source 可以提前收到完全相同的
            // AudioContext timestamp。

            const startAt = audioCtx.currentTime + 0.12;

            this.timelineStartAt = startAt;
            this._createAndScheduleClockSources(startAt);
            this.timelineStarted = true;

            console.log(
                `%c[Timeline] START scheduled at ${startAt.toFixed(3)}`,
                'color:#66ccff;font-weight:bold',
            );
        }

        // 如果不是第一次，
        // 就是 Stop/Pause 之后继续。

        this.running = true;
        this._refreshPanel();
        this.hideVRPanel();
    }

    // ========================================================================
    // PAUSE
    // ========================================================================

    async stopAudio() {
        if (!this.running) {
            return;
        }

        await audioCtx.suspend();
        this.running = false;
        this._refreshPanel();

        console.log(`[Timeline] Paused at ` + `${this.getTimelineTime().toFixed(3)} sec`);
    }

    // ========================================================================
    // AUDIO LISTENER
    // ========================================================================
    //
    // Listener = 玩家头的位置和朝向。
    //
    // Clock Panner = 声源位置。
    //
    // Web Audio 根据这两者的相对位置计算 HRTF。
    //
    // ========================================================================

    updateAudioListener() {
        const pos = new THREE.Vector3();
        const fwd = new THREE.Vector3();

        this.camera.getWorldPosition(pos);
        this.camera.getWorldDirection(fwd);

        const listener = audioCtx.listener;

        if (listener.positionX) {
            listener.positionX.value = pos.x;
            listener.positionY.value = pos.y;
            listener.positionZ.value = pos.z;
            listener.forwardX.value = fwd.x;
            listener.forwardY.value = fwd.y;
            listener.forwardZ.value = fwd.z;
            listener.upX.value = 0;
            listener.upY.value = 1;
            listener.upZ.value = 0;
        } else {
            listener.setPosition(pos.x, pos.y, pos.z);
            listener.setOrientation(fwd.x, fwd.y, fwd.z, 0, 1, 0);
        }
    }

    // ========================================================================
    // CLOCK MOVEMENT
    // ========================================================================

    updateClocks() {
        if (!this.clockRegistry || !this.running || !this.timelineStarted) {
            return;
        }

        // ================================================================
        // MASTER TIME COMES FROM AUDIO
        // ================================================================

        const t = this.getTimelineTime();

        this.clockRegistry.forEach((clockData) => {
            // --------------------------------------------------------
            // NOT TIME TO MOVE YET
            // --------------------------------------------------------

            if (t < clockData.movementStart) {
                return;
            }

            // --------------------------------------------------------
            // MOVEMENT PROGRESS
            //
            // tt = 0 → movement just started
            // tt = 1 → movement complete
            // --------------------------------------------------------

            const tt = Math.min((t - clockData.movementStart) / clockData.duration, 1);

            // --------------------------------------------------------
            // GET POSITION ON TRAJECTORY
            // --------------------------------------------------------

            const pos = clockData.trajectory(clockData.originalPosition, tt);

            // --------------------------------------------------------
            // MOVE VISUAL CLOCK
            // --------------------------------------------------------

            clockData.object.position.set(pos.x, pos.y, pos.z);

            // --------------------------------------------------------
            // MOVE AUDIO PANNER
            //
            // 音频本身一直连续播放。
            //
            // 这里只是改变它的空间坐标。
            // --------------------------------------------------------

            setImmediatePannerPos(clockData.audioNode.panner, pos);
        });

        // ------------------------------------------------------------
        // DEBUG TIMELINE
        // ------------------------------------------------------------

        if (!this._timelineDebugFrame) {
            this._timelineDebugFrame = 0;
        }

        if (++this._timelineDebugFrame % 180 === 0) {
            console.log(`[Timeline] ${t.toFixed(3)}s`);
        }
    }

    // ========================================================================
    // VR PANEL
    // ========================================================================

    buildVRPanel() {
        const CW = 720;
        const CH = 260;

        const pc = document.createElement('canvas');
        pc.width = CW;
        pc.height = CH;

        const px = pc.getContext('2d');

        px.fillStyle = 'rgba(8,14,26,0.92)';
        px.roundRect(0, 0, CW, CH, 32);
        px.fill();

        px.strokeStyle = 'rgba(255,255,255,0.2)';
        px.lineWidth = 4;
        px.roundRect(2, 2, CW - 4, CH - 4, 30);
        px.stroke();

        px.fillStyle = 'rgba(255,255,255,0.55)';
        px.font = '38px sans-serif';
        px.textAlign = 'center';
        px.fillText('A Thousand Clocks', CW / 2, 58);

        const ptex = new THREE.CanvasTexture(pc);
        ptex.colorSpace = THREE.SRGBColorSpace;

        const bg = new THREE.Mesh(
    new THREE.PlaneGeometry(1.05, 0.38),
    new THREE.MeshBasicMaterial({
        map: ptex,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
    }),
);

// 背景先画
bg.renderOrder = 100;

        // 基础色 = NORMAL 状态（最亮）。
        // hover / pressed 会自动在这个基础上变暗。

        this.vrBtnStart = makeButtonMesh('▶  Start', 60, 200, 115);
        this.vrBtnStart.userData.action = 'start';

        this.vrBtnResume = makeButtonMesh('▶  Resume', 60, 200, 115);
        this.vrBtnResume.userData.action = 'resume';

        this.vrBtnRestart = makeButtonMesh('↻  Restart', 230, 155, 55);
        this.vrBtnRestart.userData.action = 'restart';

        this.vrBtnExit = makeButtonMesh('✕  Exit VR', 225, 75, 75);
        this.vrBtnExit.userData.action = 'exit';

        this.vrPanel = new THREE.Group();
        this.vrPanel.add(
            bg,
            this.vrBtnStart,
            this.vrBtnResume,
            this.vrBtnRestart,
            this.vrBtnExit,
        );

        this.vrPanel.visible = false;
        this.dolly.add(this.vrPanel);

        this.setPanelMode('initial');
        this._refreshPanel();
    }

    setPanelMode(mode) {
        const initial = mode === 'initial';

        this.vrBtnStart.visible = initial;
        this.vrBtnResume.visible = !initial;
        this.vrBtnRestart.visible = !initial;
        this.vrBtnExit.visible = true;

        if (initial) {
            this.vrBtnStart.position.set(-0.17, -0.07, 0.01);
            this.vrBtnExit.position.set(0.17, -0.07, 0.01);
        } else {
            this.vrBtnResume.position.set(-0.32, -0.07, 0.01);
this.vrBtnRestart.position.set(0, -0.07, 0.01);
this.vrBtnExit.position.set(0.32, -0.07, 0.01);
        }

        this._refreshPanel();
    }

    showVRPanel() {
        if (!this.vrPanel) {
            return;
        }

        const headPos = new THREE.Vector3();
        const forward = new THREE.Vector3();

        this.camera.getWorldPosition(headPos);
        this.camera.getWorldDirection(forward);

        forward.y = 0;

        if (forward.lengthSq() < 0.0001) {
            forward.set(0, 0, -1);
        }

        forward.normalize();

        const panelWorldPos = headPos.clone().addScaledVector(forward, this.panelDistance);
        panelWorldPos.y = headPos.y + this.panelVerticalOffset;

        this.vrPanel.position.copy(this.dolly.worldToLocal(panelWorldPos.clone()));
        this.vrPanel.rotation.set(0, Math.atan2(-forward.x, -forward.z), 0);

        this.ctrlState.forEach((state) => {
            state.hoveredBtn = null;
        });

        this._refreshPanel();
        this.vrPanel.visible = true;
    }

    hideVRPanel() {
        if (this.vrPanel) {
            this.vrPanel.visible = false;
        }
    }

    async pauseAndShowMenu() {
        if (this.running) {
            await this.stopAudio();
        }

        this.setPanelMode(this.timelineStarted ? 'paused' : 'initial');
        this.showVRPanel();
    }

    resetExperience() {
        if (this.clockRegistry) {
            this.clockRegistry.forEach((clockData) => {
                const source = clockData.audioNode.source;

                if (source) {
                    try {
                        source.stop();
                    } catch (_) {}

                    try {
                        source.disconnect();
                    } catch (_) {}

                    clockData.audioNode.source = null;
                }

                clockData.object.position.copy(clockData.originalPosition);

                setImmediatePannerPos(clockData.audioNode.panner, clockData.originalPosition);
            });
        }

        this.running = false;
        this.timelineStarted = false;
        this.timelineStartAt = null;
        this._timelineDebugFrame = 0;
    }

    async restartAudio() {
        this.resetExperience();
        await this.startAudio();
    }

    async exitVR() {
        if (this.running) {
            await this.stopAudio();
        }

        this.resetExperience();

        const session = this.renderer.xr.getSession();

        if (session) {
            await session.end();
        }
    }

    // ------------------------------------------------------------
    // 把一个按钮画成指定状态。
    //
    // mode = 'normal' | 'hover' | 'pressed'
    //
    // 只有状态真的变了才重画 canvas。
    // 否则 Quest 会每一帧重传 4 张贴图。
    // ------------------------------------------------------------

    _setButtonVisual(btn, mode) {
    if (!btn) {
        return;
    }

    const ud = btn.userData;

    if (ud.visualState === mode) {
        return;
    }

    let brightness = ud.brightnessNormal;

    if (mode === 'pressed') {
        brightness = ud.brightnessPressed;
    } else if (mode === 'hover') {
        brightness = ud.brightnessHover;
    }

    // ------------------------------------------------------------
    // 不重新画 Canvas。
    //
    // 直接改变 material 的亮度：
    //
    // normal  = 1.00
    // hover   = 0.58
    // pressed = 0.28
    // ------------------------------------------------------------

    btn.material.color.setRGB(
        brightness,
        brightness,
        brightness,
    );

    ud.visualState = mode;
}

    _panelButtons() {
        return [
            this.vrBtnStart,
            this.vrBtnResume,
            this.vrBtnRestart,
            this.vrBtnExit,
        ].filter(Boolean);
    }

    // 把所有按钮重置回 NORMAL（最亮）。

    _refreshPanel() {
        this._panelButtons().forEach((btn) => {
            this._setButtonVisual(btn, 'normal');
        });

        this.ctrlState?.forEach((state) => {
            state.pressedBtn = null;
        });
    }

    // ========================================================================
    // CONTROLLER RAY
    // ========================================================================

    _buildRayLine(ctrl) {
        const geo = new THREE.BufferGeometry();
        const positions = new Float32Array([0, 0, 0, 0, 0, -2]);
        geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));

        const mat = new THREE.LineBasicMaterial({
            color: 0xffffff,
            linewidth: 2,
            transparent: true,
            opacity: 0.7,
            depthTest: false,
        });

        const line = new THREE.Line(geo, mat);
        line.renderOrder = 999;
        ctrl.add(line);

        return line;
    }

    _updateRayLine(ray, hitDistance) {
        if (!ray) {
            return;
        }

        const pos = ray.geometry.attributes.position;
        pos.setZ(1, hitDistance ? -hitDistance : -2);
        pos.needsUpdate = true;
    }

    _castController(ctrl) {
        if (!ctrl || !this.vrPanel || !this.vrPanel.visible) {
            return null;
        }

        const origin = new THREE.Vector3();
        const direction = new THREE.Vector3();

        ctrl.getWorldPosition(origin);
        direction.set(0, 0, -1).transformDirection(ctrl.matrixWorld).normalize();

        this.rc.set(origin, direction);

        const buttons = [
            this.vrBtnStart,
            this.vrBtnResume,
            this.vrBtnRestart,
            this.vrBtnExit,
        ].filter((btn) => btn && btn.visible);

        const hits = this.rc.intersectObjects(buttons, false);

        return hits.length > 0 ? hits[0] : null;
    }

    _processControllers() {
        const buttons = [
            this.vrBtnStart,
            this.vrBtnResume,
            this.vrBtnRestart,
            this.vrBtnExit,
        ].filter((btn) => btn && btn.visible);

        const hits = [];

        for (let i = 0; i < this.controllers.length; i++) {
            const ctrl = this.controllers[i];
            const state = this.ctrlState[i];

            if (!ctrl) {
                hits.push(null);
                continue;
            }

            const hit = this._castController(ctrl);
            hits.push(hit);

            const btn = hit ? hit.object : null;

            // ------------------------------------------------
            // 射线长度
            // ------------------------------------------------

            this._updateRayLine(state.ray, hit ? hit.distance : null);

            // ------------------------------------------------
            // 白色 = 没碰到按钮
            // 绿色 = 碰到按钮
            // ------------------------------------------------

            if (state.ray) {
                state.ray.material.color.set(hit ? 0x00ff88 : 0xffffff);
            }

            state.hoveredBtn = btn;

            // ------------------------------------------------
            // DEBUG
            // 只在 hit 状态改变时打印
            //
            // 注意变量名是 hoveredAction，
            // 不能叫 action —— 会和别处的 const action 冲突。
            // ------------------------------------------------

            const hoveredAction = btn?.userData?.action ?? null;

            if (state.debugLastAction !== hoveredAction) {
                console.log(
                    `[UI Ray ${i}]`,
                    hoveredAction ? `HIT → ${hoveredAction}` : 'NO HIT',
                    hit
                        ? {
                              distance: hit.distance.toFixed(3),
                              point: hit.point.toArray().map((v) => v.toFixed(3)),
                          }
                        : '',
                );

                state.debugLastAction = hoveredAction;
            }
        }

        // ----------------------------------------------------
        // 两只手都检查完以后统一更新按钮颜色
        //
        // 优先级：
        //
        // pressed  >  hover  >  normal
        // ----------------------------------------------------

        const hoveredButtons = new Set(hits.filter(Boolean).map((hit) => hit.object));

        const pressedButtons = new Set(
            this.ctrlState.map((state) => state.pressedBtn).filter(Boolean),
        );

        buttons.forEach((btn) => {
            if (pressedButtons.has(btn)) {
                this._setButtonVisual(btn, 'pressed');
            } else if (hoveredButtons.has(btn)) {
                this._setButtonVisual(btn, 'hover');
            } else {
                this._setButtonVisual(btn, 'normal');
            }
        });
    }

    // ========================================================================
    // TELEPORT
    // ========================================================================

    updateTeleport() {
        for (let i = 0; i < this.controllers.length; i++) {
            const ctrl = this.controllers[i];
            const ts = this.teleportState[i];

            if (!ctrl || !ts.aiming) {
                continue;
            }

            const origin = new THREE.Vector3();
            const direction = new THREE.Vector3();

            ctrl.getWorldPosition(origin);
            direction.set(0, 0, -1).transformDirection(ctrl.matrixWorld).normalize();

            // --------------------------------------------------------
            // INTERSECT REAL VISIBLE FLOOR
            //
            // 玩家高度仍然有 offset，
            // 但是 teleport 要射向真正的地面 Y = 0。
            // --------------------------------------------------------

            if (direction.y < -0.001) {
                const t = (this.teleportFloorY - origin.y) / direction.y;

                if (t > 0 && t <= 12) {
                    ts.targetPoint.copy(origin).addScaledVector(direction, t);
                    ts.targetValid = true;

                    if (++this.teleportDebugFrame % 60 === 0) {
                        console.log(
                            '[Teleport target]',
                            ts.targetPoint.x.toFixed(2),
                            ts.targetPoint.y.toFixed(2),
                            ts.targetPoint.z.toFixed(2),
                        );
                    }
                } else {
                    ts.targetValid = false;
                }
            } else {
                ts.targetValid = false;
            }

            // --------------------------------------------------------
            // SHOW TELEPORT TARGET
            // --------------------------------------------------------

            if (ts.targetValid) {
                this.teleportMarker.position.set(
                    ts.targetPoint.x,
                    this.teleportFloorY + 0.04,
                    ts.targetPoint.z,
                );
                this.teleportMarker.material.color.set(0x00ff88);
                this.teleportMarker.visible = true;

                // ----------------------------------------------------
                // EXTEND CONTROLLER RAY TO TARGET
                // ----------------------------------------------------

                const teleportDistance = origin.distanceTo(ts.targetPoint);
                this._updateRayLine(this.ctrlState[i].ray, teleportDistance);

                if (this.ctrlState[i].ray) {
                    this.ctrlState[i].ray.material.color.set(0x00ff88);
                }
            } else {
                this.teleportMarker.visible = false;
            }

            // 不允许两只手同时控制 teleport marker。

            break;
        }
    }

    // ========================================================================
    // VR
    // ========================================================================

    setupVR() {
        this.renderer.xr.enabled = true;
        this.renderer.xr.setReferenceSpaceType('local-floor');
        document.body.appendChild(VRButton.createButton(this.renderer));

        // ------------------------------------------------------------
        // DOLLY
        // ------------------------------------------------------------

        this.dolly = new THREE.Object3D();
        this.dolly.position.set(0, 0, 0);
        this.dolly.add(this.camera);
        this.scene.add(this.dolly);

        this.renderer.xr.addEventListener('sessionstart', () => {
            this.controls.enabled = false;
            this.dolly.position.y = this.floorWorldY;

            this.setPanelMode('initial');
            this.showVRPanel();
        });

        this.renderer.xr.addEventListener('sessionend', async () => {
            this.controls.enabled = true;
            this.hideVRPanel();

            if (this.running) {
                await this.stopAudio();
            }

            this.resetExperience();
            this.dolly.position.y = 0;
        });

        // ------------------------------------------------------------
        // CONTROLLERS
        // ------------------------------------------------------------

        this.controllers = [this.renderer.xr.getController(0), this.renderer.xr.getController(1)];

        this.controllers.forEach((ctrl, i) => {
            // ----------------------------------------------------
            // TRIGGER
            // ----------------------------------------------------

            ctrl.addEventListener('selectstart', async () => {
    const state = this.ctrlState[i];

    state.selectPressed = true;
    state.justFired = true;

    // ========================================================
    // CASE 1:
    // Panel 没有显示
    //
    // Trigger = Pause + 呼出 menu
    // ========================================================

    if (!this.vrPanel.visible) {
        state.justFired = false;
        state.pressedBtn = null;

        await this.pauseAndShowMenu();
        return;
    }

    // ========================================================
    // CASE 2:
    // Panel 正在显示
    //
    // Trigger DOWN：
    //
    // 只让按钮进入 PRESSED 状态。
    // 此时绝对不执行 Start / Resume / Restart / Exit。
    //
    // 所以用户按住 trigger 的时候，
    // 可以清楚看到按钮保持“最暗”。
    // ========================================================

    const hit = this._castController(ctrl);

    if (!hit) {
        state.pressedBtn = null;

        console.log(`[UI PRESS ${i}] NO BUTTON`);

        return;
    }

    const pressedBtn = hit.object;

    state.pressedBtn = pressedBtn;

    this._setButtonVisual(
        pressedBtn,
        'pressed',
    );

    console.log(
        `[UI PRESS ${i}] → ${pressedBtn.userData.action}`,
    );
});


ctrl.addEventListener('selectend', async () => {
    const state = this.ctrlState[i];

    state.selectPressed = false;

    // 保存 trigger DOWN 时按到的按钮
    const pressedBtn = state.pressedBtn;

    // pressed 状态结束
    state.pressedBtn = null;

    if (!pressedBtn) {
        return;
    }

    // --------------------------------------------------------
    // 检查 trigger 松开的时候，
    // 射线是不是仍然停留在同一个按钮。
    //
    // 避免：
    //
    // 按 Start
    // ↓
    // 手移走
    // ↓
    // 松 trigger
    // ↓
    // Start 仍然误触
    // --------------------------------------------------------

    const releaseHit = this._castController(ctrl);

    if (
        !releaseHit ||
        releaseHit.object !== pressedBtn
    ) {
        console.log(
            `[UI CANCEL ${i}]`,
            pressedBtn.userData.action,
        );

        return;
    }

    const clickedAction =
        pressedBtn.userData.action;

    console.log(
        `[UI CLICK ${i}] → ${clickedAction}`,
    );

    // ========================================================
    // Trigger RELEASE 才执行真正 action
    // ========================================================

    if (clickedAction === 'start') {

        await this.startAudio();

    } else if (clickedAction === 'resume') {

        await this.startAudio();

    } else if (clickedAction === 'restart') {

        await this.restartAudio();

    } else if (clickedAction === 'exit') {

        await this.exitVR();

    }
});
            ctrl.addEventListener('selectend', () => {
                this.ctrlState[i].selectPressed = false;

                // 松开扬机 = 不再是 pressed。
                //
                // 下一帧 _processControllers 会自动
                // 把它恢复成 hover 或 normal。

                this.ctrlState[i].pressedBtn = null;
            });

            // ----------------------------------------------------
            // GRIP = TELEPORT
            // ----------------------------------------------------

            ctrl.addEventListener('squeezestart', () => {
                console.log(`[Teleport] Grip ${i} pressed`);

                const ts = this.teleportState[i];
                ts.aiming = true;
                ts.targetValid = false;
            });

            ctrl.addEventListener('squeezeend', () => {
                const ts = this.teleportState[i];

                if (ts.aiming && ts.targetValid) {
                    // ------------------------------------------------
                    // IMPORTANT:
                    //
                    // 不改变 dolly.position.y。
                    //
                    // 所以高度补偿完全保留。
                    //
                    // 我们只移动 X / Z。
                    // ------------------------------------------------

                    const headPosition = new THREE.Vector3();
                    this.camera.getWorldPosition(headPosition);

                    // ------------------------------------------------
                    // 不直接写：
                    //
                    // dolly.x = target.x
                    //
                    // 因为 Quest 是 room-scale。
                    //
                    // 如果你现实里已经从 Guardian 中心走开，
                    // headset 本身就有一个 local X/Z offset。
                    //
                    // 所以这里移动的是差值。
                    // ------------------------------------------------

                    this.dolly.position.x += ts.targetPoint.x - headPosition.x;
                    this.dolly.position.z += ts.targetPoint.z - headPosition.z;
                }

                ts.aiming = false;
                this.teleportMarker.visible = false;
            });

            // ----------------------------------------------------
            // CONTROLLER MODEL
            // ----------------------------------------------------

            ctrl.addEventListener('connected', () => {
                const grip = this.renderer.xr.getControllerGrip(i);
                const factory = new XRControllerModelFactory();

                if (grip.children.length === 0) {
                    grip.add(factory.createControllerModel(grip));
                }

                if (!this.ctrlState[i].ray) {
                    this.ctrlState[i].ray = this._buildRayLine(ctrl);
                }
            });

            ctrl.addEventListener('disconnected', () => {
                if (this.ctrlState[i].ray) {
                    ctrl.remove(this.ctrlState[i].ray);
                    this.ctrlState[i].ray = null;
                }
            });

            this.dolly.add(ctrl);
        });

        // ------------------------------------------------------------
        // CONTROLLER GRIPS
        // ------------------------------------------------------------

        this.grips = [this.renderer.xr.getControllerGrip(0), this.renderer.xr.getControllerGrip(1)];

        const factory = new XRControllerModelFactory();

        this.grips.forEach((grip) => {
            grip.add(factory.createControllerModel(grip));
            this.dolly.add(grip);
        });

        this.buildVRPanel();
    }

    // ========================================================================
    // RESIZE
    // ========================================================================

    resize() {
        this.camera.aspect = window.innerWidth / window.innerHeight;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(window.innerWidth, window.innerHeight);
    }

    // ========================================================================
    // RENDER LOOP
    // ========================================================================

    render() {
        // Three Clock 继续 tick，
        // 但是作品时间不再由它决定。

        this.clock.getDelta();
        this.stats.update();

        // ------------------------------------------------------------
        // VR CONTROLLERS
        // ------------------------------------------------------------

        this._processControllers();

        // ------------------------------------------------------------
        // TELEPORT
        // ------------------------------------------------------------

        this.updateTeleport();

        // ------------------------------------------------------------
        // CLOCK MOVEMENT
        //
        // Movement 从 Web Audio master timeline 读取时间。
        // ------------------------------------------------------------

        this.updateClocks();

        // ------------------------------------------------------------
        // LISTENER POSITION
        // ------------------------------------------------------------

        this.updateAudioListener();

        // ------------------------------------------------------------
        // RENDER
        // ------------------------------------------------------------

        this.renderer.render(this.scene, this.camera);
    }
}

export { App };