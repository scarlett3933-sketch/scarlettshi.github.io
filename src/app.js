import * as THREE from 'three';

import { InvisoClient } from './inviso/InvisoClient.js';
import { IS_MICHIGAN as BUILD_IS_MICHIGAN } from './runtime/mode.js';
import { createGrassField } from './GrassField.js';

import { VRButton } from 'three/addons/webxr/VRButton.js';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';
import Stats from 'three/addons/libs/stats.module.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// ============================================================================
// CANVAS POLYFILL
//
// 旧版 Quest Browser 没有 ctx.roundRect()。
// 缺了它 buildVRPanel() 会抛异常 → constructor 中断 → setAnimationLoop 永远不执行
// → 黑屏，而且 console 什么都看不到（immersive 模式里 DOM 不可见）。
// 必须在任何 canvas 绘制之前定义。
// ============================================================================

if (typeof CanvasRenderingContext2D !== 'undefined' &&
    !CanvasRenderingContext2D.prototype.roundRect) {
    CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h, r) {
        const radius = Math.min(Array.isArray(r) ? (r[0] ?? 0) : (r || 0), w / 2, h / 2);

        this.moveTo(x + radius, y);
        this.arcTo(x + w, y, x + w, y + h, radius);
        this.arcTo(x + w, y + h, x, y + h, radius);
        this.arcTo(x, y + h, x, y, radius);
        this.arcTo(x, y, x + w, y, radius);
        this.closePath();

        return this;
    };
}

document.addEventListener('DOMContentLoaded', function () {
    const app = new App();
    window.app = app;
});

// ============================================================================
// RUNTIME MODE
//
// 以前靠不同的 npm command 产生不同的 build，跑起来之后没有任何办法确认自己
// 到底在哪个版本里。现在改成运行时选择：一个 build，进入 VR 之前在加载界面上选。
//
//   STANDALONE — Quest 自己播全部音频（PositionalAudio / HRTF），不连 Inviso。
//   MICHIGAN   — Mac 上的 Inviso 是音频渲染端，Quest 只通过 OSC 发 listener pose，
//                本地一声不出。
//
// 决定优先级：URL 参数 > localStorage 上次选择 > build flag（IS_MICHIGAN）
//
//   ?mode=michigan   / ?mode=standalone   直接锁定，跳过选择界面（装置现场用这个）
//   ?noaudio=1                            完全跳过 21 个 MP3 的下载和 decode（视觉调试）
//   ?spawn=x,y,z                          临时覆盖 Timeless Field 出生点（见 SPAWN_ANCHOR）
//
// build flag 现在只是"默认高亮哪个按钮"，不再决定行为。
// ============================================================================

const RUNTIME_MODE = Object.freeze({
    STANDALONE: 'standalone',
    MICHIGAN: 'michigan',
});

const RUNTIME_MODE_STORAGE_KEY = 'atc.runtimeMode';

const URL_PARAMS = new URLSearchParams(window.location.search);

function readModeFromURL() {
    const raw = URL_PARAMS.get('mode');

    if (!raw) return null;

    const value = raw.trim().toLowerCase();

    if (value === 'michigan' || value === 'm') return RUNTIME_MODE.MICHIGAN;
    if (value === 'standalone' || value === 's') return RUNTIME_MODE.STANDALONE;

    console.warn(`[Mode] Unknown ?mode=${raw} — ignoring.`);

    return null;
}

function readModeFromStorage() {
    try {
        const stored = localStorage.getItem(RUNTIME_MODE_STORAGE_KEY);

        return stored === RUNTIME_MODE.MICHIGAN || stored === RUNTIME_MODE.STANDALONE ? stored : null;
    } catch (_) {
        return null;   // Quest Browser 隐私模式下 localStorage 会抛异常
    }
}

// 非 null = 跳过选择界面，直接锁定。
const URL_FORCED_MODE = readModeFromURL();

// 选择界面默认高亮哪一个。
const DEFAULT_MODE =
    URL_FORCED_MODE ??
    readModeFromStorage() ??
    (BUILD_IS_MICHIGAN ? RUNTIME_MODE.MICHIGAN : RUNTIME_MODE.STANDALONE);

const MODE_LABEL = {
    [RUNTIME_MODE.STANDALONE]: 'STANDALONE',
    [RUNTIME_MODE.MICHIGAN]: 'MICHIGAN',
};

// ============================================================================
// AUDIO / MASTER TIMELINE
//
// 设计逻辑：DAW 已经决定音乐时间轴，所有 Clock_N 音频都从 0:00 同时开始播放。
// WebXR 只负责：1) 每个声音来自哪个 Clock  2) Clock 什么时候开始移动
// 3) Clock 移动时，空间声音跟着移动
// ============================================================================

const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

// public/audio/Clock_1.mp3, Clock_2.mp3 ...
const CLOCK_AUDIO_FOLDER = 'audio';
const CLOCK_AUDIO_EXTENSION = 'mp3';

// 预取音频时假设有几个 Clock stem。
// 之所以要写死：音频文件名是完全可预测的，不需要等 GLB 解析完才知道，
// 这样音频下载可以和 GLB 下载并行，而不是串行排在后面。
// 如果 GLB 里的 Clock 数量和这个不一致，_bindAudioBuffers() 会打 warning。
const CLOCK_COUNT = 18;

// 每个 stem 自己的 gain。1.0 = 保留 DAW bounce 出来的相对音量。
const CLOCK_STEM_GAIN = 1.0;

// 整体总输出音量。如果以后发现整体太响，可以改成 0.6 / 0.5。
const MASTER_GAIN = 1.0;

// decodeAudioData 是 CPU 密集操作，会抢主线程。
// Quest 上并发太多反而拖慢 GLB 解析和首帧渲染，3 比原来的 6 更稳。
const AUDIO_DECODE_CONCURRENCY = 3;

// ============================================================================
// AUDIO PREFETCH SWITCH
//
// 注意这个开关和 RUNTIME_MODE 是两件事：
//
//   预取（下载）必须在选模式之前就开始，否则就白白放弃了和 GLB 的并行。
//   所以「要不要下载」只能靠启动时就已知的信息决定，「要不要 decode」才由模式决定。
//
// 下载便宜（局域网 / HTTP2 多路复用），decode 贵（抢主线程 + 解出来的 PCM 常驻内存）。
// 所以默认永远下载，Michigan 模式下把 ArrayBuffer 直接丢掉让 GC 回收，绝不 decode。
//
// 两种情况下连下载都跳过，因为启动时就已经能确定不需要：
//   ?noaudio=1          纯视觉调试
//   ?mode=michigan      URL 已经锁死是装置模式
// ============================================================================

const DEBUG_SKIP_AUDIO = false;   // 临时用 ?noaudio=1 更方便，不用改代码重新 build

const AUDIO_PREFETCH_ENABLED = !(
    DEBUG_SKIP_AUDIO ||
    URL_PARAMS.has('noaudio') ||
    URL_FORCED_MODE === RUNTIME_MODE.MICHIGAN
);

// ============================================================================
// FIXED DRONE SOURCES
//
// Drone = 相对参与者固定偏移的声音，不参与 Clock 的轨道运动。
//
// 下面这些坐标是**初始世界坐标**，用来在体验开始时反算出每个 Drone
// 相对于听者的偏移量（见 _captureDroneOffsets）。之后每帧的实际位置是
// listener + offset —— 跟随参与者的平移，但不跟随头的旋转。
// ============================================================================

const DRONE_CONFIG = [
    { name: 'Drone_1', file: 'Drone_1.mp3', position: new THREE.Vector3(0, 2.5, -6), gain: 0.35, loop: true },  // 左前方
    { name: 'Drone_2', file: 'Drone_2.mp3', position: new THREE.Vector3(7, 4, 5), gain: 0.35, loop: true },     // 右后方
    { name: 'Drone_3', file: 'Drone_3.mp3', position: new THREE.Vector3(0, 8, -10), gain: 0.30, loop: true },   // 前方高处
];

// ============================================================================
// MOVEMENT TIMELINE
//
// 这里完全不控制 audio start，所有 audio 永远都是从 0:00 同时开始。
// 这里的 start 只表示"这个 Clock 在作品第几秒开始运动"，单位 = 秒。
// 例如 1:13.420 就是 60 + 13.420 = 73.420 秒。
// ============================================================================

const CLOCK_MOVEMENT = {
    // 以后正式时间写在这里，例如：
    // Clock_1: { start: 35.20, duration: 6 },
};

// ============================================================================
// TIMELESS FIELD 世界参数
//
// Spencer 的 Unreal 参考图确认了形状意图：这是一个**巨大的 donut**，
// 参与者站在它下方那一段外缘（bottom swoop）的表面上。
// 因为整体极大，局部看到的应该是一片很宽、很缓的弧面 ——
// 而不是一个扣在头上的碗。
//
// 所以两件事是明确的：
//
//   1. 绝对不要压 Y。donut 的纵横比是设计，不是导出副产物。
//      （之前试过 FLATTEN_Y，判断错了，已删除。）
//
//   2. 尺寸决定局部曲率。同样的几何体，放得越大，
//      站在上面看到的弧面越平缓。60 / 120 都太小 ——
//      在那个尺度上人是"掉进碗里"，不是"站在巨物表面"。
//
// 重要：实测证明放大**不会**让脚下变平。
// 出生点附近 1 m 处坡度 37.1°、5 m 处 38.1° —— 几乎相同，
// 说明那是恒定斜面而不是曲率，而角度是尺度不变量。
// 300 放大到 600 之后脚下依然是 37°。
//
// 放大只影响远景（50 m 处的 49° 会降下来）。
// 要站在平地上只能换 SPAWN_ANCHOR，和这个数无关。
//
// 草改成局部撒点之后，这个数也不再影响草的开销。
// 所以它现在纯粹是创作判断：想要多大的世界。
// ============================================================================

const TIMELESS_FIELD_SIZE = 300;

// ============================================================================
// SPAWN ANCHOR — 参与者站在 donut 的哪里
//
// 这是这一版最重要的改动。
//
// 之前用的是 findSpawnPoint()：从 bounding box 中心开始向外螺旋，
// 找第一块 normal.y >= 0.85 的地面。这个策略对一个 donut 是**结构性错误**的 ——
// donut 的 bbox 中心是那个洞，那里根本没有几何体。射线打空，然后一路往外飘，
// 最后落在哪儿完全是几何体的偶然形状决定的，和 Spencer 的意图无关。
//
// 现在改成艺术家指定的锚点。坐标是**归一化**的（占半径的比例，−1..1），
// 不是世界单位 —— 这样以后改 TIMELESS_FIELD_SIZE 时锚点不会跟着跑掉。
//
//   x / z   水平位置。0,0 = donut 中心（洞），±1 = 外缘。
//           bottom swoop 在外缘，所以其中一个分量应该接近 ±0.8。
//   y       期望高度。一条竖直射线在 donut 上可能打中上下两层，
//           用这个值挑最接近的那一层。
//
// 注意：锚点始终是 **Field 自己的局部坐标**。
// 解析完之后整个 timelessFieldRoot 会被平移，让这个锚点对齐到 Tower 的
// 站立位置（见 _alignTimelessFieldToTowerSpawn）—— 所以锚点数值不受
// 那次平移影响，改 Collapse 逻辑也不需要重新取锚点。
//
// 怎么找到正确数值（不用回桌面看 console）：
//
//   1. 进 Timeless Field，用 grip teleport 走到你觉得对的位置
//   2. 扣扳机呼出 panel
//   3. 点 "◎ Set Spawn"
//   4. panel 上会直接显示归一化坐标，抄下来填到这里
//
// 也可以用 ?spawn=x,y,z 临时覆盖，不用重新 build。
// ============================================================================

const SPAWN_ANCHOR = { x: -0.380, y: 0.011, z: 0.258 };

function readSpawnFromURL() {
    const raw = URL_PARAMS.get('spawn');

    if (!raw) return null;

    const parts = raw.split(',').map((v) => Number(v.trim()));

    if (parts.length !== 3 || parts.some((v) => !Number.isFinite(v))) {
        console.warn(`[Spawn] 无法解析 ?spawn=${raw} — 忽略。格式是 ?spawn=x,y,z`);
        return null;
    }

    return { x: parts[0], y: parts[1], z: parts[2] };
}

const URL_SPAWN_ANCHOR = readSpawnFromURL();

const ACTIVE_SPAWN_ANCHOR = URL_SPAWN_ANCHOR ?? SPAWN_ANCHOR;

// ============================================================================
// GRASS
//
// 草是这个场景里唯一的尺度参照物 —— 没有别的东西告诉眼睛"这有多大"。
// Spencer 参考图里的草比相机还高、密到看不见地面，那正是"巨大"的来源。
//
// 撒点是**局部**的：只在出生点周围 radius 米内撒，远处交给雾。
// 原因是表面积按尺寸的平方增长，全表面撒点在 65 米以上就必然被截断
// （600 米的 donut 铺满要 120 万簇 = 1400 万三角形，Quest 预算是 30 万）。
// 局部撒点之后草的开销和 donut 大小完全脱钩，Spencer 想做多大做多大。
//
// radius / falloffStart / density 三个数是一起定的，
// 改任何一个都要回头看 console 有没有报 cappedByMaxInstances。
// ============================================================================

const GRASS_OPTIONS = {
    radius: 70,            // 撒草半径（米）。雾在 0.004 时可见度约 250 m，边界落在雾里
    falloffStart: 0.55,    // 前 45% 满密度，之后平滑降到 0，没有硬边
    density: 2.2,          // 满密度区每平方米 2.2 簇 → 约 13,400 簇
    maxInstances: 24000,   // 上限 → 每簇 6 三角形时约 96k 三角形
    scale: 1.2,            // 原始草簇高 0.85 → 实际约 1.7 米，和 Spencer 参考一致
    scaleVariance: 0.35,
    minNormalY: 0.35,      // spindle torus 大面积是 37° 斜面，阈值高了会大片秃
    alignToNormal: 0.55,
    sink: 0.05,
};

// ============================================================================
// COLLAPSE
//
// 整段 Collapse 是**一次定时动画**，由 render loop 驱动，时间来自
// master timeline（AudioContext.currentTime）。没有 setTimeout，
// 没有第二个 animation loop，暂停时它跟着音频一起冻结。
//
// 时间线（秒，相对 Collapse 开始，COLLAPSE_DURATION = 12 秒时）：
//
//    0.00 –  1.20   Tower 轻微震动，还没有东西离开原位
//    0.00 –  4.00   星空亮度 0 → 1，身边那盏灯一起亮起来（场景渐入）
//    0.72 –  7.20   Clock 音频从「塔内轨迹」插值到「以人为中心的轨道」
//    1.20 –  4.20   构件陆续松脱（高处先松），不是同时启动
//    1.20 – 12.00   松脱的构件持续向外漂远并轻微自转，最终 26–52 米
//                   每片走完自己四分之一行程后开始淡出，边飞边淡，
//                   在自己那段飞行的终点归零 —— 不是全体在最后一起淡
//    1.68 –  3.84   Clock 视觉开始软化（Y 压扁、XZ 微胀）
//    3.84 –  7.44   继续下沉、压扁、透明度降到 0
//    7.44           Clock 视觉 visible = false
//   12.00           state → TIMELESS_FIELD
// ============================================================================

const COLLAPSE_DURATION = 12.0;

// ------------------------------------------------------------
// 所有分段时间都写成 COLLAPSE_DURATION 的**比例**，
// 所以只改上面那一个数就能整体加快或放慢，段与段的关系不会走样。
// ------------------------------------------------------------

const COLLAPSE_SHAKE_END_F = 0.10;          //  1.20s  震动结束
const COLLAPSE_STAGGER_SPREAD_F = 0.25;     //  3.00s  构件陆续松脱的时间跨度

const COLLAPSE_AUDIO_BLEND_START_F = 0.06;  //  0.72s
const COLLAPSE_AUDIO_BLEND_END_F = 0.60;    //  7.20s

const COLLAPSE_MELT_SOFTEN_START_F = 0.14;  //  1.68s
const COLLAPSE_MELT_SOFTEN_END_F = 0.32;    //  3.84s
const COLLAPSE_MELT_SINK_END_F = 0.62;      //  7.44s

// 每一片构件的淡出**从它自己起飞后走完这个比例的行程时开始**，
// 到它自己那段飞行结束时归零。
//
// 这里是上一版最大的问题：之前是 141 片共用**一条**全局淡出曲线，
// 都挤在最后 30% 一起淡。那时候它们已经飞远、在画面里很小了，
// 三秒多的淡出摊在一堆小东西上，眼睛读到的就是"啪一下没了"。
//
// 改成每片各自淡：先起飞的先开始淡，边飞边淡，各自在终点归零。
// 任何时刻画面里都同时存在"刚松脱的实心片"和"远处半透明的片"，
// 这才是渐出。
const COLLAPSE_PIECE_FADE_START_F = 0.25;

// monolith 兜底路径仍然用全局淡出（只有一块东西，没有"各自"可言）。
const COLLAPSE_TOWER_FADE_START_F = 0.55;

const COLLAPSE_SHAKE_END = COLLAPSE_DURATION * COLLAPSE_SHAKE_END_F;
const COLLAPSE_STAGGER_SPREAD = COLLAPSE_DURATION * COLLAPSE_STAGGER_SPREAD_F;

const COLLAPSE_AUDIO_BLEND_START = COLLAPSE_DURATION * COLLAPSE_AUDIO_BLEND_START_F;
const COLLAPSE_AUDIO_BLEND_END = COLLAPSE_DURATION * COLLAPSE_AUDIO_BLEND_END_F;

const COLLAPSE_MELT_SOFTEN_START = COLLAPSE_DURATION * COLLAPSE_MELT_SOFTEN_START_F;
const COLLAPSE_MELT_SOFTEN_END = COLLAPSE_DURATION * COLLAPSE_MELT_SOFTEN_END_F;
const COLLAPSE_MELT_SINK_END = COLLAPSE_DURATION * COLLAPSE_MELT_SINK_END_F;

const COLLAPSE_TOWER_FADE_START = COLLAPSE_DURATION * COLLAPSE_TOWER_FADE_START_F;

// ============================================================================
// SCENE CROSSFADE
//
// 星云天空是 scene.background，没法直接和 Tower 的底色做交叉淡入 ——
// background 要么是颜色要么是贴图，不能同时。
//
// 但 Three 有 scene.backgroundIntensity：贴图背景的整体亮度。
// 设成 0 就是纯黑，Tower 的底色 0x101820 本来也接近纯黑，
// 所以从"塔的底色"跳到"亮度 0 的星空"肉眼几乎看不出来，
// 然后把亮度拉到 1 就是星空慢慢浮出来。
//
// 不需要额外的天空球，不多一个 draw call，也不碰 loadSky() 的任何逻辑。
// 身边那盏 fieldLamp 用同一条曲线一起亮起来，草地跟着一起浮现。
//
// 注意 backgroundIntensity 对**颜色**背景无效（Three 只在贴图/环境贴图
// 分支里用它），所以星空还没下载完的时候这段是安全的 no-op。
// ============================================================================

const COLLAPSE_REVEAL_DURATION = 4.0;

// fieldLamp 的目标强度。淡入期间按比例缩放，Restart 时还原到这个值。
const FIELD_LAMP_INTENSITY = 20.0;

// 单个构件的震动幅度（世界单位）。再大就变成"地震"而不是"松动"。
const COLLAPSE_SHAKE_AMPLITUDE = 0.014;

// ------------------------------------------------------------
// 构件的漂移速度范围（米/秒）和自转速度范围（弧度/秒）。
//
// 这里有两个相反的失败模式，中间那条线是靠**起步速度**和**总行程**
// 分开控制的：
//
//   起步太快        → 读成"被炸开"
//   总行程太短      → 东西留在原地淡掉，读成"凭空消失"
//
// 所以用 ease(t) = t²/(t+τ)：τ 决定起步有多黏（前一秒实际速度只有
// 标称值的一半不到），而标称速度决定十秒之后跑多远。
//
// 现在的数：最先松脱的构件整段走 20–38 米，最后松脱的也有 13–27 米。
// 塔本身只有 14 米，所以它们确实会离开视野，而不是在眼前原地变淡。
// 淡出从 8.4 秒才开始，那时候最近的一批已经在十几米外了。
// ------------------------------------------------------------

const COLLAPSE_DRIFT_SPEED_MIN = 3.0;
const COLLAPSE_DRIFT_SPEED_MAX = 6.0;

const COLLAPSE_SPIN_MAX = 0.25;

// 漂移的缓入时间常数（秒）。越大起步越慢、越黏。
const COLLAPSE_DRIFT_EASE_TAU = 2.5;

// Tower 构件的数量上限。GLB 里的 mesh 如果比这个多，就往上找一层父节点
// 分组，直到组数落到上限以内 —— 否则几千个独立飞行体在 Quest 上必炸。
//
// 这个 GLB 的实际情况（已核对 Thousand Clocks Demo.glb）：
//   钟拆出去之后，建筑一共 141 个 mesh primitive、4,556 三角形，
//   分属 Spencer 命名好的 17 个构件：Floor + 8 面墙 + 8 块屋顶。
//
// 141 ≤ 200，所以默认走**逐 mesh** 飞散 —— 墙会一片一片散开，
// 而不是四面墙整块平移出去。
//
// 想改成整块的话把这个数调到 20：141 > 20 会触发向上分组，
// 而第 4 层正好就是那 17 个命名构件。这是纯粹的观感选择，
// 两种都不影响 draw call（Three 本来就是逐 mesh 画的）。
const TOWER_MAX_PIECES = 200;

// 少于这个数就认为"塔基本上是一整块"，走 monolith 兜底路径
// （整体下沉 + 淡出），而不是假装能把它炸成有意义的建筑碎块。
const TOWER_MONOLITH_THRESHOLD = 4;

// mesh 太多时不再 clone 材质做淡出（clone 几千个材质本身就是一次卡顿）。
const TOWER_MAX_FADE_MESHES = 1200;

// ============================================================================
// CLOCK AUDIO ORBIT
//
// Collapse 之后 18 个 Clock 的声音继续存在，但视觉已经消失。
// 轨道中心 = 参与者**当前位置**（平移），不跟随头部旋转 ——
// 转头时声源方向必须自然改变，那才说明它是真实空间声源。
//
// 半径沿用塔内的三层分组：1–6 近 / 7–12 中 / 13–18 远。
// 高度改成**相对听者头部**的偏移：塔里的绝对高度是 2.5 / 5 / 8，
// 而头大约在 2.9（FLOOR_OFFSET 1.30 + 眼高 1.6），所以相对值是 −0.3 / +2.1 / +5.1。
// 分层关系保持不变，只是把参照系换成了人。
// ============================================================================

const CLOCK_ORBIT_RADII = [5, 10, 18];
const CLOCK_ORBIT_HEIGHTS = [-0.3, 2.0, 5.0];
const CLOCK_ORBIT_SPEED = 0.8;

// ============================================================================
// LIGHTING ENDPOINTS
//
// Collapse 期间灯光要在这两组之间插值，所以颜色预先建好 ——
// 别在 render loop 里 new THREE.Color()。
//
// Tower：室内、有环境反弹、白光。
// Field：巨大 donut 的表面，环境光来自星云（偏蓝紫），非常暗 ——
//        真正的光源是挂在 dolly 上的 fieldLamp。
// ============================================================================

const TOWER_HEMI_SKY = new THREE.Color(0xffffff);
const TOWER_HEMI_GROUND = new THREE.Color(0x202020);
const TOWER_DIR_COLOR = new THREE.Color(0xffffff);

const FIELD_HEMI_SKY = new THREE.Color(0x4a5a8c);
const FIELD_HEMI_GROUND = new THREE.Color(0x0a1410);
const FIELD_DIR_COLOR = new THREE.Color(0x8fa4d0);

// ============================================================================
// WORLD-SPACE COLLAPSE BUTTON
//
// 不放在 pause menu 里 —— demo 时需要一个"看得见、走过去点"的实体按钮。
// 位置相对 Tower 出生点（世界原点）。
// ============================================================================

const COLLAPSE_BUTTON_DISTANCE = 1.7;    // 出生点正前方多少米
const COLLAPSE_BUTTON_EYE_OFFSET = -0.25; // 相对眼高的垂直偏移，略低于视线

// ============================================================================
// LOADING UI
//
// 两个阶段：
//   PHASE 1  GLB 加载 + 音频下载（并行）
//            ↓
//   MODE PICKER  选 Standalone / Michigan
//            ↓
//   PHASE 2  Standalone 才 decode 音频；Michigan 直接结束
//
// 加权进度：每个 task 有固定 weight，所以某个 task 内部数量变化不会让总百分比倒退。
// 进入 PHASE 2 时调用 resetTasks()，进度条从 0 重新走一遍。
//
// 只在进入 VR 之前使用 DOM overlay —— immersive 模式里 DOM 不可见，
// 但这个 overlay 的整个生命周期都在按下 ENTER VR 之前，所以 DOM 是正确选择。
// ============================================================================

class LoadingUI {
    constructor() {
        this.tasks = new Map();
        this.hidden = false;

        const root = document.createElement('div');

        root.style.cssText = [
            'position:fixed', 'inset:0', 'z-index:99999',
            'display:flex', 'flex-direction:column',
            'align-items:center', 'justify-content:center',
            'background:#080d16', 'color:#e6edf7',
            'font-family:ui-sans-serif,-apple-system,"Helvetica Neue",sans-serif',
            'transition:opacity 0.6s ease',
        ].join(';');

        const title = document.createElement('div');
        title.textContent = 'A THOUSAND CLOCKS';
        title.style.cssText = 'font-size:20px;letter-spacing:0.22em;opacity:0.6;margin-bottom:30px';

        // ------------------------------------------------------------
        // PROGRESS PANE
        // ------------------------------------------------------------

        const progressPane = document.createElement('div');
        progressPane.style.cssText = 'display:flex;flex-direction:column;align-items:center';

        const barOuter = document.createElement('div');
        barOuter.style.cssText =
            'width:min(560px,74vw);height:6px;border-radius:3px;overflow:hidden;background:rgba(255,255,255,0.12)';

        this.bar = document.createElement('div');
        this.bar.style.cssText = 'width:0%;height:100%;background:#00ff88;transition:width 0.15s linear';
        barOuter.appendChild(this.bar);

        this.percent = document.createElement('div');
        this.percent.textContent = '0%';
        this.percent.style.cssText = 'margin-top:16px;font-size:30px;font-variant-numeric:tabular-nums';

        this.status = document.createElement('div');
        this.status.style.cssText = 'margin-top:8px;font-size:13px;opacity:0.55;height:18px';

        this.list = document.createElement('div');
        this.list.style.cssText =
            'margin-top:28px;width:min(560px,74vw);font-size:12px;line-height:2;opacity:0.85';

        progressPane.append(barOuter, this.percent, this.status, this.list);

        // ------------------------------------------------------------
        // MODE PICKER PANE
        // ------------------------------------------------------------

        const pickerPane = document.createElement('div');
        pickerPane.style.cssText = 'display:none;flex-direction:column;align-items:center';

        const pickerTitle = document.createElement('div');
        pickerTitle.textContent = 'SELECT RUNTIME MODE';
        pickerTitle.style.cssText = 'font-size:13px;letter-spacing:0.2em;opacity:0.45;margin-bottom:22px';

        const pickerRow = document.createElement('div');
        pickerRow.style.cssText =
            'display:flex;gap:18px;flex-wrap:wrap;justify-content:center;width:min(720px,88vw)';

        this.standaloneBtn = this._makeModeButton(
            'STANDALONE',
            'Quest plays all 21 stems locally with HRTF spatialization. Inviso bridge off.',
        );

        this.michiganBtn = this._makeModeButton(
            'MICHIGAN',
            'Inviso on the Mac renders audio. Quest sends listener pose over OSC and stays silent.',
        );

        pickerRow.append(this.standaloneBtn, this.michiganBtn);

        this.pickerNote = document.createElement('div');
        this.pickerNote.style.cssText = 'margin-top:24px;font-size:12px;opacity:0.4;text-align:center;line-height:1.7';

        pickerPane.append(pickerTitle, pickerRow, this.pickerNote);

        root.append(title, progressPane, pickerPane);
        document.body.appendChild(root);

        this.root = root;
        this.progressPane = progressPane;
        this.pickerPane = pickerPane;
    }

    _makeModeButton(label, description) {
        const btn = document.createElement('button');

        btn.style.cssText = [
            'flex:1 1 300px', 'min-width:260px', 'max-width:340px',
            'padding:22px 20px', 'border-radius:14px', 'cursor:pointer',
            'background:rgba(255,255,255,0.04)',
            'border:2px solid rgba(255,255,255,0.16)',
            'color:#e6edf7', 'text-align:left',
            'font-family:inherit',
            'transition:border-color 0.15s ease, background 0.15s ease',
        ].join(';');

        const head = document.createElement('div');
        head.textContent = label;
        head.style.cssText = 'font-size:19px;letter-spacing:0.12em;font-weight:600';

        const body = document.createElement('div');
        body.textContent = description;
        body.style.cssText = 'margin-top:10px;font-size:12.5px;line-height:1.6;opacity:0.6';

        btn.append(head, body);

        // Quest Browser 的 2D 模式里没有真正的 hover，但桌面调试时有用。
        btn.addEventListener('pointerenter', () => {
            btn.style.background = 'rgba(0,255,136,0.10)';
        });

        btn.addEventListener('pointerleave', () => {
            btn.style.background = 'rgba(255,255,255,0.04)';
        });

        return btn;
    }

    // ------------------------------------------------------------
    // MODE PICKER
    //
    // 返回一个 Promise，用户点击之后 resolve 成对应的 RUNTIME_MODE。
    // 点击本身同时也是解锁 AudioContext 需要的 user gesture。
    // ------------------------------------------------------------

    chooseMode(defaultMode, noteText) {
        return new Promise((resolve) => {
            this.progressPane.style.display = 'none';
            this.pickerPane.style.display = 'flex';

            this.pickerNote.textContent = noteText || '';

            // 默认那一个加绿边，但两个都可以点。
            const defaultBtn =
                defaultMode === RUNTIME_MODE.MICHIGAN ? this.michiganBtn : this.standaloneBtn;

            defaultBtn.style.borderColor = 'rgba(0,255,136,0.65)';

            const pick = (mode) => {
                this.standaloneBtn.onclick = null;
                this.michiganBtn.onclick = null;

                this.pickerPane.style.display = 'none';
                this.progressPane.style.display = 'flex';

                resolve(mode);
            };

            this.standaloneBtn.onclick = () => pick(RUNTIME_MODE.STANDALONE);
            this.michiganBtn.onclick = () => pick(RUNTIME_MODE.MICHIGAN);
        });
    }

    // ------------------------------------------------------------
    // TASKS
    // ------------------------------------------------------------

    addTask(id, label, weight = 1) {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;justify-content:space-between;gap:20px';

        const left = document.createElement('span');
        left.textContent = label;

        const right = document.createElement('span');
        right.textContent = '0%';
        right.style.cssText = 'opacity:0.6;font-variant-numeric:tabular-nums';

        row.append(left, right);
        this.list.appendChild(row);

        this.tasks.set(id, { weight, progress: 0, failed: false, left, right });
        this._render();
    }

    // PHASE 2 开始时清空 PHASE 1 的 task，让进度条从 0 重新走。
    resetTasks() {
        this.tasks.clear();
        this.list.replaceChildren();

        this.bar.style.width = '0%';
        this.percent.textContent = '0%';
    }

    setLabel(id, label) {
        const task = this.tasks.get(id);
        if (task) task.left.textContent = label;
    }

    setProgress(id, p, detail) {
        const task = this.tasks.get(id);
        if (!task || task.failed) return;

        task.progress = Math.max(0, Math.min(1, p));
        task.right.textContent = detail ?? `${Math.round(task.progress * 100)}%`;

        this._render();
    }

    skip(id, note = 'skipped') {
        const task = this.tasks.get(id);
        if (!task) return;

        task.progress = 1;
        task.right.textContent = note;
        task.right.style.opacity = '0.35';
        task.left.style.opacity = '0.35';

        this._render();
    }

    fail(id, message) {
        const task = this.tasks.get(id);
        if (!task) return;

        task.failed = true;
        task.progress = 1;              // 失败也算「结束」，否则总进度永远卡住
        task.right.textContent = 'FAILED';
        task.right.style.color = '#ff6b6b';
        task.left.style.color = '#ff6b6b';

        if (message) this.setStatus(message);

        this._render();
    }

    setStatus(text) {
        this.status.textContent = text || '';
    }

    isComplete() {
        if (this.tasks.size === 0) return false;

        return [...this.tasks.values()].every((task) => task.progress >= 1);
    }

    hasFailures() {
        return [...this.tasks.values()].some((task) => task.failed);
    }

    _render() {
        let total = 0;
        let done = 0;

        this.tasks.forEach((task) => {
            total += task.weight;
            done += task.weight * task.progress;
        });

        const ratio = total > 0 ? done / total : 0;

        this.bar.style.width = `${(ratio * 100).toFixed(1)}%`;
        this.percent.textContent = `${Math.floor(ratio * 100)}%`;
    }

    showFatalError(message = 'Something failed to load.') {
        // Stay on loading screen.
        this.hidden = false;

        // Never show mode picker after a fatal failure.
        this.pickerPane.style.display = 'none';
        this.progressPane.style.display = 'flex';

        // Make failure visually obvious.
        this.bar.style.background = '#ff5c5c';
        this.percent.textContent = 'FAILED';

        this.setStatus(message);

        // Avoid creating multiple reload buttons.
        if (this.reloadButton) return;

        const button = document.createElement('button');

        button.textContent = 'Reload & Try Again';

        button.style.cssText = [
            'margin-top:24px',
            'padding:12px 22px',
            'border-radius:8px',
            'border:1px solid rgba(255,255,255,0.25)',
            'background:#ffffff',
            'color:#111827',
            'font-size:14px',
            'font-weight:600',
            'cursor:pointer',
        ].join(';');

        button.addEventListener('click', () => {
            window.location.reload();
        });

        this.progressPane.appendChild(button);
        this.reloadButton = button;
    }

    hide() {
        if (this.hidden) return;

        this.hidden = true;
        this.root.style.opacity = '0';
        this.root.style.pointerEvents = 'none';

        setTimeout(() => this.root.remove(), 700);
    }
}

// ============================================================================
// MODE BADGE
//
// 加载界面消失以后，桌面端右下角常驻一个小标签显示当前模式。
// 头显里看不到 DOM，所以 VR panel 的标题里也会写一份（见 _drawPanelBackground）。
// ============================================================================

function showModeBadge(mode) {
    const badge = document.createElement('div');

    badge.textContent = MODE_LABEL[mode] ?? String(mode).toUpperCase();

    badge.style.cssText = [
        'position:fixed', 'right:10px', 'bottom:10px', 'z-index:20',
        'padding:5px 11px', 'border-radius:6px',
        'font:600 11px/1 ui-monospace,monospace', 'letter-spacing:0.14em',
        'pointer-events:none',
        mode === RUNTIME_MODE.MICHIGAN
            ? 'background:rgba(204,153,255,0.16);color:#cc99ff;border:1px solid rgba(204,153,255,0.4)'
            : 'background:rgba(0,255,136,0.14);color:#00ff88;border:1px solid rgba(0,255,136,0.4)',
    ].join(';');

    document.body.appendChild(badge);
}

// GLTFLoader 的 xhr.total 在 gzip / chunked 传输时可能是 0，
// 这种情况用已下载字节数做一个渐近估算，至少让进度条有可见的移动。
function estimateProgress(xhr) {
    if (xhr.total) {
        return { p: xhr.loaded / xhr.total, text: null };
    }

    const mb = xhr.loaded / 1048576;

    return { p: 1 - Math.exp(-mb / 12), text: `${mb.toFixed(1)} MB` };
}

// ============================================================================
// AUDIO ASSET PIPELINE — DOWNLOAD 和 DECODE 彻底分开
//
// 以前这两步是绑在一起的一个函数，所以"要不要下载"和"要不要 decode"必须
// 同时决定，而模式选择要等到加载完成之后才发生。拆开之后：
//
//   PHASE 1  下载全部 → ArrayBuffer 先放着（压缩态，21 个文件大约一百多 MB）
//   PHASE 2  选完模式，Standalone 才 decode
//
// decodeAudioData 会 detach 掉传进去的 ArrayBuffer，所以 decode 之后原始数据
// 会自动释放，不需要手动清。Michigan 模式下把整个 Map 置 null 让 GC 收走。
// ============================================================================

async function downloadAudioEntries(entries, { concurrency = Infinity, onProgress } = {}) {
    const buffers = new Map();
    const errors = [];

    let done = 0;
    let bytes = 0;

    const queue = [...entries];

    const worker = async () => {
        while (queue.length > 0) {
            const entry = queue.shift();
            if (!entry) break;

            try {
                const response = await fetch(entry.url);

                if (!response.ok) {
                    throw new Error(`${entry.key}: ${response.status} ${response.statusText}`);
                }

                const arrayBuffer = await response.arrayBuffer();

                bytes += arrayBuffer.byteLength;
                buffers.set(entry.key, arrayBuffer);
            } catch (error) {
                errors.push(error);
                console.error('[Audio] download failed:', error);
            }

            done++;
            onProgress?.(done, entries.length);
        }
    };

    // 默认全部并发发出去。GitHub Pages 是 HTTP/2，多路复用，不会被 6 连接上限卡住。
    const workerCount = Math.max(1, Math.min(concurrency, entries.length));

    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    return { buffers, errors, bytes };
}

async function decodeAudioEntries(rawBuffers, { concurrency = 3, onProgress } = {}) {
    const results = new Map();
    const errors = [];

    let done = 0;

    const queue = [...rawBuffers.entries()];
    const total = queue.length;

    const worker = async () => {
        while (queue.length > 0) {
            const item = queue.shift();
            if (!item) break;

            const [key, arrayBuffer] = item;

            try {
                results.set(key, await audioCtx.decodeAudioData(arrayBuffer));
            } catch (error) {
                errors.push(new Error(`${key}: decode failed — ${error?.message ?? error}`));
                console.error('[Audio] decode failed:', key, error);
            }

            done++;
            onProgress?.(done, total);
        }
    };

    const workerCount = Math.max(1, Math.min(concurrency, total));

    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    return { results, errors };
}

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

    // 如果我们已经给它写了正式时间，就使用正式时间。
    if (custom) {
        return { start: custom.start, duration: custom.duration ?? 6 };
    }

    // ------------------------------------------------------------
    // 临时测试 movement：在正式 movement 时间填写之前，让我们先看到钟确实在动。
    // 正式做作品时会把这个 fallback 删除。
    // ------------------------------------------------------------

    // Demo: 所有 Clock 在作品第 5 秒同时开始展开，5–15 秒完成 spatial expansion
    return { start: 5, duration: 10 };
}

// ============================================================================
// DETERMINISTIC RANDOM
//
// Collapse 的飞散方向 / 速度 / 角速度必须**只生成一次**。
// 每帧重新 random 会让构件原地抖动而不是飞出去，而且每次录制都不一样，
// 没法比较两条 take。xorshift32，和 GrassField.js 里用的是同一个。
// ============================================================================

function makeRandom(seed) {
    let state = (seed >>> 0) || 1;

    return () => {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        state >>>= 0;

        return state / 4294967296;
    };
}

// ============================================================================
// MATERIAL FADE HELPERS
//
// 关键安全问题：GLB 里的 mesh 经常共用同一个 material 实例。
// 直接在上面改 opacity 会把所有用到它的东西一起淡出 —— 包括还不该消失的部分。
//
// 所以第一次 Collapse 之前把材质 clone 一份，之后这个 mesh 永远用自己的副本。
// clone 只做一次（幂等），Restart 时只是把 opacity / transparent 还原，
// 不会反复 clone 造成泄漏。
// ============================================================================

function prepareFadeMaterials(root) {
    const entries = [];

    root.traverse((object) => {
        if (!object.isMesh && !object.isInstancedMesh) return;
        if (object.userData.__fadeReady) return;

        const original = object.material;

        const cloned = Array.isArray(original)
            ? original.map((material) => material.clone())
            : original.clone();

        object.material = cloned;
        object.userData.__fadeReady = true;

        const list = Array.isArray(cloned) ? cloned : [cloned];

        entries.push({
            mesh: object,
            materials: list,
            baseOpacity: list.map((material) => material.opacity),
            baseTransparent: list.map((material) => material.transparent),
            baseDepthWrite: list.map((material) => material.depthWrite),
        });
    });

    return entries;
}

function setFadeAlpha(entries, alpha) {
    const a = Math.max(0, Math.min(1, alpha));

    entries.forEach((entry) => {
        entry.materials.forEach((material, i) => {
            if (a >= 1) {
                material.opacity = entry.baseOpacity[i];
                material.transparent = entry.baseTransparent[i];
                material.depthWrite = entry.baseDepthWrite[i];
                return;
            }

            material.transparent = true;
            material.opacity = entry.baseOpacity[i] * a;

            // 半透明的建筑构件如果还写深度，互相之间会出现明显的黑边。
            material.depthWrite = false;
        });
    });
}

function restoreFadeMaterials(entries) {
    setFadeAlpha(entries, 1);
}

// ============================================================================
// SPATIAL AUDIO HELPERS
// ============================================================================

function createSpatialPanner() {
    const panner = audioCtx.createPanner();

    panner.panningModel = 'HRTF';           // HRTF = headphone binaural spatialization
    panner.distanceModel = 'inverse';
    panner.refDistance = 4;                 // 参考距离
    panner.maxDistance = 40;                // 超过这个距离基本不继续计算明显距离变化
    panner.rolloffFactor = 0.5;             // 距离衰减程度

    // 360° 发声：Clock 是 omnidirectional point source。
    panner.coneInnerAngle = 360;
    panner.coneOuterAngle = 360;
    panner.coneOuterGain = 0;

    return panner;
}

// 每一个 Clock 的 signal flow: Audio File → Gain → Panner → Master Gain → Headphones
function createClockSpatialChain(outputNode, initialPosition) {
    const gain = audioCtx.createGain();
    const panner = createSpatialPanner();

    gain.gain.value = CLOCK_STEM_GAIN;
    gain.connect(panner);
    panner.connect(outputNode);

    setImmediatePannerPos(panner, initialPosition);

    return { gain, panner, source: null };
}

// 固定 Drone 的 signal flow 和 Clock 一样使用 HRTF，
// 不同之处：Drone 不参与轨道运动，只跟随参与者的平移。
function createDroneSpatialChain(outputNode, initialPosition, gainValue) {
    const gain = audioCtx.createGain();
    const panner = createSpatialPanner();

    gain.gain.value = gainValue;
    gain.connect(panner);
    panner.connect(outputNode);

    setImmediatePannerPos(panner, initialPosition);

    return { gain, panner, source: null };
}

// 把 Web Audio Panner 放到 Three.js 的世界坐标。
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

function makeButtonMesh(label, r, g, b, w = 0.28, h = 0.095) {
    const CW = 512;
    const CH = 160;

    const canvas = document.createElement('canvas');
    canvas.width = CW;
    canvas.height = CH;

    const ctx = canvas.getContext('2d');

    // 只画一次按钮的 NORMAL / 最亮状态，hover 和 pressed 不再重新画 canvas
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
    ctx.font = 'bold 60px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, CW / 2, CH / 2);

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;

    const material = new THREE.MeshBasicMaterial({
        map: tex,
        color: 0xffffff,          // NORMAL 状态保持 texture 原本的亮度
        transparent: true,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,        // UI 不受 tone mapping 影响
    });

    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), material);

    // Panel background = 100, Button = 101 → 保证按钮永远画在 panel 背景上面
    mesh.renderOrder = 101;

    mesh.userData = {
        isBtn: true,
        visualState: 'normal',       // 当前视觉状态
        brightnessNormal: 1.0,       // normal  = 常亮
        brightnessHover: 0.58,       // hover   = 变暗
        brightnessPressed: 0.28,     // pressed = 最暗
    };

    return mesh;
}

// ============================================================================
// NARRATIVE STATE MACHINE
//
// 整个作品始终只有 one THREE.Scene / one WebXR session。
// State 只决定：哪些资产可见、哪些 interaction 可用、当前处于哪一段 dramaturgy
// ============================================================================

const EXPERIENCE_STATE = Object.freeze({
    INTRO: 'intro',
    READ_NOTES: 'read_notes',
    SPECIAL_CLOCK: 'special_clock',
    COLLAPSE: 'collapse',
    TIMELESS_FIELD: 'timeless_field',
    RETURN: 'return',
    FINAL_TOWER: 'final_tower',
    END: 'end',
});

// ============================================================================
// TEMPORARY TEST
//
// 5 秒后自动进 Timeless Field，之后停在那里不再切走。
//
// Michigan demo 期间关掉：Collapse 只能通过世界空间里的 COLLAPSE 按钮触发，
// 否则人还没走到按钮前面场景就自己切走了。
// ============================================================================

const DEBUG_AUTO_STATE_TEST = false;

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
        // RUNTIME MODE STATE
        //
        // null = 还没选。所有 this.inviso?.xxx 调用在这之前都是安全的 no-op。
        // 绝对不要在 constructor 里读 BUILD_IS_MICHIGAN 来决定行为 —— 那正是
        // 这次改动要消灭的东西。行为一律读 this.runtimeMode。
        // ------------------------------------------------------------

        this.runtimeMode = null;
        this.inviso = null;
        this.modeSelectionStarted = false;

        // ------------------------------------------------------------
        // FLOOR / EYE HEIGHT
        // ------------------------------------------------------------

        const FLOOR_OFFSET = 1.30;
        const EYE_HEIGHT = 1.6;             // 桌面端（非 VR）的相机高度，进入 VR 后被 WebXR 覆盖
        const cameraY = EYE_HEIGHT + FLOOR_OFFSET;

        this.floorWorldY = FLOOR_OFFSET;
        this.teleportFloorY = 0;
        this.eyeHeight = EYE_HEIGHT;

        // ------------------------------------------------------------
        // TOWER SPAWN
        //
        // 参与者在 Clock Tower 段站立的位置（脚下的地面高度 = teleportFloorY）。
        // Timeless Field 加载完成之后，整个 Field 会被平移，让 SPAWN_ANCHOR
        // 解析出来的落脚点正好落在这里 —— 于是 Collapse 时不需要移动参与者。
        // ------------------------------------------------------------

        this.towerSpawnPosition = new THREE.Vector3(0, this.teleportFloorY, 0);

        // 面板放在视线略下方，不用低头也不用抬头。
        this.panelDistance = 1.2;
        this.panelVerticalOffset = -0.25;

        // ------------------------------------------------------------
        // TELEPORT STATE
        // ------------------------------------------------------------

        this.teleportState = [
            { aiming: false, targetValid: false, targetPoint: new THREE.Vector3() },
            { aiming: false, targetValid: false, targetPoint: new THREE.Vector3() },
        ];

        // THREE CLOCK：现在只负责普通 render tick，不再负责音乐作品时间轴。
        this.clock = new THREE.Clock();

        // ------------------------------------------------------------
        // MASTER TIMELINE STATE
        // ------------------------------------------------------------

        this.running = false;
        this.timelineStarted = false;
        this.timelineStartAt = null;
        this.audioReady = false;
        this.audioLoadErrors = [];

        this.droneRegistry = [];
        this.droneReady = false;
        this.droneLoadErrors = [];
        this.droneOffsetsReady = false;

        // PHASE 1 下载下来的压缩数据，key = 'Clock_1' / 'Drone_1'
        this.rawClockBuffers = null;
        this.rawDroneBuffers = null;

        // PHASE 2 decode 出来的 AudioBuffer
        this.audioAssets = new Map();
        this.droneAssets = new Map();

        // NARRATIVE STATE
        this.experienceState = EXPERIENCE_STATE.INTRO;
        this.previousExperienceState = null;

        // ------------------------------------------------------------
        // COLLAPSE STATE
        //
        // 一次性的定时动画。时间来自 master timeline，所以暂停时它也停。
        // ------------------------------------------------------------

        this.collapseActive = false;
        this.collapseCompleted = false;
        this.collapseStartTime = null;
        this.collapseProgress = 0;
        this.collapsePrepared = false;

        // 星空 / 身边那盏灯的渐入量。0 = 还是 Tower，1 = 完全是 Timeless Field。
        this.sceneReveal = 1;

        this.towerCollapsePieces = [];
        this.towerCollapseMode = 'pieces';   // 'pieces' | 'monolith'
        this.towerMeshCount = 0;
        this.towerFadeEntries = [];
        this.towerRootFadeState = null;

        // 世界空间里可以被控制器射线点到的东西（不是 panel UI）。
        this.worldInteractables = [];
        this.collapseButton = null;

        // 灯光 / 雾在 Tower（0）和 Timeless Field（1）之间的插值量。
        this.lightingBlend = 0;
        this.fieldFog = new THREE.FogExp2(0x0a0d1a, 0.004);

        // ------------------------------------------------------------
        // PERSISTENT WORLD ROOTS
        //
        // 它们全部都会存在于同一个 this.scene 里，State machine 只控制 visible。
        // ------------------------------------------------------------

        this.towerRoot = null;
        this.timelessFieldRoot = null;
        this.timelessFieldTerrainRoot = null;
        this.grassField = null;
        this.skyTexture = null;

        // Field 为了对齐 Tower 出生点而被整体平移的量。Restart 绝不能撤销它。
        this.timelessFieldAlignOffset = new THREE.Vector3();
        this.timelessFieldSpawnLocal = null;

        // SPAWN 调试状态：Set Spawn 按下之后把归一化坐标存在这里，画到 panel 上。
        this.spawnReadout = null;

        // Tower 段的背景色。Timeless Field 里会换成星云贴图，回来时换回这个。
        this.towerBackground = new THREE.Color(0x101820);

        // Clock GLB load 完成之前先准备好空 registry。
        this.clockRegistry = [];

        // 每帧复用的临时向量，避免在 render loop 里 new Vector3。
        this._listenerWorld = new THREE.Vector3();
        this._tmpVecA = new THREE.Vector3();
        this._tmpVecB = new THREE.Vector3();
        this._tmpQuat = new THREE.Quaternion();

        // ------------------------------------------------------------
        // LOADING UI
        //
        // 必须在任何 loader 启动之前建立，否则前几个 progress 回调无处可去。
        // ------------------------------------------------------------

        this.loading = new LoadingUI();
        this.loading.addTask('tower', 'Clock Tower model', 30);
        this.loading.addTask('field', 'Timeless Field planet', 12);
        this.loading.addTask('grass', 'Grass clump', 3);
        this.loading.addTask('sky', 'Nebula sky', 5);
        this.loading.addTask('clock_dl', `Clock stems — download (${CLOCK_COUNT})`, 45);
        this.loading.addTask('drone_dl', `Drones — download (${DRONE_CONFIG.length})`, 10);
        this.loading.setStatus('Downloading assets…');

        console.log('[Audio] context sampleRate =', audioCtx.sampleRate);

        console.log(
            `[Mode] build=${BUILD_IS_MICHIGAN ? 'michigan' : 'standalone'} ` +
            `url=${URL_FORCED_MODE ?? 'none'} default=${DEFAULT_MODE} ` +
            `prefetch=${AUDIO_PREFETCH_ENABLED}`,
        );

        console.log(
            `[Spawn] anchor = ${JSON.stringify(ACTIVE_SPAWN_ANCHOR)} ` +
            `(${URL_SPAWN_ANCHOR ? 'from ?spawn=' : 'from SPAWN_ANCHOR constant'})`,
        );

        // ------------------------------------------------------------
        // CAMERA
        // ------------------------------------------------------------

        this.camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 2000);
        this.camera.position.set(0, cameraY, 0);

        // ------------------------------------------------------------
        // SCENE
        // ------------------------------------------------------------

        this.scene = new THREE.Scene();
        this.scene.background = this.towerBackground;

        // 保存引用，applyExperienceState() 会按 state 切换颜色和强度。
        this.hemiLight = new THREE.HemisphereLight(0xffffff, 0x202020, 0.6);
        this.scene.add(this.hemiLight);

        this.dirLight = new THREE.DirectionalLight(0xffffff, 2);
        this.dirLight.position.set(1, 3, 2).normalize();
        this.scene.add(this.dirLight);

        // ------------------------------------------------------------
        // RENDERER
        // ------------------------------------------------------------

        this.renderer = new THREE.WebGLRenderer({ antialias: true });
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
        this.stats.dom.style.zIndex = '10';   // 低于 LoadingUI（99999），加载结束后才看得到
        document.body.appendChild(this.stats.dom);

        this.rc = new THREE.Raycaster();
        this.teleportRaycaster = new THREE.Raycaster();
        this.spawnRaycaster = new THREE.Raycaster();

        // ------------------------------------------------------------
        // CONTROLLER STATE
        // ------------------------------------------------------------

        this.ctrlState = [
            { selectPressed: false, justFired: false, hoveredBtn: null, pressedBtn: null, debugLastAction: null, ray: null },
            { selectPressed: false, justFired: false, hoveredBtn: null, pressedBtn: null, debugLastAction: null, ray: null },
        ];

        // ------------------------------------------------------------
        // INITIALIZE
        //
        // 顺序有讲究：setupVR() 必须在任何 loader 之前跑完，因为加载完成回调会
        // 调用 _setVRButtonEnabled()，而那个按钮是在 setupVR() 里建的。
        // 下载极快（例如全部命中缓存）时这个顺序就是唯一防线。
        // ------------------------------------------------------------

        this.initScene();

        // 必须先建立 masterGain，然后才能给 Clock / Drone 创建 panner chain。
        this.setupAudio();
        this.setupDrones();          // 只建立 spatial chain，不下载文件

        this.setupVR();
        this.setupDebugStateControls();

        // 音频下载和 GLB 加载并行启动。
        // 音频文件名可预测，不需要等 GLB 解析出 Clock_N 之后才开始下载。
        // 注意这里只下载，不 decode —— decode 要等选完模式（见 _commitRuntimeMode）。
        this.audioDownload = this._downloadAudio();

        this.loadClockModel();       // Moving clock objects
        this.loadTimelessField();
        this.loadSky();

        window.addEventListener('resize', this.resize.bind(this));
        this.renderer.setAnimationLoop(this.render.bind(this));
    }

    // ========================================================================
    // MODE-DERIVED FLAGS
    //
    // 全部行为都从这两个 getter 走，不要在别处再判断 runtimeMode 字符串。
    // ========================================================================

    get isMichigan() {
        return this.runtimeMode === RUNTIME_MODE.MICHIGAN;
    }

    // Quest 本地是否负责出声。
    // Michigan 模式下永远 false；Standalone 但文件没下载（?noaudio）时也是 false。
    get localAudioEnabled() {
        return this.runtimeMode === RUNTIME_MODE.STANDALONE && AUDIO_PREFETCH_ENABLED;
    }

    // ========================================================================
    // PHASE 1 → MODE PICKER → PHASE 2
    // ========================================================================

    // ------------------------------------------------------------
    // 这里以前只改 pointerEvents 和 opacity，也就是「让按钮看起来能点」。
    // 但 VRButton 在 isSessionSupported 返回 false 时会把文字改成
    // VR NOT SUPPORTED 并且**根本不绑 onclick** —— 于是一个死按钮被点亮成
    // 可用的样子，点下去毫无反应也毫无报错。
    //
    // 所以现在同时检查真实状态（onclick 存不存在），对不上就在 console
    // 和 XR HUD 上明说。
    // ------------------------------------------------------------

    _setVRButtonEnabled(enabled) {
        if (!this.vrButtonEl) return;

        this.vrButtonEl.style.pointerEvents = enabled ? 'auto' : 'none';
        this.vrButtonEl.style.opacity = enabled ? '1' : '0.35';

        if (!enabled) return;

        const live = typeof this.vrButtonEl.onclick === 'function';

        if (!live) {
            const message =
                `ENTER VR 按钮是死的：文字="${this.vrButtonEl.textContent}"。` +
                `secure=${window.isSecureContext} protocol=${window.location.protocol}`;

            console.error(`[XR] ${message}`);

            this.setXRDebug?.(message, '#ff6b6b');
        } else {
            this.setXRDebug?.('ENTER VR ready', '#00ff88');
        }
    }

    // PHASE 1 的每一个 task 结束时都会调用这个。全部结束 → 进入模式选择。
    _checkPhase1Done() {
        if (this.modeSelectionStarted) return;
        if (!this.loading || !this.loading.isComplete()) return;

        if (this.loading.hasFailures()) {
            this._setVRButtonEnabled(false);

            this.loading.showFatalError('Some required assets failed to load.');

            console.error('[Loading] PHASE 1 FAILED — runtime mode selection blocked.');

            return;
        }

        this.modeSelectionStarted = true;

        this._runModeSelection().catch((error) => {
            console.error('[Mode] Runtime setup crashed:', error);

            this._setVRButtonEnabled(false);

            this.loading.showFatalError(`Runtime setup crashed: ${error?.message ?? error}`);
        });
    }

    async _runModeSelection() {
        // URL 锁定 → 不显示选择界面，直接走。装置现场用这条路径。
        if (URL_FORCED_MODE) {
            console.log(`[Mode] Locked by URL → ${URL_FORCED_MODE}`);

            this.loading.setStatus(`Mode locked by URL: ${MODE_LABEL[URL_FORCED_MODE]}`);

            await this._commitRuntimeMode(URL_FORCED_MODE);
            return;
        }

        const sourceNote = readModeFromStorage()
            ? 'Default is your last choice on this headset.'
            : `Default comes from the build flag (IS_MICHIGAN = ${BUILD_IS_MICHIGAN}).`;

        const prefetchNote = AUDIO_PREFETCH_ENABLED
            ? 'Stems are already downloaded — Standalone will decode them now, Michigan will discard them.'
            : 'Audio prefetch was disabled (?noaudio), so Standalone will run silently.';

        const mode = await this.loading.chooseMode(
            DEFAULT_MODE,
            `${sourceNote}\nAdd ?mode=standalone or ?mode=michigan to the URL to skip this screen.\n${prefetchNote}`,
        );

        await this._commitRuntimeMode(mode);
    }

    // ------------------------------------------------------------
    // COMMIT MODE
    //
    // 这是唯一写 this.runtimeMode 的地方，也是唯一创建 InvisoClient 的地方。
    // ------------------------------------------------------------

    async _commitRuntimeMode(mode) {
        this.runtimeMode = mode;

        try {
            localStorage.setItem(RUNTIME_MODE_STORAGE_KEY, mode);
        } catch (_) {
            // 隐私模式下写不进去，无所谓。
        }

        console.log(
            `%c[Mode] RUNTIME MODE = ${MODE_LABEL[mode]}`,
            'color:#ffcc66;font-weight:bold;font-size:14px',
        );

        // AudioContext 不在 loading 阶段强制 resume。
        //
        // URL forced mode（例如 ?mode=standalone）没有 user gesture，
        // Quest Browser 可能会阻止 audioCtx.resume()，导致整个 loading 流程卡住。
        //
        // 真正开始作品时，startAudio() 会在用户按下 VR Start 之后
        // 再 resume AudioContext；那个操作有合法 user gesture。
        console.log('[Audio] Context will resume when the experience starts.');

        // 模式指示只是辅助信息，绝不能因为它失败就挡住整个体验。
        try {
            this._drawPanelBackground();
        } catch (error) {
            console.warn('[Mode] VR panel redraw failed — continuing:', error);
        }

        try {
            showModeBadge(mode);
        } catch (error) {
            console.warn('[Mode] Desktop mode badge failed — continuing:', error);
        }

        this.loading.setStatus(`Entering ${MODE_LABEL[this.runtimeMode]} mode…`);

        let modeReady = false;

        if (this.isMichigan) {
            modeReady = await this._enterMichiganMode();
        } else {
            modeReady = await this._enterStandaloneMode();
        }

        this._bindAudioBuffers();

        if (!modeReady) {
            this._setVRButtonEnabled(false);

            this.loading.showFatalError(`${MODE_LABEL[this.runtimeMode]} setup failed.`);

            console.error(
                `[Loading] ${MODE_LABEL[this.runtimeMode]} setup FAILED — ENTER VR remains disabled.`,
            );

            return;
        }

        this._finishLoading();
    }

    async _enterMichiganMode() {
        // 已经下载但不会用到的压缩数据，扔掉让 GC 回收。绝不 decode。
        const droppedClocks = this.rawClockBuffers?.size ?? 0;
        const droppedDrones = this.rawDroneBuffers?.size ?? 0;

        this.rawClockBuffers = null;
        this.rawDroneBuffers = null;

        this.audioReady = false;
        this.droneReady = false;

        if (droppedClocks || droppedDrones) {
            console.log(
                `[Audio] Michigan mode — discarded ${droppedClocks + droppedDrones} downloaded file(s) without decoding.`,
            );
        }

        // Inviso 只在这里创建。构造期不再碰它。
        this.loading.resetTasks();
        this.loading.addTask('inviso', 'Inviso OSC bridge', 1);
        this.loading.setStatus('Connecting to Inviso bridge…');

        this.inviso = new InvisoClient();
        this.inviso.connect();

        try {
            await this.inviso.waitForBridgeReady(8000);

            this.loading.setProgress('inviso', 1, 'connected');

            this.loading.setStatus('Quest sends listener pose only — no local playback.');

            return true;
        } catch (error) {
            console.error('[Inviso] Bridge connection failed:', error);

            this.loading.fail('inviso', 'Inviso bridge connection failed');

            return false;
        }
    }

    async _enterStandaloneMode() {
        this.inviso = null;

        this.loading.resetTasks();
        this.loading.addTask('clock_decode', `Clock stems — decode (${CLOCK_COUNT})`, 80);
        this.loading.addTask('drone_decode', `Drones — decode (${DRONE_CONFIG.length})`, 20);

        if (!AUDIO_PREFETCH_ENABLED) {
            this.loading.skip('clock_decode', 'no audio');
            this.loading.skip('drone_decode', 'no audio');
            this.loading.setStatus('Audio prefetch disabled — timeline will run silently.');

            console.warn(
                '[Audio] Standalone selected but prefetch was disabled (?noaudio / DEBUG_SKIP_AUDIO). ' +
                'Master timeline still runs, but nothing will play.',
            );

            return true;
        }

        this.loading.setStatus('Decoding audio…');

        const t0 = performance.now();

        // Drone 先 decode：只有 3 个而且很短，进度条马上有反馈。
        // 顺序执行而不是 Promise.all，避免同时超过 AUDIO_DECODE_CONCURRENCY 条解码线，
        // decode 抢主线程会直接表现为首帧卡顿。
        const droneResult = await decodeAudioEntries(this.rawDroneBuffers ?? new Map(), {
            concurrency: 1,
            onProgress: (done, total) => {
                this.loading.setProgress('drone_decode', done / total, `${done}/${total}`);
            },
        });

        const clockResult = await decodeAudioEntries(this.rawClockBuffers ?? new Map(), {
            concurrency: AUDIO_DECODE_CONCURRENCY,
            onProgress: (done, total) => {
                this.loading.setProgress('clock_decode', done / total, `${done}/${total}`);
                this.loading.setStatus(`Decoding clock stems… ${done}/${total}`);
            },
        });

        // ------------------------------------------------------------
        // CLOCK RESULT
        // ------------------------------------------------------------

        this.audioAssets = clockResult.results;
        this.audioLoadErrors = [...(this.clockDownloadErrors ?? []), ...clockResult.errors];
        this.audioReady = this.audioLoadErrors.length === 0 && clockResult.results.size === CLOCK_COUNT;

        if (this.audioReady) {
            const durations = [...clockResult.results.values()].map((buffer) => buffer.duration);
            const minDuration = Math.min(...durations);
            const maxDuration = Math.max(...durations);

            console.log(
                `%c[Audio] READY — ${clockResult.results.size} stems decoded in ` +
                `${((performance.now() - t0) / 1000).toFixed(1)}s. ` +
                `Duration range: ${minDuration.toFixed(3)}s–${maxDuration.toFixed(3)}s`,
                'color:#00ff88;font-weight:bold',
            );

            // CHECK DAW EXPORT LENGTH
            if (maxDuration - minDuration > 0.01) {
                console.warn('[Audio] Stem lengths are not identical. Check DAW export boundaries.');
            }

            // 解出来的 PCM 常驻内存：mono float32，48k × 秒数 × 4 bytes × 轨数。
            // 6 分钟 × 21 轨大约 1.4 GB —— 这就是为什么 DAW 要拆成三段导出，
            // 三段方案解决的不只是 gesture-wait 的变长窗口，也是这个内存问题。
            const pcmBytes = [...clockResult.results.values()]
                .concat([...droneResult.results.values()])
                .reduce((sum, b) => sum + b.length * b.numberOfChannels * 4, 0);

            console.log(`[Audio] Decoded PCM footprint ≈ ${(pcmBytes / 1048576).toFixed(0)} MB`);
        } else {
            console.error(`[Audio] NOT READY — ${this.audioLoadErrors.length} file(s) failed.`, this.audioLoadErrors);
            this.loading.fail('clock_decode', 'Some clock stems failed');
        }

        // ------------------------------------------------------------
        // DRONE RESULT
        // ------------------------------------------------------------

        this.droneAssets = droneResult.results;
        this.droneLoadErrors = [...(this.droneDownloadErrors ?? []), ...droneResult.errors];
        this.droneReady = this.droneLoadErrors.length === 0 && droneResult.results.size === DRONE_CONFIG.length;

        if (this.droneReady) {
            console.log(
                `%c[Drone] READY — ${droneResult.results.size} fixed drones decoded.`,
                'color:#cc99ff;font-weight:bold',
            );
        } else {
            console.error(`[Drone] NOT READY — ${this.droneLoadErrors.length} file(s) failed.`, this.droneLoadErrors);
            this.loading.fail('drone_decode', 'Some drones failed');
        }

        this.loading.setProgress('clock_decode', 1);
        this.loading.setProgress('drone_decode', 1);
        this.loading.setStatus('');

        // decodeAudioData 已经 detach 了原始 ArrayBuffer，这里只是把 Map 引用放掉。
        this.rawClockBuffers = null;
        this.rawDroneBuffers = null;

        return this.audioReady && this.droneReady;
    }

    _finishLoading() {
        this._setVRButtonEnabled(true);
        this.loading.setStatus('Ready — press ENTER VR');

        console.log(
            `%c[Loading] ALL ASSETS READY — mode ${MODE_LABEL[this.runtimeMode]}`,
            'color:#00ff88;font-weight:bold',
        );

        this._refreshPanel();

        setTimeout(() => this.loading.hide(), 500);
    }

    // ========================================================================
    // PHASE 1 — DOWNLOAD AUDIO
    //
    // 和 GLB 并行运行。只下载，不 decode。
    // ========================================================================

    async _downloadAudio() {
        if (!AUDIO_PREFETCH_ENABLED) {
            const note = URL_FORCED_MODE === RUNTIME_MODE.MICHIGAN ? 'Inviso' : 'skipped';

            this.loading.skip('clock_dl', note);
            this.loading.skip('drone_dl', note);

            console.warn(`[Audio] Prefetch skipped (${note}).`);

            this._checkPhase1Done();
            return;
        }

        // ------------------------------------------------------------
        // CLOCK STEMS
        // ------------------------------------------------------------

        const clockEntries = [];

        for (let i = 1; i <= CLOCK_COUNT; i++) {
            clockEntries.push({
                key: `Clock_${i}`,
                url: `${import.meta.env.BASE_URL}${CLOCK_AUDIO_FOLDER}/Clock_${i}.${CLOCK_AUDIO_EXTENSION}`,
            });
        }

        // ------------------------------------------------------------
        // DRONES
        // ------------------------------------------------------------

        const droneEntries = DRONE_CONFIG.map((config) => ({
            key: config.name,
            url: `${import.meta.env.BASE_URL}${CLOCK_AUDIO_FOLDER}/${config.file}`,
        }));

        const t0 = performance.now();

        const [clockResult, droneResult] = await Promise.all([
            downloadAudioEntries(clockEntries, {
                onProgress: (done, total) => {
                    this.loading.setProgress('clock_dl', done / total, `${done}/${total}`);
                    this.loading.setStatus(`Downloading clock stems… ${done}/${total}`);
                },
            }),

            downloadAudioEntries(droneEntries, {
                onProgress: (done, total) => {
                    this.loading.setProgress('drone_dl', done / total, `${done}/${total}`);
                },
            }),
        ]);

        this.rawClockBuffers = clockResult.buffers;
        this.rawDroneBuffers = droneResult.buffers;

        // 下载阶段的错误要保留到 decode 阶段一起汇报，否则 Michigan 切 Standalone 时会漏。
        this.clockDownloadErrors = clockResult.errors;
        this.droneDownloadErrors = droneResult.errors;

        const totalMB = (clockResult.bytes + droneResult.bytes) / 1048576;

        console.log(
            `[Audio] Downloaded ${clockResult.buffers.size + droneResult.buffers.size} file(s), ` +
            `${totalMB.toFixed(1)} MB in ${((performance.now() - t0) / 1000).toFixed(1)}s (not decoded yet)`,
        );

        if (clockResult.errors.length > 0) {
            this.loading.fail('clock_dl', 'Some clock stems failed to download');
        } else {
            this.loading.setProgress('clock_dl', 1);
        }

        if (droneResult.errors.length > 0) {
            this.loading.fail('drone_dl', 'Some drones failed to download');
        } else {
            this.loading.setProgress('drone_dl', 1);
        }

        this.loading.setStatus('');

        this._checkPhase1Done();
    }

    // ========================================================================
    // BIND DECODED BUFFERS
    //
    // 幂等。GLB 完成时和 decode 完成时各调用一次，谁后到谁生效。
    // Michigan 模式下 audioAssets 是空的，直接返回。
    // ========================================================================

    _bindAudioBuffers() {
        // DRONES
        if (this.droneRegistry?.length && this.droneAssets?.size) {
            this.droneRegistry.forEach((droneData) => {
                droneData.audioBuffer = this.droneAssets.get(droneData.name) ?? null;
            });
        }

        // CLOCKS
        if (!this.clockRegistry?.length || !this.audioAssets?.size) return;

        let missing = 0;

        this.clockRegistry.forEach((clockData) => {
            const buffer = this.audioAssets.get(clockData.name) ?? null;

            clockData.audioBuffer = buffer;

            if (!buffer) missing++;
        });

        if (missing > 0) {
            console.warn(
                `[Audio] ${missing} clock(s) in the GLB have no matching stem. ` +
                `CLOCK_COUNT=${CLOCK_COUNT}, GLB clocks=${this.clockRegistry.length}. ` +
                `如果 GLB 里的钟数量变了，改 CLOCK_COUNT。`,
            );

            this.audioReady = false;
        }
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

                // DEBUG MODEL INFO
                if (DEBUG_MESH_INFO) {
                    const allMeshInfo = [];

                    model.traverse((object) => {
                        if (!object.isMesh) return;

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
                    console.table(allMeshInfo.slice(0, 10).map((m) => ({
                        name: m.name, material: m.material, maxDim: m.maxDim.toFixed(3),
                    })));
                }

                // REMOVE SKY / WORLD GRID
                const meshesToRemove = [];

                model.traverse((object) => {
                    if (!object.isMesh) return;

                    const objectInfo = `${object.name} ${object.material?.name || ''}`;
                    const isWorldGrid = /HLOD|MainGrid|ProcGrid|Landscape|Sky|Dome/i.test(objectInfo);

                    if (isWorldGrid) meshesToRemove.push(object);
                });

                meshesToRemove.forEach((object) => object.parent?.remove(object));

                // CALCULATE MODEL SIZE
                const box = new THREE.Box3().setFromObject(model);
                const size = new THREE.Vector3();
                const center = new THREE.Vector3();

                box.getSize(size);
                box.getCenter(center);

                console.log('删除后模型尺寸：', { x: size.x, y: size.y, z: size.z });
                console.log('删除后模型中心：', { x: center.x, y: center.y, z: center.z });

                // CENTER MODEL
                model.position.x -= center.x;
                model.position.z -= center.z;
                model.position.y -= box.min.y;

                // WRAPPER
                const wrapper = new THREE.Group();
                wrapper.name = 'ClocksModelWrapper';
                wrapper.add(model);

                const maxDim = Math.max(size.x, size.y, size.z);
                const targetSize = 14.0;
                const scale = targetSize / maxDim;

                wrapper.scale.setScalar(scale);
                wrapper.position.set(0, 0, 0);
                this.scene.add(wrapper);

                // SAVE PERSISTENT TOWER ROOT
                //
                // 以后 Collapse 的时候 this.towerRoot.visible = false 只隐藏 Tower environment。
                // Clock_N 已经被 scene.attach(clockObj) 拆出去，所以不会跟 Tower 一起消失。
                this.towerRoot = wrapper;

                // OPTIONAL CLICK DEBUG
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
                                `%c点中了: ${obj.name}`, 'color:#0f0;font-weight:bold',
                                '世界坐标:', worldPos.toArray().map((v) => v.toFixed(2)),
                                'parent:', obj.parent?.name, 'parent的parent:', obj.parent?.parent?.name,
                            );
                        } else {
                            console.log('没点中任何东西');
                        }
                    });
                }

                // FIND ALL Clock_N GROUPS
                this.clockRegistry = [];
                const clockGroups = [];

                model.traverse((object) => {
                    if (/^Clock_\d+$/i.test(object.name)) clockGroups.push(object);
                });

                // GLB traverse 顺序不一定是 Clock_1, Clock_2, Clock_3...，所以手动按数字排序。
                clockGroups.sort((a, b) => getClockNumber(a.name) - getClockNumber(b.name));

                console.log(`找到 ${clockGroups.length} 个钟表 Group：`, clockGroups.map((g) => g.name));

                // BUILD CLOCK REGISTRY
                clockGroups.forEach((clockObj, index) => {
                    // 把 Clock 从 wrapper 中 detach 出来，scene.attach() 会保持视觉上的世界坐标 / rotation / scale 不变。
                    this.scene.attach(clockObj);

                    const originalPosition = clockObj.position.clone();
                    const originalQuaternion = clockObj.quaternion.clone();
                    const originalScale = clockObj.scale.clone();

                    const movement = getMovementConfig(clockObj.name, index);

                    const audioNode = createClockSpatialChain(this.masterGain, originalPosition);

                    // 融化时要下沉多少 —— 用钟自己的高度算，别写死一个数。
                    const clockBox = new THREE.Box3().setFromObject(clockObj);
                    const clockHeight = Math.max(0.1, clockBox.max.y - clockBox.min.y);

                    // ------------------------------------------------
                    // 材质在**加载期**就 clone 好，不放到 Collapse 那一刻。
                    //
                    // 这个 GLB 里 18 个钟一共 770 个 mesh primitive，
                    // 而且和建筑共用 5 个材质（Wood_Arroway ×4 + Metal_Bronze）。
                    // 不 clone 的话，钟一淡出，墙和屋顶会跟着一起变透明。
                    //
                    // clone 770 个材质是一次可见的开销，放在按下按钮的瞬间会卡一下 ——
                    // 那正是 demo 里最不能卡的一帧。所以挪到加载界面后面。
                    // ------------------------------------------------

                    const fadeEntries = prepareFadeMaterials(clockObj);

                    this.clockRegistry.push({
                        name: clockObj.name,
                        index,

                        // ------------------------------------------------
                        // VISUAL 和 AUDIO 彻底分开
                        //
                        // visualObject   会融化、会 visible = false
                        // towerPosition  塔内轨迹算出来的位置（音频用的"旧坐标"）
                        // audioPosition  真正写进 panner 的坐标
                        //
                        // Collapse 之后 visualObject 不再是音频位置的来源。
                        // mesh 不可见 ≠ 声音停止 —— AudioBufferSourceNode 从头到尾
                        // 一次都不 stop()。
                        // ------------------------------------------------

                        object: clockObj,          // 兼容旧代码的别名
                        visualObject: clockObj,

                        originalPosition,
                        originalQuaternion,
                        originalScale,

                        towerPosition: originalPosition.clone(),
                        audioPosition: originalPosition.clone(),

                        clockHeight,
                        meltBasePosition: originalPosition.clone(),
                        fadeEntries,

                        audioBuffer: null,      // 由 _bindAudioBuffers() 填入
                        audioNode,

                        movementStart: movement.start,
                        duration: movement.duration,

                        // 以人为中心的轨道参数（见 _clockOrbitPosition）
                        orbitGroup: Math.floor(index / 6),
                        orbitAngleOffset: ((index % 6) / 6) * Math.PI * 2 + Math.floor(index / 6) * 0.35,

                        // ------------------------------------------------
                        // DEMO TRAJECTORY（塔内）
                        //
                        // 18 个 Clock 分成三层空间：Clock 1–6 = near = 5m, 7–12 = mid = 10m, 13–18 = far = 18m
                        // tt: 0 → movement start, 1 → expansion finished, >1 → continue orbiting
                        //
                        // 注意这条轨迹**绕世界原点**。Collapse 之后音频不再用它，
                        // 而是切换到以参与者为中心的轨道（_clockOrbitPosition）。
                        // ------------------------------------------------

                        trajectory: (originalPos, tt) => {
                            // WHICH SPATIAL LAYER? index 0–5 → group 0, 6–11 → group 1, 12–17 → group 2
                            const group = Math.floor(index / 6);

                            const radii = CLOCK_ORBIT_RADII;   // near / mid / far
                            const heights = [2.5, 5.0, 8.0];   // near / mid / far

                            const radius = radii[group];
                            const baseHeight = heights[group];

                            // 每组六个钟平均分布在 360°，三层稍微错开角度避免三个 ring 完全重叠
                            const angleOffset = ((index % 6) / 6) * Math.PI * 2 + group * 0.35;

                            // tt: 0 → 第 5 秒, 1 → 第 15 秒。smoothstep 让 movement 不会突然启动 / 突然停止。
                            const expandProgress = THREE.MathUtils.smoothstep(Math.min(tt, 1), 0, 1);

                            // expansion 完成以前 orbitTime = 0，15 秒以后开始增加。
                            const orbitTime = Math.max(0, tt - 1);

                            // 0.8 是 rotation speed，因为 tt 的 1 大约对应 10 秒，所以实际 rotation 很慢。
                            const angle = angleOffset + orbitTime * CLOCK_ORBIT_SPEED;

                            const targetX = Math.cos(angle) * radius;
                            const targetZ = Math.sin(angle) * radius;

                            // 轻微上下漂浮，每个 Clock phase 不一样所以不会一起上下动。
                            const floatingY = Math.sin(orbitTime * 2.5 + index * 0.7) * 0.8;
                            const targetY = baseHeight + floatingY;

                            // ORIGINAL POSITION → SPATIAL FIELD
                            return {
                                x: THREE.MathUtils.lerp(originalPos.x, targetX, expandProgress),
                                y: THREE.MathUtils.lerp(originalPos.y, targetY, expandProgress),
                                z: THREE.MathUtils.lerp(originalPos.z, targetZ, expandProgress),
                            };
                        },
                    });
                });

                // ------------------------------------------------------------
                // TOWER ARCHITECTURE PIECES
                //
                // Clock 已经 detach 出去了，所以这时候 towerRoot 里剩下的
                // 全都是建筑本体。这里必须在运行时数，因为 GLB 的层级
                // 只有加载完才知道。
                // ------------------------------------------------------------

                this._buildTowerCollapseRegistry();

                this.applyExperienceState();

                // 音频可能已经 decode 完了，也可能还没选模式。两边都会调用 bind，谁后到谁生效。
                this._bindAudioBuffers();

                this.loading.setProgress('tower', 1);
                this._checkPhase1Done();

                console.log('Clock model loaded, scale:', scale);
            },

            // LOADING PROGRESS
            (xhr) => {
                const { p, text } = estimateProgress(xhr);

                this.loading.setProgress('tower', p, text);
            },

            // ERROR
            (error) => {
                console.error('Error loading clock model:', error);

                this.loading.fail('tower', 'Clock Tower failed to load');
                this._checkPhase1Done();
            },
        );
    }

    // ========================================================================
    // TOWER COLLAPSE REGISTRY
    //
    // 目标：把 Tower 建筑拆成一组可以各自飞出去的"构件"。
    //
    // GLB 的实际结构只有运行时才知道，所以这里是自适应的：
    //
    //   mesh 数 ≤ TOWER_MAX_PIECES        → 每个 mesh 就是一个构件
    //   mesh 数 >  TOWER_MAX_PIECES        → 往上找父节点分组，直到组数落进上限
    //   构件数 <  TOWER_MONOLITH_THRESHOLD → 认定"塔是一整块"，走 monolith 兜底
    //
    // 不会去程序化切割几何体。一整块就是一整块，宁可用整体下沉 + 淡出，
    // 也不假装能把它炸成有意义的建筑碎块。
    // ========================================================================

    _buildTowerCollapseRegistry() {
        this.towerCollapsePieces = [];
        this.towerFadeEntries = [];
        this.towerRootFadeState = null;

        const root = this.towerRoot;

        if (!root) return;

        const meshes = [];

        root.traverse((object) => {
            if (object.isMesh) meshes.push(object);
        });

        this.towerMeshCount = meshes.length;

        if (meshes.length === 0) {
            console.warn('[Collapse] Tower 里没有任何 mesh（Clock 已经 detach）。Collapse 只会切状态，看不到解体。');
            this.towerCollapseMode = 'monolith';
            return;
        }

        const pieceObjects = this._selectTowerPieceObjects(root, meshes);

        this.towerCollapseMode =
            pieceObjects.length >= TOWER_MONOLITH_THRESHOLD ? 'pieces' : 'monolith';

        // ------------------------------------------------------------
        // 塔的世界中心（水平方向）。构件向外飞的方向从这里算。
        // ------------------------------------------------------------

        root.updateMatrixWorld(true);

        const towerBox = new THREE.Box3().setFromObject(root);
        const towerCenter = towerBox.getCenter(new THREE.Vector3());

        const random = makeRandom(20260830);

        // 逐片 clone 出来的材质在这里汇总一份平表，Restart 时一次性还原。
        const allFadeEntries = [];

        const pieceCenter = new THREE.Vector3();
        const dirWorld = new THREE.Vector3();
        const parentInverse = new THREE.Matrix4();

        pieceObjects.forEach((object, i) => {
            object.updateMatrixWorld(true);

            const box = new THREE.Box3().setFromObject(object);

            if (box.isEmpty()) {
                object.getWorldPosition(pieceCenter);
            } else {
                box.getCenter(pieceCenter);
            }

            // 水平向外。正好在中轴上的构件给一个伪随机方向，否则它会原地不动。
            dirWorld.set(pieceCenter.x - towerCenter.x, 0, pieceCenter.z - towerCenter.z);

            if (dirWorld.lengthSq() < 1e-4) {
                const angle = random() * Math.PI * 2;
                dirWorld.set(Math.cos(angle), 0, Math.sin(angle));
            }

            dirWorld.normalize();

            // 略微上扬，读起来像"被掀开"而不是"被推倒"。
            dirWorld.y = 0.18 + random() * 0.45;
            dirWorld.normalize();

            // 父节点的世界矩阵求逆，把方向换算到构件自己的 local space。
            // 构件是在原来的层级里移动的，不做 scene.attach —— 那样 Restart
            // 要恢复的东西会多一整套父子关系。
            const parent = object.parent ?? root;

            parentInverse.copy(parent.matrixWorld).invert();

            const dirLocal = dirWorld.clone().transformDirection(parentInverse).normalize();

            // wrapper 上烘了 targetSize/maxDim 的缩放，所以 1 local unit ≠ 1 米。
            // 加速度是按米给的，这里换算成 local unit。
            const worldScale = parent.getWorldScale(new THREE.Vector3());
            const scaleAvg = (Math.abs(worldScale.x) + Math.abs(worldScale.y) + Math.abs(worldScale.z)) / 3 || 1;

            // 漂移速度，不是加速度。整段下来每片只走两三米。
            const driftWorld = COLLAPSE_DRIFT_SPEED_MIN +
                random() * (COLLAPSE_DRIFT_SPEED_MAX - COLLAPSE_DRIFT_SPEED_MIN);

            const axis = new THREE.Vector3(
                random() * 2 - 1,
                random() * 2 - 1,
                random() * 2 - 1,
            );

            if (axis.lengthSq() < 1e-6) axis.set(0, 1, 0);

            axis.normalize();

            // 高处的构件先松、低处的后松，读起来像从上往下垮。
            const heightRatio = towerBox.max.y > towerBox.min.y
                ? (pieceCenter.y - towerBox.min.y) / (towerBox.max.y - towerBox.min.y)
                : 0;

            const stagger =
                ((1 - heightRatio) * 0.7 + random() * 0.3) * COLLAPSE_STAGGER_SPREAD;

            // 这一片自己的飞行时长：从它松脱那一刻到 Collapse 结束。
            // 淡出按这个长度算，所以每片都是"边飞边淡"、在自己的终点归零。
            const flightDuration = Math.max(
                0.001,
                COLLAPSE_DURATION - COLLAPSE_SHAKE_END - stagger,
            );

            // 每片单独 clone 材质。这样淡出可以逐片控制，
            // 而不是 141 片共用一条全局曲线。
            const fadeEntries = prepareFadeMaterials(object);

            fadeEntries.forEach((entry) => allFadeEntries.push(entry));

            this.towerCollapsePieces.push({
                object,
                originalPosition: object.position.clone(),
                originalQuaternion: object.quaternion.clone(),
                originalScale: object.scale.clone(),

                dirLocal,
                localPerMeter: 1 / scaleAvg,
                driftLocal: driftWorld / scaleAvg,
                shakeLocal: COLLAPSE_SHAKE_AMPLITUDE / scaleAvg,

                axis,
                angularSpeed: (random() - 0.5) * 2 * COLLAPSE_SPIN_MAX,

                stagger,
                flightDuration,
                fadeEntries,
                phase: i * 1.7 + random() * 6.28,
            });
        });

        // ------------------------------------------------------------
        // 材质在加载期就 clone 完了（上面逐片做的）。
        //
        // 这一步不能省：建筑和钟共用 5 个材质，直接改 opacity 会把钟一起淡掉。
        // 建筑只有 141 个 mesh primitive，clone 的开销可以忽略。
        //
        // towerFadeEntries 是所有构件材质的平表，只用于 Restart 还原
        // 和 monolith 兜底路径的全局淡出。逐片淡出走 piece.fadeEntries。
        // ------------------------------------------------------------

        this.towerFadeEntries = allFadeEntries;

        if (allFadeEntries.length > TOWER_MAX_FADE_MESHES) {
            console.warn(
                `[Collapse] Tower 有 ${allFadeEntries.length} 个 mesh 参与淡出，` +
                `超过 ${TOWER_MAX_FADE_MESHES} —— Collapse 期间半透明 overdraw 可能掉帧。`,
            );
        }

        console.log(
            `%c[Collapse] Tower architecture — ${meshes.length} mesh / ` +
            `${this.towerCollapsePieces.length} 可动构件 / mode=${this.towerCollapseMode} / ` +
            `fade materials=${this.towerFadeEntries.length}`,
            'color:#ffcc66;font-weight:bold',
        );

        if (this.towerCollapseMode === 'monolith') {
            console.warn(
                `[Collapse] 只找到 ${this.towerCollapsePieces.length} 个可动构件 —— ` +
                `这个 GLB 的建筑本体基本上是一整块，没法拆成有意义的建筑碎块。` +
                `已自动切到 monolith 兜底：整体震动 → 下沉 → 淡出。` +
                `要真正的解体效果，需要 Spencer 在导出时把建筑分成独立的 mesh。`,
            );
        }
    }

    // 选出"构件"层级：mesh 太多就往上找共同父节点，直到组数落进上限。
    _selectTowerPieceObjects(root, meshes) {
        if (meshes.length <= TOWER_MAX_PIECES) return meshes;

        const chains = meshes.map((mesh) => {
            const chain = [];
            let node = mesh;

            while (node && node !== root) {
                chain.unshift(node);
                node = node.parent;
            }

            return chain;
        });

        const maxDepth = chains.reduce((max, chain) => Math.max(max, chain.length), 0);

        // 从最深往上走，取第一个组数 ≤ 上限的层级（也就是最细的可用粒度）。
        for (let depth = maxDepth - 1; depth >= 0; depth--) {
            const set = new Set();

            chains.forEach((chain) => set.add(chain[Math.min(depth, chain.length - 1)]));

            if (set.size <= TOWER_MAX_PIECES) {
                console.log(
                    `[Collapse] ${meshes.length} 个 mesh 太多了，改用第 ${depth} 层的 ` +
                    `${set.size} 个父节点作为构件。`,
                );

                return [...set];
            }
        }

        return [...new Set(chains.map((chain) => chain[0]))];
    }

    // ========================================================================
    // LOAD TIMELESS FIELD
    //
    // 两个 GLB：Planet（donut 地形）和 GrassClump（一簇草）。
    // 草不是 Spencer 摆好的 —— 第一版他导出了 271,418 个 mesh node / 733M 三角形，
    // 因为 Unreal 的 foliage instancing 在 glTF 导出时被展开成了独立节点。
    // 现在他只交一簇 12 三角形的草，撒点由 GrassField.js 在运行时做。
    // ========================================================================

    loadTimelessField() {
        const loader = new GLTFLoader();

        const planetUrl = `${import.meta.env.BASE_URL}models/TimelessField_Planet.glb`;
        const grassUrl = `${import.meta.env.BASE_URL}models/GrassClump.glb`;

        const loadGLB = (url, taskId) => new Promise((resolve, reject) => {
            loader.load(
                url,
                (gltf) => {
                    this.loading.setProgress(taskId, 1);
                    resolve(gltf);
                },
                (xhr) => {
                    const { p, text } = estimateProgress(xhr);
                    this.loading.setProgress(taskId, p, text);
                },
                reject,
            );
        });

        Promise.all([
            loadGLB(planetUrl, 'field'),
            loadGLB(grassUrl, 'grass'),
        ]).then(([planetGltf, grassGltf]) => {

            // ========================================================
            // BAKE TRANSFORM INTO GEOMETRY
            //
            // 这是有意为之，不是 bug —— 以后看到 Planet 的坐标和 GLB 文件里
            // 对不上，原因就在这里，不要"修回去"。
            //
            // 出厂状态有两个问题：
            //   1. 质心不在原点，偏在 [84, -3, -57]。
            //      直接 scene.add() 的话，donut 整体歪在世界原点旁边一百多单位外。
            //   2. 节点上烘了 Vectorworks 0.1 × Unreal 0.445 的缩放，
            //      最终尺寸 441 单位，没有设计意图。
            //
            // 把「居中 + 等比缩放」直接写进顶点，然后让 terrainRoot 保持单位变换。
            // 好处是之后放文本位置、放钟、算落脚点时，读到的世界坐标
            // 就是眼睛看到的坐标，不用每次再减偏移、再除缩放。
            //
            // 注意：三个轴必须是**同一个 scale**。
            // 之前试过压 Y（FLATTEN_Y）来减轻"碗感"，那是错的 ——
            // Spencer 的 Unreal 参考图确认 donut 的纵横比是设计意图。
            // 局部曲率靠 TIMELESS_FIELD_SIZE 调，不靠变形。
            // ========================================================

            const source = planetGltf.scene;
            source.updateMatrixWorld(true);

            const terrainRoot = new THREE.Group();
            terrainRoot.name = 'TimelessFieldTerrain';

            const meshes = [];
            source.traverse((object) => {
                if (object.isMesh) meshes.push(object);
            });

            // 第一步：把每个 mesh 自己的世界变换烘进几何体，然后平铺到 terrainRoot 下。
            // Vectorworks 导出的那六层空节点（donut field geometry /
            // Vectorworks_Scene_field_geometry / Geometry / Design_Layer_2 / Group）
            // 到这里就没用了。
            meshes.forEach((mesh) => {
                const geometry = mesh.geometry.clone();
                geometry.applyMatrix4(mesh.matrixWorld);

                const flat = new THREE.Mesh(geometry, mesh.material);
                flat.name = mesh.name;

                terrainRoot.add(flat);
            });

            // 第二步：量出现在的包围盒，算居中 + 等比缩放，再烘一次。
            const rawBox = new THREE.Box3().setFromObject(terrainRoot);
            const rawSize = rawBox.getSize(new THREE.Vector3());
            const rawCenter = rawBox.getCenter(new THREE.Vector3());

            const scale = TIMELESS_FIELD_SIZE / Math.max(rawSize.x, rawSize.y, rawSize.z);

            const bake = new THREE.Matrix4()
                .makeScale(scale, scale, scale)
                .multiply(
                    new THREE.Matrix4().makeTranslation(
                        -rawCenter.x,
                        -rawCenter.y,
                        -rawCenter.z,
                    ),
                );

            terrainRoot.children.forEach((mesh) => {
                mesh.geometry.applyMatrix4(bake);
                mesh.geometry.computeBoundingBox();
                mesh.geometry.computeBoundingSphere();
            });

            terrainRoot.position.set(0, 0, 0);
            terrainRoot.scale.setScalar(1);
            terrainRoot.updateMatrixWorld(true);

            // --------------------------------------------------------
            // WORLD ROOT / TERRAIN ROOT 分开
            //
            // TimelessFieldRoot   = 整个世界，负责 visible 开关 + 对齐 Tower 的整体平移。
            // TimelessFieldTerrain = 只有 donut 几何体，专门给
            //                        spawn / teleport raycast 使用。
            // GrassField 永远不能参与 raycast。
            // --------------------------------------------------------

            const fieldRoot = new THREE.Group();
            fieldRoot.name = 'TimelessFieldRoot';

            fieldRoot.add(terrainRoot);

            this.scene.add(fieldRoot);

            this.timelessFieldRoot = fieldRoot;
            this.timelessFieldTerrainRoot = terrainRoot;

            const box = new THREE.Box3().setFromObject(terrainRoot);
            const size = box.getSize(new THREE.Vector3());

            console.log('%c[TimelessField] DONUT BAKED', 'color:#ffcc66;font-weight:bold', {
                rawSize: rawSize.toArray().map((v) => Number(v.toFixed(2))),
                rawCenter: rawCenter.toArray().map((v) => Number(v.toFixed(2))),
                appliedScale: Number(scale.toFixed(5)),
                finalSize: size.toArray().map((v) => Number(v.toFixed(2))),
                finalMin: box.min.toArray().map((v) => Number(v.toFixed(2))),
                finalMax: box.max.toArray().map((v) => Number(v.toFixed(2))),
                meshes: terrainRoot.children.length,
            });

            // ========================================================
            // SPAWN POINT — 从艺术家锚点解析
            //
            // 注意这一步在**平移之前**做，所以解析出来的是 Field 的局部坐标。
            // 撒草也用同一套局部坐标（草是 fieldRoot 的子节点，会跟着一起平移）。
            // ========================================================

            this._resolveSpawnFromAnchor(ACTIVE_SPAWN_ANCHOR, box);

            // ========================================================
            // GRASS
            // ========================================================

            // 撒草中心 = 出生点（局部坐标）。_resolveSpawnFromAnchor() 在上面已经跑过。
            const grass = createGrassField(grassGltf.scene, terrainRoot, {
                ...GRASS_OPTIONS,
                center: this.timelessFieldSpawnLocal,
            });

            if (grass) {
                fieldRoot.add(grass);
                this.grassField = grass;
            }

            // 截断诊断现在由 GrassField.js 自己做（它才知道实际的加权面积）。
            // 看 console 里的 cappedByMaxInstances 字段。

            // ========================================================
            // ALIGN FIELD TO TOWER SPAWN
            //
            // 这是"不再 teleport 参与者"的关键一步：移动世界，不移动人。
            // ========================================================

            this._alignTimelessFieldToTowerSpawn();

            this.applyExperienceState();
            this._checkPhase1Done();

        }).catch((error) => {
            console.error('[TimelessField] Failed to load', error);

            this.loading.fail('field', 'Timeless Field failed to load');
            this.loading.fail('grass', 'Grass clump failed to load');

            this._checkPhase1Done();
        });
    }

    // ========================================================================
    // ALIGN TIMELESS FIELD TO TOWER SPAWN
    //
    // 把整个 timelessFieldRoot 平移，让 SPAWN_ANCHOR 解析出来的落脚点
    // 正好落在参与者在 Clock Tower 里站的地方（世界原点，地面 y = teleportFloorY）。
    //
    //     offset = towerSpawnPosition − fieldSpawnLocalPosition
    //     timelessFieldRoot.position = offset
    //
    // 之后：
    //   - Collapse 不需要移动 XR rig，一帧都不需要
    //   - 塔消失的时候，草已经在脚下了
    //   - dolly.y 保持 floorWorldY，而地形在那里正好是 y = 0，
    //     和 teleport 用的 (terrainY + floorWorldY) 公式自洽
    //
    // 这个平移是**永久**的。Restart 绝对不能撤销它。
    // ========================================================================

    _alignTimelessFieldToTowerSpawn() {
        if (!this.timelessFieldRoot || !this.timelessFieldSpawnLocal) {
            console.warn('[TimelessField] 无法对齐 —— Field 或出生点还没准备好。');
            return;
        }

        const offset = this.towerSpawnPosition.clone().sub(this.timelessFieldSpawnLocal);

        this.timelessFieldAlignOffset.copy(offset);
        this.timelessFieldRoot.position.copy(offset);
        this.timelessFieldRoot.updateMatrixWorld(true);

        // 世界坐标下的出生点 = 局部坐标 + 平移。对齐之后它就等于 Tower 出生点。
        this.timelessFieldOriginPosition = this.timelessFieldSpawnLocal.clone().add(offset);

        console.log(
            '%c[TimelessField] ALIGNED TO TOWER SPAWN — 参与者不需要被 teleport',
            'color:#00ff88;font-weight:bold',
            {
                fieldSpawnLocal: this.timelessFieldSpawnLocal.toArray().map((v) => Number(v.toFixed(2))),
                towerSpawn: this.towerSpawnPosition.toArray().map((v) => Number(v.toFixed(2))),
                appliedOffset: offset.toArray().map((v) => Number(v.toFixed(2))),
                spawnNormalY: Number((this.timelessFieldSpawnNormal?.y ?? 1).toFixed(3)),
            },
        );
    }

    // ========================================================================
    // RESOLVE SPAWN FROM ANCHOR
    //
    // 锚点是归一化的（−1..1，占半径的比例），这里换算成 Field 的局部坐标，
    // 然后从高处向下打一条竖直射线量出真实地面高度。
    //
    // donut 在同一条竖直线上可能有上下两层表面（上缘和下缘），
    // 所以不是简单取第一个 hit，而是取**最接近锚点期望高度**的那一个。
    // 这样 bottom swoop 和上缘可以用同一套逻辑区分。
    //
    // 必须在 _alignTimelessFieldToTowerSpawn() 之前调用 —— 那时 fieldRoot
    // 还在原点，局部坐标 == 世界坐标。
    // ========================================================================

    _resolveSpawnFromAnchor(anchor, terrainBox) {
        const terrain = this.timelessFieldTerrainRoot;

        if (!terrain) {
            console.warn('[Spawn] terrain 还没准备好。');
            return false;
        }

        const box = terrainBox ?? new THREE.Box3().setFromObject(terrain);
        const half = TIMELESS_FIELD_SIZE / 2;

        const worldX = anchor.x * half;
        const worldZ = anchor.z * half;
        const wantY = anchor.y * half;

        const rayHeight = box.max.y + Math.max(10, TIMELESS_FIELD_SIZE * 0.1);

        this.spawnRaycaster.set(
            new THREE.Vector3(worldX, rayHeight, worldZ),
            new THREE.Vector3(0, -1, 0),
        );

        this.spawnRaycaster.near = 0;
        this.spawnRaycaster.far = (rayHeight - box.min.y) + Math.max(10, TIMELESS_FIELD_SIZE * 0.1);

        const hits = this.spawnRaycaster.intersectObject(terrain, true);

        if (hits.length === 0) {
            // 锚点的 x/z 落在 donut 的洞里或者完全在外面。
            // 这时候不要静默兜底到 bbox 顶 —— 那正是旧代码最坑的地方。
            console.error(
                `%c[Spawn] 锚点 (${anchor.x}, ${anchor.z}) 下方没有地面。` +
                `这个 x/z 落在 donut 的洞里或范围外了。` +
                `进 Timeless Field 之后用 panel 上的 "Set Spawn" 重新取一个。`,
                'color:#ff6b6b;font-weight:bold',
            );

            this.timelessFieldSpawnLocal = new THREE.Vector3(worldX, box.max.y, worldZ);
            this.timelessFieldOriginPosition = this.timelessFieldSpawnLocal.clone();
            this.timelessFieldSpawnNormal = new THREE.Vector3(0, 1, 0);

            return false;
        }

        // 挑最接近期望高度的那一层表面。
        let best = hits[0];

        hits.forEach((hit) => {
            if (Math.abs(hit.point.y - wantY) < Math.abs(best.point.y - wantY)) best = hit;
        });

        const normal = best.face
            ? best.face.normal.clone().transformDirection(best.object.matrixWorld).normalize()
            : new THREE.Vector3(0, 1, 0);

        this.timelessFieldSpawnLocal = best.point.clone();
        this.timelessFieldOriginPosition = best.point.clone();
        this.timelessFieldSpawnNormal = normal;

        console.log(
            '%c[Spawn] 解析成功',
            'color:#00ff88;font-weight:bold',
            {
                anchor,
                fieldLocal: best.point.toArray().map((v) => Number(v.toFixed(2))),
                normalY: Number(normal.y.toFixed(3)),
                候选层数: hits.length,
                坡度是否够平: normal.y >= 0.6 ? 'yes' : 'NO — 站上去会是斜的',
            },
        );

        if (normal.y < 0.6) {
            console.warn(
                '[Spawn] 这个落点的坡度偏陡（normal.y < 0.6）。' +
                '人站上去会觉得地面是歪的，建议换一个锚点。',
            );
        }

        return true;
    }

    // ========================================================================
    // SET SPAWN HERE
    //
    // 在头显里用：teleport 到满意的位置 → 扣扳机呼出 panel → 点 Set Spawn。
    // 归一化坐标会直接画在 panel 上，抄下来填进文件顶部的 SPAWN_ANCHOR。
    //
    // 注意 Field 现在被整体平移过（对齐 Tower 出生点），所以这里要先把
    // 世界坐标换算回 Field 的局部坐标再归一化 —— 否则抄出来的锚点会带上
    // 那次平移，下次启动就跑偏了。
    //
    // 桌面上也可以直接 app.setSpawnHere()。
    // ========================================================================

    setSpawnHere() {
        if (!this.timelessFieldTerrainRoot) {
            console.warn('[Spawn] Timeless Field 还没加载完。');
            return null;
        }

        const head = new THREE.Vector3();
        this.camera.getWorldPosition(head);

        // 脚下的地面高度，而不是头的高度。
        this.spawnRaycaster.set(head.clone().setY(head.y + 1), new THREE.Vector3(0, -1, 0));
        this.spawnRaycaster.near = 0;
        this.spawnRaycaster.far = TIMELESS_FIELD_SIZE;

        const hits = this.spawnRaycaster.intersectObject(this.timelessFieldTerrainRoot, true);

        const groundY = hits.length > 0 ? hits[0].point.y : head.y - this.floorWorldY;

        // 世界 → Field 局部
        const local = new THREE.Vector3(head.x, groundY, head.z).sub(this.timelessFieldAlignOffset);

        const half = TIMELESS_FIELD_SIZE / 2;

        const anchor = {
            x: Number((local.x / half).toFixed(3)),
            y: Number((local.y / half).toFixed(3)),
            z: Number((local.z / half).toFixed(3)),
        };

        this.spawnReadout = anchor;

        console.log(
            `%c[Spawn] 把下面这一行填到 app.js 顶部：\n\n` +
            `const SPAWN_ANCHOR = { x: ${anchor.x}, y: ${anchor.y}, z: ${anchor.z} };\n\n` +
            `或者临时用 URL：?spawn=${anchor.x},${anchor.y},${anchor.z}`,
            'color:#ffcc66;font-weight:bold;font-size:13px',
        );

        this._drawPanelBackground();

        return anchor;
    }

    // ========================================================================
    // LOAD SKY
    //
    // 等距柱状星云图，直接当 scene.background。不需要天空球几何体 ——
    // Three.js 内部完成 UV 映射，所以 Spencer 不用管接缝怎么贴到球上。
    //
    // mipmap 必须开。天顶方向等距柱状投影的纹素挤压最厉害，
    // 关掉 mipmap 就是每个屏幕像素随机抽一个纹素 —— 静止看是噪点，
    // 转头看是满天闪烁。省的那点显存不值得。
    //
    // 前提是贴图里不能有 1–2 像素的星点。4096 宽铺满 360° 只有每度 11 像素，
    // 而 Quest 3 是每度 20+，单像素星点必然被放大成色块。
    // 星点要画到至少 6 px 直径 —— 这条对以后每一张全景贴图都适用。
    //
    // 注意 scene.background 不受 fog 影响，所以远处地面会被雾吃掉、
    // 天空仍然是清晰的 —— 这正是想要的效果。
    // ========================================================================

    loadSky() {
        const loader = new THREE.TextureLoader();
        const skyUrl = `${import.meta.env.BASE_URL}textures/sky.jpg`;

        loader.load(
            skyUrl,

            (texture) => {
                texture.mapping = THREE.EquirectangularReflectionMapping;
                texture.colorSpace = THREE.SRGBColorSpace;

                texture.generateMipmaps = true;
                texture.minFilter = THREE.LinearMipmapLinearFilter;
                texture.magFilter = THREE.LinearFilter;
                texture.anisotropy = this.renderer.capabilities.getMaxAnisotropy();

                this.skyTexture = texture;

                const [w, h] = [texture.image.width, texture.image.height];

                console.log('%c[Sky] LOADED', 'color:#66ccff;font-weight:bold', {
                    size: [w, h],
                    ratio: Number((w / h).toFixed(3)),
                    anisotropy: texture.anisotropy,
                    每度像素: Number((w / 360).toFixed(1)),
                });

                if (Math.abs(w / h - 2) > 0.01) {
                    console.warn(
                        `[Sky] 比例是 ${(w / h).toFixed(3)}，等距柱状图必须是 2:1。` +
                        `现在这张会被拉伸。`,
                    );
                }

                // 如果这时候已经在 Timeless Field 里了，立刻换上去。
                this.applyExperienceState();

                this.loading.setProgress('sky', 1);
                this._checkPhase1Done();
            },

            (xhr) => {
                const { p, text } = estimateProgress(xhr);

                this.loading.setProgress('sky', p, text);
            },

            (error) => {
                console.error('[Sky] Failed to load', error);

                this.loading.fail('sky', 'Nebula sky failed to load');
                this._checkPhase1Done();
            },
        );
    }

    // ========================================================================
    // SET EXPERIENCE STATE
    //
    // 不再在这里 teleport 参与者。Timeless Field 已经在加载时就被平移到
    // 参与者脚下，所以进入 TIMELESS_FIELD 只是一次 visibility 切换。
    // ========================================================================

    setExperienceState(nextState, reason = 'manual') {
        const validStates = Object.values(EXPERIENCE_STATE);

        if (!validStates.includes(nextState)) {
            console.warn('[State] Invalid state:', nextState);
            return false;
        }

        // 如果已经在这个 state，仍然重新 apply visibility。
        if (nextState === this.experienceState) {
            this.applyExperienceState();
            return true;
        }

        const previous = this.experienceState;

        this.previousExperienceState = previous;
        this.experienceState = nextState;

        console.log(
            `%c[State] ${previous} -> ${nextState}`,
            'color:#66ccff;font-weight:bold',
            `reason=${reason}`,
        );

        this.applyExperienceState();

        return true;
    }

    // ========================================================================
    // APPLY EXPERIENCE STATE
    //
    // COLLAPSE 是唯一一个**两个世界同时可见**的 state：
    // 塔还在（正在解体），Timeless Field 已经在它后面/脚下。
    // ========================================================================

    applyExperienceState() {
        const state = this.experienceState;

        // CLOCK TOWER VISIBILITY
        const towerVisible = [
            EXPERIENCE_STATE.INTRO,
            EXPERIENCE_STATE.READ_NOTES,
            EXPERIENCE_STATE.SPECIAL_CLOCK,
            EXPERIENCE_STATE.COLLAPSE,
            EXPERIENCE_STATE.FINAL_TOWER,
            EXPERIENCE_STATE.END,
        ].includes(state);

        // TIMELESS FIELD VISIBILITY
        const timelessVisible = [
            EXPERIENCE_STATE.COLLAPSE,
            EXPERIENCE_STATE.TIMELESS_FIELD,
            EXPERIENCE_STATE.RETURN,
        ].includes(state);

        // APPLY
        if (this.towerRoot) this.towerRoot.visible = towerVisible;
        if (this.timelessFieldRoot) this.timelessFieldRoot.visible = timelessVisible;
        if (this.fieldLamp) this.fieldLamp.visible = timelessVisible;

        // ------------------------------------------------------------
        // CLOCK VISUALS
        //
        // 只控制**视觉**。Clock 的音频链路和这里完全无关 ——
        // AudioBufferSourceNode 从 Start 到 Restart 之间一次都不会被 stop()。
        // Timeless Field 里是 18 个看不见但一直在动的声源。
        // ------------------------------------------------------------

        if (this.clockRegistry) {
            this.clockRegistry.forEach((clockData) => {
                clockData.visualObject.visible = towerVisible;
            });
        }

        // ------------------------------------------------------------
        // DEBUG HELPERS
        //
        // Tower 段的调试地板/网格必须在 Collapse 一开始就关掉，
        // 否则那块 200×200 的平面正好挡在草和参与者之间 ——
        // "塔散开露出草地"就变成"塔散开露出灰色平面"。
        // ------------------------------------------------------------

        const debugVisible = !timelessVisible;

        if (this.debugHelpers) {
            this.debugHelpers.forEach((object) => { object.visible = debugVisible; });
        }

        // ------------------------------------------------------------
        // BACKGROUND
        //
        // 星云贴图可能还没下载完 —— 那就先留着 Tower 的底色，
        // loadSky() 完成时会再调一次 applyExperienceState() 补上。
        // ------------------------------------------------------------

        if (timelessVisible && this.skyTexture) {
            this.scene.background = this.skyTexture;
        } else {
            this.scene.background = this.towerBackground;
        }

        // ------------------------------------------------------------
        // LIGHTING
        //
        // Collapse 期间灯光从 Tower 渐变到 Field，插值量由 collapseProgress 给。
        // 直接跳到 Field 灯光（例如键盘 4）时就是 1。
        // ------------------------------------------------------------

        const blend = state === EXPERIENCE_STATE.COLLAPSE
            ? (this.collapseProgress || 0)
            : (timelessVisible ? 1 : 0);

        this._applyLightingBlend(blend);

        // 场景渐入。Collapse 开始时从 0 起（由 updateCollapse 每帧推进），
        // 键盘直接跳到 Field / Return、或者回到 Tower 时都是立即到位。
        this._applySceneReveal(
            state === EXPERIENCE_STATE.COLLAPSE ? (this.sceneReveal ?? 0) : 1,
        );

        this._updateCollapseButtonVisibility();

        console.log('[State visuals]', {
            state, towerVisible, timelessVisible, clocks: this.clockRegistry?.length ?? 0,
        });
    }

    // ========================================================================
    // LIGHTING BLEND
    //
    // k = 0 → Clock Tower（室内、有环境反弹、白光）
    // k = 1 → Timeless Field（巨大 donut 表面，环境光来自星云，很暗；
    //         真正的光源是挂在 dolly 上的 fieldLamp）
    //
    // 雾的密度直接决定"这个世界有多大"：
    // 0.012 时可见度约 85 米，在 300 米的 donut 上等于把远处全吃掉，
    // 巨物感消失。0.004 ≈ 250 米可见度，远处表面会慢慢卷起来。
    // Collapse 期间从 0 渐入到 0.004，塔只有 14 米，几乎不受影响。
    // ========================================================================

    _applyLightingBlend(k) {
        const t = Math.max(0, Math.min(1, k));

        this.lightingBlend = t;

        // HEMISPHERE
        this.hemiLight.color.copy(TOWER_HEMI_SKY).lerp(FIELD_HEMI_SKY, t);
        this.hemiLight.groundColor.copy(TOWER_HEMI_GROUND).lerp(FIELD_HEMI_GROUND, t);
        this.hemiLight.intensity = THREE.MathUtils.lerp(0.6, 0.35, t);

        // DIRECTIONAL
        this.dirLight.color.copy(TOWER_DIR_COLOR).lerp(FIELD_DIR_COLOR, t);
        this.dirLight.intensity = THREE.MathUtils.lerp(2, 0.15, t);

        this.dirLight.position.set(
            THREE.MathUtils.lerp(1, -0.4, t),
            THREE.MathUtils.lerp(3, 0.8, t),
            THREE.MathUtils.lerp(2, 0.3, t),
        ).normalize();

        // FOG
        if (t <= 0.001) {
            this.scene.fog = null;
        } else {
            this.fieldFog.density = 0.004 * t;
            this.scene.fog = this.fieldFog;
        }
    }

    // ========================================================================
    // SCENE REVEAL
    //
    // k = 0 → 星空全黑、身边的灯灭着（看上去还是 Tower 的底色）
    // k = 1 → 星空正常亮度、灯正常强度
    //
    // 用 scene.backgroundIntensity 而不是加一个天空球：不多 draw call，
    // 也不动 loadSky() 的任何逻辑。Tower 的底色 0x101820 本来就接近纯黑，
    // 所以 Collapse 第一帧从"底色"切到"亮度 0 的星空"肉眼看不出来。
    //
    // backgroundIntensity 对颜色背景无效（Three 只在贴图分支里用它），
    // 所以星空还没下载完时这里是安全的 no-op。
    // ========================================================================

    _applySceneReveal(k) {
        const t = Math.max(0, Math.min(1, k));

        this.sceneReveal = t;

        if ('backgroundIntensity' in this.scene) this.scene.backgroundIntensity = t;

        if (this.fieldLamp) this.fieldLamp.intensity = FIELD_LAMP_INTENSITY * t;
    }

    // ========================================================================
    // TELEPORT PLAYER TO TIMELESS FIELD ORIGIN  —— 已废弃
    //
    // Collapse 不再移动参与者。Timeless Field 在加载时就被整体平移，
    // 让出生点落在参与者站的地方（见 _alignTimelessFieldToTowerSpawn）。
    //
    // 保留这个函数只是为了不破坏可能还引用它的旧代码 / console 调试习惯。
    // 正常流程里没有任何地方会调用它。
    // ========================================================================

    teleportPlayerToTimelessOrigin() {
        console.warn(
            '[TimelessField] teleportPlayerToTimelessOrigin 已废弃 —— ' +
            'Field 已经对齐到 Tower 出生点，Collapse 不需要移动参与者。',
        );
    }

    // ========================================================================
    // DEBUG STATE KEYS
    //
    // Desktop: 0 Intro / 1 Tower / 2 Special / 3 Collapse / 4 Field / 5 Return / 6 Final Tower
    //          C = 触发 Collapse（和世界里那个红按钮走同一个入口）
    //          S = Set Spawn（在 Timeless Field 里按，读出归一化锚点）
    // ========================================================================

    setupDebugStateControls() {
        window.addEventListener('keydown', (event) => {
            // 模式还没选完之前不响应，避免在加载界面上误触。
            if (!this.runtimeMode) return;

            if (event.key === 's' || event.key === 'S') {
                this.setSpawnHere();
                return;
            }

            if (event.key === 'c' || event.key === 'C') {
                this.startCollapse('keyboard C');
                return;
            }

            const stateByKey = {
                '0': EXPERIENCE_STATE.INTRO,
                '1': EXPERIENCE_STATE.READ_NOTES,
                '2': EXPERIENCE_STATE.SPECIAL_CLOCK,
                '3': EXPERIENCE_STATE.COLLAPSE,
                '4': EXPERIENCE_STATE.TIMELESS_FIELD,
                '5': EXPERIENCE_STATE.RETURN,
                '6': EXPERIENCE_STATE.FINAL_TOWER,
            };

            const targetState = stateByKey[event.key];

            if (targetState) {
                this.setExperienceState(targetState, `keyboard ${event.key}`);
            }
        });

        console.log(
            '[State keys] 0 Intro | 1 Tower | 2 Special | 3 Collapse | 4 Field | 5 Return | 6 Final Tower | C Collapse | S Set Spawn',
        );
    }

    // ========================================================================
    // TEMPORARY AUTOMATIC TEST
    //
    // DEBUG_AUTO_STATE_TEST = false 时整段是 no-op。
    // Michigan demo 期间必须保持关闭：Collapse 只能由按钮触发。
    // ========================================================================

    updateDebugStateSequence() {
        if (!DEBUG_AUTO_STATE_TEST || !this.running || !this.timelineStarted) return;

        const t = this.getTimelineTime();

        // 5 秒后进 Timeless Field，之后不再自动切走。
        const targetState = t >= 5
            ? EXPERIENCE_STATE.TIMELESS_FIELD
            : EXPERIENCE_STATE.READ_NOTES;

        if (targetState !== this.experienceState) {
            this.setExperienceState(targetState, `auto test ${t.toFixed(2)} sec`);
        }
    }

    // ========================================================================
    // SCENE
    // ========================================================================

    initScene() {
        // ORIGIN DEBUG
        const originMarker = new THREE.Mesh(
            new THREE.SphereGeometry(0.12, 16, 16),
            new THREE.MeshBasicMaterial({ color: 0xffff00 }),
        );
        originMarker.position.set(0, 0, 0);
        this.scene.add(originMarker);

        const axesHelper = new THREE.AxesHelper(3);
        this.scene.add(axesHelper);

        // FOG
        this.scene.fog = null;

        // GROUND
        const ground = new THREE.Mesh(
            new THREE.PlaneGeometry(200, 200),
            new THREE.MeshPhongMaterial({ color: 0x1a2030, depthWrite: false }),
        );
        ground.rotation.x = -Math.PI / 2;
        this.scene.add(ground);
        this.debugGround = ground;

        // GRID
        const grid = new THREE.GridHelper(200, 40, 0x334466, 0x222233);
        grid.material.opacity = 0.5;
        grid.material.transparent = true;
        this.scene.add(grid);
        this.debugGrid = grid;

        // ORIGIN RING
        const ring = new THREE.Mesh(
            new THREE.RingGeometry(0.3, 0.35, 32),
            new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, opacity: 0.25, transparent: true }),
        );
        ring.rotation.x = -Math.PI / 2;
        ring.position.set(0, 0.01, 0);
        this.scene.add(ring);

        // ------------------------------------------------------------
        // 所有调试辅助物集中管理。
        // Collapse 一开始就要全部关掉 —— 那块地板会挡住脚下的草。
        // ------------------------------------------------------------

        this.debugHelpers = [originMarker, axesHelper, ground, grid, ring];

        // TELEPORT MARKER
        const markerGeo = new THREE.RingGeometry(0.32, 0.48, 48);
        const markerMat = new THREE.MeshBasicMaterial({
            color: 0x00ff88, side: THREE.DoubleSide, transparent: true, opacity: 1, depthTest: false, depthWrite: false,
        });

        this.teleportMarker = new THREE.Mesh(markerGeo, markerMat);
        this.teleportMarker.rotation.x = -Math.PI / 2;
        this.teleportMarker.renderOrder = 1000;
        this.teleportMarker.visible = false;
        this.scene.add(this.teleportMarker);

        // WORLD-SPACE COLLAPSE BUTTON
        this._createCollapseButton();
    }

    // ========================================================================
    // WORLD-SPACE COLLAPSE BUTTON
    //
    // 真正的世界空间物体，不在 pause menu 里，也不挂在 dolly 上。
    // 站在出生点正前方 1.7 米、视线略下方。
    //
    // 复用现有的按钮外观（makeButtonMesh）和现有的控制器射线系统 ——
    // 没有第二套 interaction。区别只是它进的是 this.worldInteractables，
    // 而 _castController() 在 panel 没显示时会去打这个列表。
    // ========================================================================

    _createCollapseButton() {
        const button = makeButtonMesh('COLLAPSE', 205, 60, 60, 0.52, 0.175);

        button.userData.action = 'collapse';
        button.userData.isWorldButton = true;

        // depthTest 已经是 false（makeButtonMesh 的 UI 材质），
        // renderOrder 抬高保证它画在塔和草之前。
        button.renderOrder = 1500;

        button.position.set(
            this.towerSpawnPosition.x,
            this.towerSpawnPosition.y + this.floorWorldY + this.eyeHeight + COLLAPSE_BUTTON_EYE_OFFSET,
            this.towerSpawnPosition.z - COLLAPSE_BUTTON_DISTANCE,
        );

        button.visible = false;

        this.scene.add(button);

        this.collapseButton = button;
        this.worldInteractables = [button];
    }

    _updateCollapseButtonVisibility() {
        if (!this.collapseButton) return;

        const towerPhase = [
            EXPERIENCE_STATE.INTRO,
            EXPERIENCE_STATE.READ_NOTES,
            EXPERIENCE_STATE.SPECIAL_CLOCK,
        ].includes(this.experienceState);

        const visible = Boolean(
            this.timelineStarted &&
            towerPhase &&
            !this.collapseActive &&
            !this.collapseCompleted,
        );

        if (this.collapseButton.visible === visible) return;

        this.collapseButton.visible = visible;

        if (!visible) {
            this._setButtonVisual(this.collapseButton, 'normal');

            this.ctrlState?.forEach((state) => {
                if (state.pressedBtn === this.collapseButton) state.pressedBtn = null;
                if (state.hoveredBtn === this.collapseButton) state.hoveredBtn = null;
            });
        }
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
    // SETUP FIXED DRONES
    //
    // 只建立 spatial chain。文件下载/decode 由 _downloadAudio() / _enterStandaloneMode() 负责。
    // relativeOffset 在体验开始时才能算（那时才知道听者在哪），见 _captureDroneOffsets()。
    // ========================================================================

    setupDrones() {
        this.droneRegistry = DRONE_CONFIG.map((config) => {
            const audioNode = createDroneSpatialChain(this.masterGain, config.position, config.gain);

            return {
                name: config.name,
                position: config.position.clone(),       // 初始世界坐标（只用来反算偏移）
                relativeOffset: new THREE.Vector3(),     // 相对听者的固定偏移
                worldPosition: config.position.clone(),  // 每帧算出来的实际坐标
                audioBuffer: null,                       // 由 _bindAudioBuffers() 填入
                audioNode,
                loop: config.loop,
            };
        });

        this.droneOffsetsReady = false;
    }

    // ========================================================================
    // CAPTURE DRONE OFFSETS
    //
    //     relativeOffset = droneInitialWorldPosition − listenerInitialWorldPosition
    //
    // 之后每帧 droneWorldPosition = currentListenerPosition + relativeOffset。
    // 跟随参与者的**平移**，不跟随头的旋转 —— Drone 仍然是真实空间声源，
    // 转头时方向会正确改变，绝不是 head-locked。
    // ========================================================================

    _captureDroneOffsets() {
        if (!this.droneRegistry?.length) return;

        const listener = new THREE.Vector3();
        this.camera.getWorldPosition(listener);

        this.droneRegistry.forEach((droneData) => {
            droneData.relativeOffset.copy(droneData.position).sub(listener);
            droneData.worldPosition.copy(droneData.position);
        });

        this.droneOffsetsReady = true;

        console.log(
            '[Drone] Captured participant-relative offsets',
            {
                listener: listener.toArray().map((v) => Number(v.toFixed(2))),
                offsets: this.droneRegistry.map((d) => ({
                    name: d.name,
                    offset: d.relativeOffset.toArray().map((v) => Number(v.toFixed(2))),
                })),
            },
        );
    }

    // ========================================================================
    // CREATE & SCHEDULE ALL AUDIO SOURCES
    //
    // AudioBufferSourceNode 是 one-shot，所以第一次按 Start 的时候才真正创建所有 source。
    // 这些 source 在整个体验期间**一次都不会被 stop()** —— Collapse 只改 panner 坐标。
    // ========================================================================

    _createAndScheduleClockSources(startAt) {
        this.clockRegistry.forEach((clockData) => {
            if (!clockData.audioBuffer) return;

            const source = audioCtx.createBufferSource();
            source.buffer = clockData.audioBuffer;
            source.connect(clockData.audioNode.gain);

            // 最重要的同步点：每一个音频都收到完全相同的 startAt。
            source.start(startAt, 0);
            clockData.audioNode.source = source;
        });
    }

    // ========================================================================
    // CREATE & SCHEDULE FIXED DRONE SOURCES
    // ========================================================================

    _createAndScheduleDroneSources(startAt) {
        this.droneRegistry.forEach((droneData) => {
            if (!droneData.audioBuffer) return;

            const source = audioCtx.createBufferSource();
            source.buffer = droneData.audioBuffer;
            source.loop = droneData.loop;   // 短 drone 可以一直 loop
            source.connect(droneData.audioNode.gain);

            // 和所有 Clock 完全相同的 AudioContext timestamp
            source.start(startAt, 0);
            droneData.audioNode.source = source;
        });
    }

    // ========================================================================
    // MASTER TIMELINE TIME
    // ========================================================================

    getTimelineTime() {
        if (!this.timelineStarted || this.timelineStartAt === null) return 0;

        // AudioContext.currentTime 是真正的作品 master clock。
        // 两种模式都用它 —— Michigan 模式下它只是个时钟，不出声。
        return Math.max(0, audioCtx.currentTime - this.timelineStartAt);
    }

    // ========================================================================
    // START / RESUME
    // ========================================================================

    async startAudio() {
        if (this.running) return;

        if (!this.runtimeMode) {
            console.warn('[Timeline] Runtime mode not selected yet — refusing to start.');
            return;
        }

        // ------------------------------------------------------------
        // STANDALONE: Quest local audio 必须完全就绪才能播。
        // MICHIGAN:   Quest 不是音频渲染端，不能因为本地 MP3 没好就挡住作品时间轴。
        // ------------------------------------------------------------

        if (this.localAudioEnabled && (!this.audioReady || !this.droneReady)) {
            console.warn('[Audio] Clock stems or Drone sources are not ready yet.');
            console.log('Clock errors:', this.audioLoadErrors);
            console.log('Drone errors:', this.droneLoadErrors);
            return;
        }

        // MASTER TIMELINE CLOCK
        //
        // 两种模式都需要 resume AudioContext，因为 AudioContext.currentTime 是我们目前的 master clock。
        await audioCtx.resume();

        // FIRST START ONLY
        if (!this.timelineStarted) {
            const startAt = audioCtx.currentTime + 0.12;
            this.timelineStartAt = startAt;

            // Drone 的相对偏移在这里定下来：此刻参与者的位置就是参照原点。
            this._captureDroneOffsets();

            if (this.localAudioEnabled) {
                // STANDALONE AUDIO
                this._createAndScheduleClockSources(startAt);
                this._createAndScheduleDroneSources(startAt);
            } else {
                // 没有 Quest-local audio playback，共享作品时间轴仍照常开始。
                console.log(
                    `[Timeline] Master timeline started. Quest local audio bypassed (mode=${MODE_LABEL[this.runtimeMode]}).`,
                );
            }

            this.timelineStarted = true;

            // EXPERIENCE START
            this.setExperienceState(EXPERIENCE_STATE.READ_NOTES, 'master timeline started');

            console.log(`%c[Timeline] START scheduled at ${startAt.toFixed(3)}`, 'color:#00ff88');
        }

        this.running = true;

        this._updateCollapseButtonVisibility();
        this._refreshPanel();
        this.hideVRPanel();
    }

    // ========================================================================
    // PAUSE
    // ========================================================================

    async stopAudio() {
        if (!this.running) return;

        await audioCtx.suspend();
        this.running = false;
        this._refreshPanel();

        console.log(`[Timeline] Paused at ${this.getTimelineTime().toFixed(3)} sec`);
    }

    // ========================================================================
    // COLLAPSE — 唯一入口
    //
    // 世界空间的 COLLAPSE 按钮和键盘 C 都走这里。
    // 防重入：collapseActive / collapseCompleted 任一为真就直接返回。
    // ========================================================================

    startCollapse(reason = 'collapse button') {
        if (this.collapseActive) {
            console.log('[Collapse] 已经在进行中 — 忽略重复触发。');
            return false;
        }

        if (this.collapseCompleted) {
            console.log('[Collapse] 这一轮已经塌过了 — 需要 Restart 才能再来一次。');
            return false;
        }

        if (!this.timelineStarted) {
            console.warn('[Collapse] 时间轴还没开始 — 先按 Start。');
            return false;
        }

        this._prepareCollapse();

        this.collapseActive = true;
        this.collapseStartTime = this.getTimelineTime();
        this.collapseProgress = 0;

        // 场景渐入必须从 0 重新开始 —— 第二条 take 的时候它还停在 1。
        this.sceneReveal = 0;

        // 状态先切过去：Tower 和 Timeless Field 从这一帧起同时可见。
        this.setExperienceState(EXPERIENCE_STATE.COLLAPSE, reason);

        console.log(
            `%c[Collapse] START — ${COLLAPSE_DURATION}s, mode=${this.towerCollapseMode}, ` +
            `pieces=${this.towerCollapsePieces.length}, reason=${reason}`,
            'color:#ff8866;font-weight:bold;font-size:13px',
        );

        return true;
    }

    // ------------------------------------------------------------
    // 准备工作：记录融化起点、收掉按钮。
    //
    // 这里**不做任何 clone / 分配**。材质在加载期就已经 clone 完了
    // （见 loadClockModel 和 _buildTowerCollapseRegistry），
    // 按下按钮的那一帧必须是干净的，否则 3.5 秒动画开头就是一个卡顿。
    // ------------------------------------------------------------

    _prepareCollapse() {
        // 按钮立刻消失，避免第二次点击。
        if (this.collapseButton) {
            this.collapseButton.visible = false;
            this._setButtonVisual(this.collapseButton, 'normal');
        }

        this.ctrlState?.forEach((state) => {
            if (state.pressedBtn === this.collapseButton) state.pressedBtn = null;
        });

        // 融化的起点 = 当前视觉位置（钟这时候可能已经在轨道上飞了）。
        this.clockRegistry?.forEach((clockData) => {
            clockData.meltBasePosition.copy(clockData.visualObject.position);
        });

        this.collapsePrepared = true;
    }

    // ------------------------------------------------------------
    // 每帧推进。由 render() 调用，不是第二个 animation loop。
    // ------------------------------------------------------------

    updateCollapse() {
        if (!this.collapseActive) return;
        if (!this.running) return;   // 暂停时冻结，和音频保持一致

        const elapsed = Math.min(
            COLLAPSE_DURATION,
            Math.max(0, this.getTimelineTime() - this.collapseStartTime),
        );

        this.collapseProgress = elapsed / COLLAPSE_DURATION;

        // 灯光 / 雾 / 从塔渐变到旷野
        this._applyLightingBlend(THREE.MathUtils.smoothstep(this.collapseProgress, 0, 1));

        // 星空 + 身边那盏灯的渐入。和上面的灯光插值是两条独立曲线：
        // 灯光跟着整个 12 秒走，场景渐入只有前 4 秒。
        this._applySceneReveal(
            THREE.MathUtils.smoothstep(elapsed, 0, COLLAPSE_REVEAL_DURATION),
        );

        this._updateTowerCollapse(elapsed);
        this._updateClockMelt(elapsed);

        if (elapsed >= COLLAPSE_DURATION) this._finishCollapse();
    }

    _finishCollapse() {
        this.collapseActive = false;
        this.collapseCompleted = true;
        this.collapseProgress = 1;

        // 塔和钟的视觉在这里彻底交给 state machine 处理。
        this.setExperienceState(EXPERIENCE_STATE.TIMELESS_FIELD, 'collapse complete');

        console.log(
            '%c[Collapse] DONE — Tower hidden, clocks invisible, 18 个声源仍在参与者周围运动。',
            'color:#00ff88;font-weight:bold',
        );
    }

    // ------------------------------------------------------------
    // TOWER ARCHITECTURE
    //
    // 0.0–0.5  轻微震动（构件还在原位）
    // 0.5–3.5  向外加速飞出 + 旋转，stagger 让它们不是同一帧一起动
    // 2.3–3.5  淡出
    // ------------------------------------------------------------

    _updateTowerCollapse(elapsed) {
        const pieces = this.towerCollapsePieces;

        if (!pieces?.length) return;

        // 震动幅度：0 → COLLAPSE_SHAKE_END 之间起来，然后在同样长的时间里退掉。
        // 退得慢一点是有意的 —— 构件是在这段时间里陆续松脱的，
        // 还没走的那些应该还在轻微发抖。
        const shakeEnvelope = elapsed < COLLAPSE_SHAKE_END
            ? elapsed / COLLAPSE_SHAKE_END
            : Math.max(0, 1 - (elapsed - COLLAPSE_SHAKE_END) / COLLAPSE_SHAKE_END);

        const fadeAlpha = 1 - THREE.MathUtils.smoothstep(
            elapsed,
            COLLAPSE_TOWER_FADE_START,
            COLLAPSE_DURATION,
        );

        if (this.towerCollapseMode === 'monolith') {
            // ------------------------------------------------------------
            // MONOLITH 兜底：塔是一整块，不假装能炸碎。
            // 整体轻微震动 → 缓慢下沉并略微放大 → 淡出。
            // ------------------------------------------------------------

            pieces.forEach((piece) => {
                const te = Math.max(0, elapsed - COLLAPSE_SHAKE_END);
                const sinkProgress = THREE.MathUtils.smoothstep(te, 0, COLLAPSE_DURATION - COLLAPSE_SHAKE_END);

                const shakeX = Math.sin(elapsed * 47 + piece.phase) * piece.shakeLocal * shakeEnvelope;
                const shakeY = Math.sin(elapsed * 53 + piece.phase * 1.7) * piece.shakeLocal * shakeEnvelope;
                const shakeZ = Math.sin(elapsed * 41 + piece.phase * 2.3) * piece.shakeLocal * shakeEnvelope;

                // 下沉 4 米（换算成构件自己的 local unit）。
                const sinkLocal = sinkProgress * 4.0 * piece.localPerMeter;

                piece.object.position.set(
                    piece.originalPosition.x + shakeX,
                    piece.originalPosition.y + shakeY - sinkLocal,
                    piece.originalPosition.z + shakeZ,
                );

                const grow = 1 + sinkProgress * 0.06;

                piece.object.scale.set(
                    piece.originalScale.x * grow,
                    piece.originalScale.y * grow,
                    piece.originalScale.z * grow,
                );
            });
        } else {
            pieces.forEach((piece) => {
                const te = Math.max(0, elapsed - COLLAPSE_SHAKE_END - piece.stagger);

                // 位移 = 速度 × 缓入后的时间。
                //
                //     ease(t) = t² / (t + τ)
                //
                // t 很小时 ≈ t²/τ（起步柔和，不会"弹"出去），
                // t 变大之后斜率趋近 1（匀速漂移）。
                // 用加速度的话末段会越来越快，那正是"被炸开"的读法。
                const ease = (te * te) / (te + COLLAPSE_DRIFT_EASE_TAU);
                const distance = piece.driftLocal * ease;
                const shakeX = Math.sin(elapsed * 47 + piece.phase) * piece.shakeLocal * shakeEnvelope;
                const shakeY = Math.sin(elapsed * 53 + piece.phase * 1.7) * piece.shakeLocal * shakeEnvelope;
                const shakeZ = Math.sin(elapsed * 41 + piece.phase * 2.3) * piece.shakeLocal * shakeEnvelope;

                piece.object.position.set(
                    piece.originalPosition.x + piece.dirLocal.x * distance + shakeX,
                    piece.originalPosition.y + piece.dirLocal.y * distance + shakeY,
                    piece.originalPosition.z + piece.dirLocal.z * distance + shakeZ,
                );

                if (te > 0) {
                    this._tmpQuat.setFromAxisAngle(piece.axis, piece.angularSpeed * te);
                    piece.object.quaternion.copy(piece.originalQuaternion).multiply(this._tmpQuat);
                }

                // ------------------------------------------------------------
                // 逐片淡出。
                //
                // 起点 = 它自己走完四分之一行程的时刻，终点 = 它自己飞行的终点。
                // 所以先松脱的片子先开始变淡，一边继续飞远一边继续变淡；
                // 后松脱的还是实心的。任何一帧画面里都同时有实心和半透明的构件。
                //
                // 之前是全体共用一条曲线挤在最后一起淡，那才是"啪一下没了"。
                // ------------------------------------------------------------

                if (piece.fadeEntries?.length) {
                    const alpha = 1 - THREE.MathUtils.smoothstep(
                        te,
                        piece.flightDuration * COLLAPSE_PIECE_FADE_START_F,
                        piece.flightDuration,
                    );

                    setFadeAlpha(piece.fadeEntries, alpha);
                }
            });
        }

        // monolith 兜底路径只有一整块东西，没有"各自"可言，用全局曲线。
        if (this.towerCollapseMode === 'monolith' && this.towerFadeEntries?.length) {
            setFadeAlpha(this.towerFadeEntries, fadeAlpha);
        }
    }

    // ------------------------------------------------------------
    // CLOCK VISUAL MELT
    //
    // 0.7–1.5  软化：Y 压扁、XZ 微胀
    // 1.5–3.0  继续压扁、下沉、透明度到 0
    // 3.0      visible = false
    //
    // 音频完全不受影响 —— 这里一个字都没碰 audioNode。
    // ------------------------------------------------------------

    _updateClockMelt(elapsed) {
        if (!this.clockRegistry?.length) return;

        const soften = THREE.MathUtils.smoothstep(
            elapsed,
            COLLAPSE_MELT_SOFTEN_START,
            COLLAPSE_MELT_SOFTEN_END,
        );

        const sink = THREE.MathUtils.smoothstep(
            elapsed,
            COLLAPSE_MELT_SOFTEN_END,
            COLLAPSE_MELT_SINK_END,
        );

        // 1 → 0.75 → 0.05
        const scaleY = 1 - 0.25 * soften - 0.70 * sink;

        // 1 → 1.12 → 1.35（塌下去的时候往两边摊开）
        const scaleXZ = 1 + 0.12 * soften + 0.23 * sink;

        const alpha = 1 - sink;
        const gone = elapsed >= COLLAPSE_MELT_SINK_END;

        this.clockRegistry.forEach((clockData) => {
            const object = clockData.visualObject;

            object.scale.set(
                clockData.originalScale.x * scaleXZ,
                clockData.originalScale.y * scaleY,
                clockData.originalScale.z * scaleXZ,
            );

            object.position.set(
                clockData.meltBasePosition.x,
                clockData.meltBasePosition.y - clockData.clockHeight * 0.65 * sink,
                clockData.meltBasePosition.z,
            );

            if (clockData.fadeEntries) setFadeAlpha(clockData.fadeEntries, alpha);

            if (gone && object.visible) object.visible = false;
        });
    }

    // ------------------------------------------------------------
    // CLOCK AUDIO BLEND
    //
    // 0 = 塔内轨迹（绕世界原点）
    // 1 = 以参与者为中心的轨道
    //
    // Collapse 期间平滑过渡，不是瞬间跳过去。
    // 键盘直接跳到 Field / Return 时也是 1。
    // ------------------------------------------------------------

    _clockAudioBlend() {
        if (this.collapseActive) {
            const elapsed = Math.max(0, this.getTimelineTime() - this.collapseStartTime);

            return THREE.MathUtils.smoothstep(
                elapsed,
                COLLAPSE_AUDIO_BLEND_START,
                COLLAPSE_AUDIO_BLEND_END,
            );
        }

        if (this.collapseCompleted) return 1;

        return [
            EXPERIENCE_STATE.TIMELESS_FIELD,
            EXPERIENCE_STATE.RETURN,
        ].includes(this.experienceState) ? 1 : 0;
    }

    // ------------------------------------------------------------
    // PARTICIPANT-CENTERED ORBIT
    //
    // 轨道中心 = 听者当前世界位置（只有平移）。
    // 角度只跟时间有关，和头的朝向无关 —— 所以转头的时候
    // 原本在正前方的声源会正确地跑到侧面/背后。绝不是 head-locked。
    // ------------------------------------------------------------

    _clockOrbitPosition(clockData, listener, tt, out) {
        const group = clockData.orbitGroup;

        const radius = CLOCK_ORBIT_RADII[group];
        const relativeHeight = CLOCK_ORBIT_HEIGHTS[group];

        const orbitTime = Math.max(0, tt - 1);
        const angle = clockData.orbitAngleOffset + orbitTime * CLOCK_ORBIT_SPEED;

        const floatingY = Math.sin(orbitTime * 2.5 + clockData.index * 0.7) * 0.8;

        return out.set(
            listener.x + Math.cos(angle) * radius,
            listener.y + relativeHeight + floatingY,
            listener.z + Math.sin(angle) * radius,
        );
    }

    // ========================================================================
    // AUDIO LISTENER
    //
    // Listener = 玩家头的位置和朝向，Clock Panner = 声源位置。
    // Web Audio 根据这两者的相对位置计算 HRTF。
    // Michigan 模式下没有本地声源，更新 listener 没有意义，直接跳过省一点每帧开销。
    // ========================================================================

    updateAudioListener() {
        if (!this.localAudioEnabled) return;

        const pos = this._listenerWorld;
        const fwd = this._tmpVecA;

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
    //
    // 视觉和音频在这里彻底分开：
    //
    //   visualObject.position  只在**没有在融化**的时候由塔内轨迹驱动
    //   audioPosition          = lerp(塔内轨迹, 以人为中心的轨道, blend)
    //
    // Collapse 之后 blend = 1，视觉已经 visible = false，
    // 但 panner 每帧照常更新 —— 18 个看不见的声源继续绕着人转。
    // ========================================================================

    updateClocks() {
        if (!this.clockRegistry || !this.running || !this.timelineStarted) return;

        // MASTER TIME COMES FROM AUDIO
        const t = this.getTimelineTime();

        const listener = this._listenerWorld;
        const blend = this._clockAudioBlend();
        const melting = this.collapseActive || this.collapseCompleted;

        this.clockRegistry.forEach((clockData) => {
            const tt = (t - clockData.movementStart) / clockData.duration;

            // ------------------------------------------------------------
            // 塔内轨迹坐标。即使视觉已经融化，音频的"旧坐标"仍然继续算，
            // 这样 Collapse 期间的插值不会在中途出现跳变。
            // ------------------------------------------------------------

            if (t >= clockData.movementStart) {
                const pos = clockData.trajectory(clockData.originalPosition, tt);

                clockData.towerPosition.set(pos.x, pos.y, pos.z);

                // 融化期间视觉由 _updateClockMelt() 接管，不要在这里覆写。
                if (!melting) clockData.visualObject.position.copy(clockData.towerPosition);
            }

            // ------------------------------------------------------------
            // AUDIO POSITION
            // ------------------------------------------------------------

            if (blend <= 0) {
                clockData.audioPosition.copy(clockData.towerPosition);
            } else if (blend >= 1) {
                this._clockOrbitPosition(clockData, listener, tt, clockData.audioPosition);
            } else {
                this._clockOrbitPosition(clockData, listener, tt, this._tmpVecB);

                clockData.audioPosition.copy(clockData.towerPosition).lerp(this._tmpVecB, blend);
            }

            // Michigan 模式下这个 panner 没接实际 source，写它也不花什么，
            // 保留以免两条路径分叉。
            setImmediatePannerPos(clockData.audioNode.panner, clockData.audioPosition);
        });

        // DEBUG TIMELINE
        if (!this._timelineDebugFrame) this._timelineDebugFrame = 0;

        if (++this._timelineDebugFrame % 180 === 0) {
            console.log(`[Timeline] ${t.toFixed(3)}s`);
        }
    }

    // ========================================================================
    // DRONES
    //
    // 和 Clock 的区别：
    //   Clock = 以参与者为中心**绕圈**的声源
    //   Drone = 相对参与者**固定偏移**的声源
    //
    // 两者都只跟随平移，不跟随头部旋转。
    // ========================================================================

    updateDrones() {
        if (!this.droneRegistry?.length || !this.timelineStarted) return;

        if (!this.droneOffsetsReady) this._captureDroneOffsets();

        const listener = this._listenerWorld;

        this.droneRegistry.forEach((droneData) => {
            droneData.worldPosition.copy(listener).add(droneData.relativeOffset);

            setImmediatePannerPos(droneData.audioNode.panner, droneData.worldPosition);
        });
    }

    // ========================================================================
    // VR PANEL
    // ========================================================================

    // Panel 背景和标题单独抽出来，因为选完模式和按 Set Spawn 之后要重画。
    // 头显里 DOM 不可见，这是唯一能在 immersive 模式读到数值的地方。
    _drawPanelBackground() {
        if (!this.panelCtx) return;

        const px = this.panelCtx;
        const CW = this.panelCanvas.width;
        const CH = this.panelCanvas.height;

        px.clearRect(0, 0, CW, CH);

        // 两个 roundRect 之间必须 beginPath()，否则 stroke 会把第一个矩形也描一遍。
        px.beginPath();
        px.fillStyle = 'rgba(8,14,26,0.92)';
        px.roundRect(0, 0, CW, CH, 32);
        px.fill();

        px.beginPath();
        px.strokeStyle = 'rgba(255,255,255,0.2)';
        px.lineWidth = 4;
        px.roundRect(2, 2, CW - 4, CH - 4, 30);
        px.stroke();

        px.fillStyle = 'rgba(255,255,255,0.55)';
        px.font = '34px sans-serif';
        px.textAlign = 'center';
        px.fillText('A Thousand Clocks', CW / 2, 48);

        if (this.runtimeMode) {
            px.fillStyle = this.isMichigan ? 'rgba(204,153,255,0.9)' : 'rgba(0,255,136,0.9)';
            px.font = 'bold 20px sans-serif';
            px.fillText(MODE_LABEL[this.runtimeMode], CW / 2, 78);
        }

        // SPAWN READOUT
        //
        // 按过 Set Spawn 之后把归一化锚点写在这里，戴着头显直接抄。
        if (this.spawnReadout) {
            const a = this.spawnReadout;

            px.fillStyle = 'rgba(255,204,102,0.95)';
            px.font = 'bold 22px ui-monospace, monospace';
            px.fillText(
                `SPAWN_ANCHOR = { x: ${a.x}, y: ${a.y}, z: ${a.z} }`,
                CW / 2,
                110,
            );
        }

        if (this.panelTexture) this.panelTexture.needsUpdate = true;
    }

    buildVRPanel() {
        // Set Spawn 按钮加进来之后 paused 模式有四个按钮，
        // 原来 720 宽的 panel 放不下，所以整体加宽。
        const CW = 980;
        const CH = 280;

        const pc = document.createElement('canvas');
        pc.width = CW;
        pc.height = CH;

        this.panelCanvas = pc;
        this.panelCtx = pc.getContext('2d');

        const ptex = new THREE.CanvasTexture(pc);
        ptex.colorSpace = THREE.SRGBColorSpace;
        this.panelTexture = ptex;

        this._drawPanelBackground();

        const bg = new THREE.Mesh(
            new THREE.PlaneGeometry(1.4, 0.4),
            new THREE.MeshBasicMaterial({
                map: ptex, transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
            }),
        );
        bg.renderOrder = 100; // 背景先画

        // 基础色 = NORMAL 状态（最亮），hover / pressed 会自动在这个基础上变暗。
        this.vrBtnStart = makeButtonMesh('▶  Start', 60, 200, 115);
        this.vrBtnStart.userData.action = 'start';

        this.vrBtnResume = makeButtonMesh('▶  Resume', 60, 200, 115);
        this.vrBtnResume.userData.action = 'resume';

        this.vrBtnRestart = makeButtonMesh('↻  Restart', 230, 155, 55);
        this.vrBtnRestart.userData.action = 'restart';

        this.vrBtnSpawn = makeButtonMesh('◎  Set Spawn', 90, 150, 230);
        this.vrBtnSpawn.userData.action = 'setspawn';

        this.vrBtnExit = makeButtonMesh('✕  Exit VR', 225, 75, 75);
        this.vrBtnExit.userData.action = 'exit';

        this.vrPanel = new THREE.Group();
        this.vrPanel.add(
            bg,
            this.vrBtnStart,
            this.vrBtnResume,
            this.vrBtnRestart,
            this.vrBtnSpawn,
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

        // Set Spawn 只在 Timeless Field / Return 里有意义 ——
        // Tower 段按它没有地形可以量，会误导。
        const onTimelessTerrain =
            this.experienceState === EXPERIENCE_STATE.TIMELESS_FIELD ||
            this.experienceState === EXPERIENCE_STATE.RETURN;

        this.vrBtnSpawn.visible = onTimelessTerrain;

        const Y = -0.085;

        if (initial) {
            if (onTimelessTerrain) {
                this.vrBtnStart.position.set(-0.31, Y, 0.01);
                this.vrBtnSpawn.position.set(0, Y, 0.01);
                this.vrBtnExit.position.set(0.31, Y, 0.01);
            } else {
                this.vrBtnStart.position.set(-0.16, Y, 0.01);
                this.vrBtnExit.position.set(0.16, Y, 0.01);
            }
        } else if (onTimelessTerrain) {
            this.vrBtnResume.position.set(-0.465, Y, 0.01);
            this.vrBtnRestart.position.set(-0.155, Y, 0.01);
            this.vrBtnSpawn.position.set(0.155, Y, 0.01);
            this.vrBtnExit.position.set(0.465, Y, 0.01);
        } else {
            this.vrBtnResume.position.set(-0.31, Y, 0.01);
            this.vrBtnRestart.position.set(0, Y, 0.01);
            this.vrBtnExit.position.set(0.31, Y, 0.01);
        }

        this._refreshPanel();
    }

    showVRPanel() {
        if (!this.vrPanel) return;

        // 每次呼出都重排一次 —— Set Spawn 的可见性取决于当前 state。
        this.setPanelMode(this.timelineStarted ? 'paused' : 'initial');

        const headPos = new THREE.Vector3();
        const forward = new THREE.Vector3();

        this.camera.getWorldPosition(headPos);
        this.camera.getWorldDirection(forward);

        forward.y = 0;

        if (forward.lengthSq() < 0.0001) forward.set(0, 0, -1);

        forward.normalize();

        const panelWorldPos = headPos.clone().addScaledVector(forward, this.panelDistance);
        panelWorldPos.y = headPos.y + this.panelVerticalOffset;

        this.vrPanel.position.copy(this.dolly.worldToLocal(panelWorldPos.clone()));
        this.vrPanel.rotation.set(0, Math.atan2(-forward.x, -forward.z), 0);

        this.ctrlState.forEach((state) => { state.hoveredBtn = null; });

        // panel 打开时世界按钮不参与射线，把它的高亮状态收干净。
        if (this.collapseButton) this._setButtonVisual(this.collapseButton, 'normal');

        this._refreshPanel();
        this.vrPanel.visible = true;
    }

    hideVRPanel() {
        if (this.vrPanel) this.vrPanel.visible = false;
    }

    async pauseAndShowMenu() {
        if (this.running) await this.stopAudio();

        this.showVRPanel();
    }

    // ========================================================================
    // RESET / RESTART
    //
    // 录 demo 用：任何一条 take 拍砸了，按 Restart 必须回到干净的起点。
    //
    // 唯一**不能**动的是 Timeless Field 的对齐平移
    // （this.timelessFieldRoot.position）—— 那是永久的世界布局，
    // 撤销它下次 Collapse 人就不站在草上了。
    // ========================================================================

    resetExperience() {
        // ------------------------------------------------------------
        // COLLAPSE 状态
        // ------------------------------------------------------------

        this.collapseActive = false;
        this.collapseCompleted = false;
        this.collapseStartTime = null;
        this.collapseProgress = 0;
        this.sceneReveal = 1;

        // ------------------------------------------------------------
        // TOWER 构件
        // ------------------------------------------------------------

        this.towerCollapsePieces?.forEach((piece) => {
            piece.object.position.copy(piece.originalPosition);
            piece.object.quaternion.copy(piece.originalQuaternion);
            piece.object.scale.copy(piece.originalScale);
        });

        if (this.towerFadeEntries?.length) restoreFadeMaterials(this.towerFadeEntries);

        // ------------------------------------------------------------
        // CLOCK 视觉 + 音频
        // ------------------------------------------------------------

        if (this.clockRegistry) {
            this.clockRegistry.forEach((clockData) => {
                const source = clockData.audioNode.source;

                if (source) {
                    try { source.stop(); } catch (_) {}
                    try { source.disconnect(); } catch (_) {}
                    clockData.audioNode.source = null;
                }

                const object = clockData.visualObject;

                object.position.copy(clockData.originalPosition);
                object.quaternion.copy(clockData.originalQuaternion);
                object.scale.copy(clockData.originalScale);
                object.visible = true;

                if (clockData.fadeEntries) restoreFadeMaterials(clockData.fadeEntries);

                clockData.towerPosition.copy(clockData.originalPosition);
                clockData.audioPosition.copy(clockData.originalPosition);
                clockData.meltBasePosition.copy(clockData.originalPosition);

                setImmediatePannerPos(clockData.audioNode.panner, clockData.originalPosition);
            });
        }

        // ------------------------------------------------------------
        // DRONES
        //
        // 偏移量清掉，下一次 Start 时按当时的听者位置重新采一遍。
        // ------------------------------------------------------------

        if (this.droneRegistry) {
            this.droneRegistry.forEach((droneData) => {
                const source = droneData.audioNode.source;

                if (source) {
                    try { source.stop(); } catch (_) {}
                    try { source.disconnect(); } catch (_) {}
                    droneData.audioNode.source = null;
                }

                droneData.worldPosition.copy(droneData.position);

                setImmediatePannerPos(droneData.audioNode.panner, droneData.position);
            });
        }

        this.droneOffsetsReady = false;

        // ------------------------------------------------------------
        // RESET PLAYER RIG
        //
        // 回到 Tower 出生点。Collapse 本身不会移动参与者，但 grip teleport 会，
        // 所以 Restart 仍然要把人放回原处 —— 否则第二条 take 的起始位置不一样。
        // ------------------------------------------------------------

        if (this.dolly) {
            this.dolly.position.x = this.towerSpawnPosition.x;
            this.dolly.position.z = this.towerSpawnPosition.z;

            if (this.renderer.xr.isPresenting) {
                this.dolly.position.y = this.floorWorldY;
            }
        }

        // RESET NARRATIVE
        this.setExperienceState(EXPERIENCE_STATE.INTRO, 'experience reset');

        this.running = false;
        this.timelineStarted = false;
        this.timelineStartAt = null;
        this._timelineDebugFrame = 0;

        // timelineStarted 清掉之后按钮应该消失，等下一次 Start 再出现。
        this._updateCollapseButtonVisibility();

        console.log('[Reset] Experience restored to clean start state (Field alignment preserved).');
    }

    async restartAudio() {
        this.resetExperience();
        await this.startAudio();
    }

    async exitVR() {
        if (this.running) await this.stopAudio();

        this.resetExperience();

        const session = this.renderer.xr.getSession();

        if (session) await session.end();
    }

    // ------------------------------------------------------------
    // 把一个按钮画成指定状态。mode = 'normal' | 'hover' | 'pressed'
    // 只有状态真的变了才重画，否则 Quest 会每一帧重传 5 张贴图。
    // ------------------------------------------------------------

    _setButtonVisual(btn, mode) {
        if (!btn) return;

        const ud = btn.userData;

        if (ud.visualState === mode) return;

        let brightness = ud.brightnessNormal;

        if (mode === 'pressed') {
            brightness = ud.brightnessPressed;
        } else if (mode === 'hover') {
            brightness = ud.brightnessHover;
        }

        // 不重新画 Canvas，直接改变 material 的亮度：normal 1.00 / hover 0.58 / pressed 0.28
        btn.material.color.setRGB(brightness, brightness, brightness);

        ud.visualState = mode;
    }

    _panelButtons() {
        return [
            this.vrBtnStart,
            this.vrBtnResume,
            this.vrBtnRestart,
            this.vrBtnSpawn,
            this.vrBtnExit,
        ].filter(Boolean);
    }

    _visiblePanelButtons() {
        return this._panelButtons().filter((btn) => btn.visible);
    }

    // ------------------------------------------------------------
    // 当前可以被射线打到的东西。
    //
    // Panel 打开时它**独占**射线（menu blocking），关掉之后才轮到
    // 世界空间里的东西（现在只有 COLLAPSE 按钮）。
    // 这里没有第二套 interaction 系统，只是换了一个目标列表。
    // ------------------------------------------------------------

    _activeInteractables() {
        if (this.vrPanel?.visible) return this._visiblePanelButtons();

        return (this.worldInteractables ?? []).filter((object) => object.visible);
    }

    // 把所有按钮重置回 NORMAL（最亮）。
    _refreshPanel() {
        this._panelButtons().forEach((btn) => this._setButtonVisual(btn, 'normal'));

        this.ctrlState?.forEach((state) => { state.pressedBtn = null; });
    }

    // ========================================================================
    // CONTROLLER RAY
    // ========================================================================

    _buildRayLine(ctrl) {
        // RAY LINE
        const geo = new THREE.BufferGeometry();
        const positions = new Float32Array([0, 0, 0, 0, 0, -2]);

        geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));

        const mat = new THREE.LineBasicMaterial({
            color: 0xffffff, linewidth: 2, transparent: true, opacity: 0.7, depthTest: false,
        });

        const line = new THREE.Line(geo, mat);
        line.renderOrder = 999;
        ctrl.add(line);

        // RAY ENDPOINT CURSOR — Meta-style small sphere at the end of the ray
        const cursorGeometry = new THREE.SphereGeometry(0.018, 16, 16); // radius = 1.8 cm

        const cursorMaterial = new THREE.MeshBasicMaterial({
            color: 0xffffff, transparent: true, opacity: 0.95, depthTest: false, depthWrite: false, toneMapped: false,
        });

        const cursor = new THREE.Mesh(cursorGeometry, cursorMaterial);
        cursor.position.set(0, 0, -2); // 默认 ray 长度 = 2m
        cursor.renderOrder = 1000;
        ctrl.add(cursor);

        // 把 cursor 存在 ray 上，以后 update ray length 的时候一起移动。
        line.userData.cursor = cursor;

        return line;
    }

    _updateRayLine(ray, hitDistance) {
        if (!ray) return;

        // 有 hit → endpoint 到 hit position，没有 hit → 默认 2 meters
        const distance = hitDistance !== null && hitDistance !== undefined ? hitDistance : 2;

        // UPDATE LINE END
        const pos = ray.geometry.attributes.position;
        pos.setZ(1, -distance);
        pos.needsUpdate = true;

        // UPDATE CURSOR POSITION
        const cursor = ray.userData.cursor;

        if (cursor) cursor.position.set(0, 0, -distance);
    }

    _castController(ctrl) {
        if (!ctrl) return null;

        const targets = this._activeInteractables();

        if (targets.length === 0) return null;

        const origin = new THREE.Vector3();
        const direction = new THREE.Vector3();

        ctrl.getWorldPosition(origin);
        direction.set(0, 0, -1).transformDirection(ctrl.matrixWorld).normalize();

        this.rc.set(origin, direction);

        const hits = this.rc.intersectObjects(targets, false);

        return hits.length > 0 ? hits[0] : null;
    }

    _processControllers() {
        const buttons = this._activeInteractables();

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

            // 射线长度
            this._updateRayLine(state.ray, hit ? hit.distance : null);

            // 白色 = 没碰到按钮，绿色 = 碰到按钮
            if (state.ray) {
                const rayColor = hit ? 0x00ff88 : 0xffffff;

                state.ray.material.color.set(rayColor);

                const cursor = state.ray.userData.cursor;

                if (cursor) cursor.material.color.set(rayColor);
            }

            state.hoveredBtn = btn;

            // DEBUG：只在 hit 状态改变时打印。注意变量名是 hoveredAction，不能叫 action ——
            // 会和别处的 const action 冲突。
            const hoveredAction = btn?.userData?.action ?? null;

            if (state.debugLastAction !== hoveredAction) {
                console.log(
                    `[UI Ray ${i}]`, hoveredAction ? `HIT → ${hoveredAction}` : 'NO HIT',
                    hit ? { distance: hit.distance.toFixed(3) } : '',
                );

                state.debugLastAction = hoveredAction;
            }
        }

        // 两只手都检查完以后统一更新按钮颜色。优先级：pressed > hover > normal
        const hoveredButtons = new Set(hits.filter(Boolean).map((hit) => hit.object));
        const pressedButtons = new Set(this.ctrlState.map((state) => state.pressedBtn).filter(Boolean));

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
    //
    // donut 表面没有固定的地面高度，所以在 Timeless Field / Return 里
    // 射线直接打真实地形。GrassField 永远不参与 raycast。
    // 其他 state 仍然用 y = teleportFloorY 的水平面。
    // ========================================================================

    updateTeleport() {
        for (let i = 0; i < this.controllers.length; i++) {
            const ctrl = this.controllers[i];
            const ts = this.teleportState[i];

            if (!ctrl || !ts.aiming) continue;

            const origin = new THREE.Vector3();
            const direction = new THREE.Vector3();

            ctrl.getWorldPosition(origin);
            direction.set(0, 0, -1).transformDirection(ctrl.matrixWorld).normalize();

            const onTimelessTerrain =
                this.experienceState === EXPERIENCE_STATE.TIMELESS_FIELD ||
                this.experienceState === EXPERIENCE_STATE.RETURN;

            if (onTimelessTerrain && this.timelessFieldTerrainRoot) {
                this.teleportRaycaster.set(origin, direction);
                this.teleportRaycaster.near = 0;
                this.teleportRaycaster.far = 12;

                const terrainHits = this.teleportRaycaster.intersectObject(
                    this.timelessFieldTerrainRoot,
                    true,
                );

                if (terrainHits.length > 0) {
                    const hit = terrainHits[0];

                    const normal = hit.face
                        ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld).normalize()
                        : new THREE.Vector3(0, 1, 0);

                    // 暂时允许 normal.y >= 0.6 的坡面。
                    // 这是 headset 测试参数，以后可以根据实际坡度再调。
                    if (normal.y >= 0.6) {
                        ts.targetPoint.copy(hit.point);
                        ts.targetValid = true;

                        // Marker 稍微浮在地表上，避免 z-fighting。
                        this.teleportMarker.position.copy(hit.point).addScaledVector(normal, 0.04);
                    } else {
                        ts.targetValid = false;
                    }
                } else {
                    ts.targetValid = false;
                }
            }

            // ------------------------------------------------------------
            // CLOCK TOWER / OTHER FLAT STATES
            // ------------------------------------------------------------

            else if (direction.y < -0.001) {
                const t = (this.teleportFloorY - origin.y) / direction.y;

                if (t > 0 && t <= 12) {
                    ts.targetPoint.copy(origin).addScaledVector(direction, t);
                    ts.targetValid = true;

                    this.teleportMarker.position.set(
                        ts.targetPoint.x,
                        this.teleportFloorY + 0.04,
                        ts.targetPoint.z,
                    );
                } else {
                    ts.targetValid = false;
                }
            } else {
                ts.targetValid = false;
            }

            // ------------------------------------------------------------
            // TELEPORT MARKER + CONTROLLER RAY
            // ------------------------------------------------------------

            if (ts.targetValid) {
                this.teleportMarker.material.color.set(0x00ff88);
                this.teleportMarker.visible = true;

                this._updateRayLine(this.ctrlState[i].ray, origin.distanceTo(ts.targetPoint));

                const ray = this.ctrlState[i].ray;

                if (ray) {
                    ray.material.color.set(0x00ff88);

                    const cursor = ray.userData.cursor;

                    if (cursor) cursor.material.color.set(0x00ff88);
                }
            } else {
                this.teleportMarker.visible = false;
            }

            // 两只手不能同时控制 teleport marker。
            break;
        }
    }

    // ========================================================================
    // VR
    // ========================================================================

    setupVR() {
        this.renderer.xr.enabled = true;
        this.renderer.xr.setReferenceSpaceType('local-floor');

        // ============================================================
        // XR ENTRY DEBUG HUD
        //
        // 头显里 DOM overlay 在 immersive 模式看不见，但按 ENTER VR 之前看得见 ——
        // 而"点了没反应"恰好全部发生在进入之前，所以 DOM 是对的地方。
        // ============================================================

        const xrDebug = document.createElement('div');

        xrDebug.style.cssText = [
            'position:fixed', 'left:12px', 'bottom:60px', 'z-index:100000',
            'max-width:80vw', 'padding:10px 14px', 'border-radius:8px',
            'background:rgba(0,0,0,0.85)', 'color:#ffffff',
            'font:13px/1.5 monospace', 'pointer-events:none', 'white-space:pre-wrap',
        ].join(';');

        xrDebug.textContent = 'XR DEBUG: initializing…';

        document.body.appendChild(xrDebug);

        this.xrDebugEl = xrDebug;

        this.setXRDebug = (message, color = '#ffffff') => {
            console.log('[XR DEBUG]', message);

            if (this.xrDebugEl) {
                this.xrDebugEl.textContent = `XR DEBUG: ${message}`;
                this.xrDebugEl.style.color = color;
            }
        };

        if (!navigator.xr) {
            this.setXRDebug(
                `navigator.xr 不存在。secure=${window.isSecureContext} ${window.location.protocol}`,
                '#ff6b6b',
            );
        } else {
            navigator.xr.isSessionSupported('immersive-vr')
                .then((supported) => {
                    this.setXRDebug(
                        `immersive-vr supported = ${supported}`,
                        supported ? '#00ff88' : '#ff6b6b',
                    );
                })
                .catch((error) => {
                    this.setXRDebug(
                        `isSessionSupported ERROR: ${error?.name}: ${error?.message}`,
                        '#ff6b6b',
                    );
                });
        }

        // 包一层 requestSession，只观察不改变行为。
        if (navigator.xr?.requestSession) {
            try {
                const originalRequestSession = navigator.xr.requestSession.bind(navigator.xr);

                navigator.xr.requestSession = (...args) => {
                    this.setXRDebug(`requestSession("${args[0]}") CALLED`, '#ffcc66');

                    return originalRequestSession(...args)
                        .then((session) => {
                            const features = session.enabledFeatures
                                ? [...session.enabledFeatures].join(', ')
                                : 'not exposed';

                            this.setXRDebug(`requestSession RESOLVED\nfeatures: ${features}`, '#66ccff');

                            return session;
                        })
                        .catch((error) => {
                            this.setXRDebug(
                                `requestSession REJECTED\n${error?.name}: ${error?.message}`,
                                '#ff6b6b',
                            );

                            throw error;
                        });
                };
            } catch (error) {
                this.setXRDebug(`无法包装 requestSession: ${error?.message}`, '#ff6b6b');
            }
        }

        // requestSession 之后的异步错误（renderer.xr.setSession / requestReferenceSpace）
        window.addEventListener('unhandledrejection', (event) => {
            const error = event.reason;

            this.setXRDebug(
                `UNHANDLED PROMISE\n${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`,
                '#ff6b6b',
            );

            console.error('[XR DEBUG] Unhandled promise rejection:', error);
        });

        window.addEventListener('error', (event) => {
            this.setXRDebug(
                `WINDOW ERROR\n${event.error?.name ?? 'Error'}: ${event.error?.message ?? event.message}`,
                '#ff6b6b',
            );
        });

        // 资产加载完成 + 模式选定之前禁用 ENTER VR。
        this.vrButtonEl = VRButton.createButton(this.renderer);
        document.body.appendChild(this.vrButtonEl);
        this._setVRButtonEnabled(false);

        this.vrButtonEl.addEventListener('click', () => {
            this.setXRDebug?.(
                `ENTER VR CLICK RECEIVED\npresenting=${this.renderer.xr.isPresenting}`,
                '#ffcc66',
            );
        }, true);

        // DOLLY
        this.dolly = new THREE.Object3D();
        this.dolly.position.set(0, 0, 0);
        this.dolly.add(this.camera);
        this.scene.add(this.dolly);

        // FIELD LAMP
        //
        // 身边的一小圈光。distance 75 = 光的硬截断距离，草的撒点半径是 70，
        // 所以草的边界永远落在光照不到的地方 —— 不需要靠雾去遮。
        // 挂在 dolly 上而不是 camera 上：转头时光不跟着甩。
        //
        // 注意 y 不是离地高度。dolly 原点本身就在地面上方 FLOOR_OFFSET(1.30)，
        // 所以 0.2 大约等于地面上 1.5 米。
        this.fieldLamp = new THREE.PointLight(0x9fd8d0, 20.0, 75, 2.0);
        this.fieldLamp.position.set(0, 0.2, 0);
        this.fieldLamp.visible = false;
        this.dolly.add(this.fieldLamp);

        this.renderer.xr.addEventListener('sessionstart', () => {
            this.setXRDebug?.('XR SESSION STARTED SUCCESSFULLY', '#00ff88');

            if (this.inviso) this.inviso.resetCalibration();

            this.controls.enabled = false;
            this.dolly.position.y = this.floorWorldY;

            this.showVRPanel();
        });

        this.renderer.xr.addEventListener('sessionend', async () => {
            this.controls.enabled = true;
            this.hideVRPanel();

            if (this.running) await this.stopAudio();

            this.resetExperience();
            this.dolly.position.y = 0;
        });

        // CONTROLLERS
        this.controllers = [this.renderer.xr.getController(0), this.renderer.xr.getController(1)];

        this.controllers.forEach((ctrl, i) => {
            // TRIGGER -> INVISO OSC TEST
            //
            // 和现有的 trigger 逻辑并行运行，不替代 UI / grab 行为。
            // Standalone 模式下 this.inviso 是 null，整段自动变成 no-op。
            ctrl.addEventListener('selectstart', () => {
                if (!this.inviso) return;

                const hand = ctrl.userData.handedness || `controller${i}`;
                const sent = this.inviso.send({ type: 'controller', hand, control: 'trigger', value: 1 });

                console.log(`[Controller OSC] ${hand} trigger=1 sent=${sent}`);
            });

            ctrl.addEventListener('selectend', () => {
                if (!this.inviso) return;

                const hand = ctrl.userData.handedness || `controller${i}`;
                const sent = this.inviso.send({ type: 'controller', hand, control: 'trigger', value: 0 });

                console.log(`[Controller OSC] ${hand} trigger=0 sent=${sent}`);
            });

            // EXISTING TRIGGER LOGIC
            ctrl.addEventListener('selectstart', async () => {
                const state = this.ctrlState[i];

                state.selectPressed = true;
                state.justFired = true;

                // ------------------------------------------------------------
                // CASE 1: Panel 没有显示。
                //
                // 先看射线有没有打在世界空间的东西上（现在只有 COLLAPSE 按钮）。
                // 打中了就走按钮流程；没打中才是"Trigger = Pause + 呼出 menu"。
                // ------------------------------------------------------------

                if (!this.vrPanel.visible) {
                    const worldHit = this._castController(ctrl);

                    if (worldHit) {
                        state.pressedBtn = worldHit.object;

                        this._setButtonVisual(worldHit.object, 'pressed');

                        console.log(`[World PRESS ${i}] → ${worldHit.object.userData.action}`);
                        return;
                    }

                    state.justFired = false;
                    state.pressedBtn = null;

                    await this.pauseAndShowMenu();
                    return;
                }

                // CASE 2: Panel 正在显示。Trigger DOWN 只让按钮进入 PRESSED 状态，
                // 此时绝对不执行任何 action，所以用户按住 trigger 的时候
                // 可以清楚看到按钮保持"最暗"。
                const hit = this._castController(ctrl);

                if (!hit) {
                    state.pressedBtn = null;
                    console.log(`[UI PRESS ${i}] NO BUTTON`);
                    return;
                }

                const pressedBtn = hit.object;

                state.pressedBtn = pressedBtn;

                this._setButtonVisual(pressedBtn, 'pressed');

                console.log(`[UI PRESS ${i}] → ${pressedBtn.userData.action}`);
            });

            ctrl.addEventListener('selectend', async () => {
                const state = this.ctrlState[i];

                state.selectPressed = false;

                const pressedBtn = state.pressedBtn; // 保存 trigger DOWN 时按到的按钮
                state.pressedBtn = null;              // pressed 状态结束

                if (!pressedBtn) return;

                // 检查 trigger 松开的时候射线是不是仍然停留在同一个按钮，
                // 避免"按 Start → 手移走 → 松 trigger → Start 仍然误触"。
                const releaseHit = this._castController(ctrl);

                if (!releaseHit || releaseHit.object !== pressedBtn) {
                    console.log(`[UI CANCEL ${i}]`, pressedBtn.userData.action);
                    return;
                }

                const clickedAction = pressedBtn.userData.action;

                console.log(`[UI CLICK ${i}] → ${clickedAction}`);

                // Trigger RELEASE 才执行真正 action
                if (clickedAction === 'start' || clickedAction === 'resume') {
                    await this.startAudio();
                } else if (clickedAction === 'restart') {
                    await this.restartAudio();
                } else if (clickedAction === 'collapse') {
                    this.startCollapse(`world button / controller ${i}`);
                } else if (clickedAction === 'setspawn') {
                    // panel 留在原地，数值直接画上去，人可以立刻抄。
                    this.setSpawnHere();
                    this._refreshPanel();
                } else if (clickedAction === 'exit') {
                    await this.exitVR();
                }
            });

            // GRIP = TELEPORT
            ctrl.addEventListener('squeezestart', () => {
                console.log(`[Teleport] Grip ${i} pressed`);

                const ts = this.teleportState[i];
                ts.aiming = true;
                ts.targetValid = false;
            });

            ctrl.addEventListener('squeezeend', () => {
                const ts = this.teleportState[i];

                if (ts.aiming && ts.targetValid) {
                    const headPosition = new THREE.Vector3();
                    this.camera.getWorldPosition(headPosition);

                    // X / Z 保留 room-scale offset。
                    this.dolly.position.x += ts.targetPoint.x - headPosition.x;
                    this.dolly.position.z += ts.targetPoint.z - headPosition.z;

                    const onTimelessTerrain =
                        this.experienceState === EXPERIENCE_STATE.TIMELESS_FIELD ||
                        this.experienceState === EXPERIENCE_STATE.RETURN;

                    if (onTimelessTerrain) {
                        // donut 表面有真实高度。
                        // 保留原来的 FLOOR_OFFSET，同时加上 terrain elevation。
                        this.dolly.position.y = ts.targetPoint.y + this.floorWorldY;
                    }

                    console.log('[Teleport] moved player', {
                        target: ts.targetPoint.toArray().map((v) => Number(v.toFixed(2))),
                        dolly: this.dolly.position.toArray().map((v) => Number(v.toFixed(2))),
                        terrainMode: onTimelessTerrain,
                    });
                }

                ts.aiming = false;
                ts.targetValid = false;
                this.teleportMarker.visible = false;
            });

            // CONTROLLER CONNECT / DISCONNECT
            //
            // 只记录 handedness 和建立射线。controller model 统一在下面的 grips 循环里加，
            // 不在这里重复添加。
            ctrl.addEventListener('connected', (event) => {
                const handedness = event.data?.handedness || `controller${i}`;

                ctrl.userData.handedness = handedness;

                console.log(`[XR Controller ${i}] connected as ${handedness}`);

                if (!this.ctrlState[i].ray) this.ctrlState[i].ray = this._buildRayLine(ctrl);
            });

            ctrl.addEventListener('disconnected', () => {
                if (this.ctrlState[i].ray) {
                    ctrl.remove(this.ctrlState[i].ray);
                    this.ctrlState[i].ray = null;
                }
            });

            this.dolly.add(ctrl);
        });

        // CONTROLLER GRIPS + MODELS
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
    //
    // 整个 loop 包在 try/catch 里：任何一帧的异常都不应该让 setAnimationLoop 静默停止。
    // 在头显里这看起来就是画面冻结，而且没有任何提示。
    //
    // Collapse 也在这里推进 —— 没有第二个 animation loop，没有 setTimeout 链。
    // ========================================================================

    render() {
        try {
            this.clock.getDelta(); // Three Clock 继续 tick，但是作品时间不再由它决定。
            this.stats.update();

            // 这一帧的听者位置。Clock 轨道、Drone 偏移、Web Audio listener 都用它。
            this.camera.getWorldPosition(this._listenerWorld);

            this._processControllers();
            this.updateTeleport();

            this.updateCollapse();               // 定时解体动画，时间来自 master timeline。

            this.updateClocks();                 // Movement 从 Web Audio master timeline 读取时间。
            this.updateDrones();                 // 相对参与者的固定偏移。
            this.updateDebugStateSequence();      // TEMPORARY NARRATIVE STATE TEST

            this.updateAudioListener();

            // Michigan 模式才有 inviso 实例，Standalone 下这里是 no-op。
            if (this.inviso) {
                this.inviso.updateListener({ renderer: this.renderer, camera: this.camera, timeMs: performance.now() });
            }

            this.renderer.render(this.scene, this.camera);
        } catch (error) {
            if (!this._renderErrorLogged) {
                console.error('[Render] Exception in render loop:', error);
                this._renderErrorLogged = true;
            }
        }
    }
}

export { App };