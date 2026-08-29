import * as THREE from 'three';

import { InvisoClient } from './inviso/InvisoClient.js';
import { IS_MICHIGAN as BUILD_IS_MICHIGAN } from './runtime/mode.js';

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
// Drone = 固定在世界空间中的声音，不会跟 Clock 一起移动。
// position = Three.js 世界坐标，gain = 每个 Drone 自己的音量，loop = 是否循环
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
// 不同之处：Drone 的位置之后不会每帧更新。
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

function makeButtonMesh(label, r, g, b, w = 0.3, h = 0.1) {
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
    ctx.font = 'bold 68px sans-serif';
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
// 今晚先用这个自动测试：0–5s Tower / 5–8s Collapse / 8–18s Timeless Field / 18+s Tower returns
// 等我们确认切换成功以后，把它改成 false。
// ============================================================================

const DEBUG_AUTO_STATE_TEST = true;

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
        // PERSISTENT WORLD ROOTS
        //
        // 它们全部都会存在于同一个 this.scene 里，State machine 只控制 visible。
        // ------------------------------------------------------------

        this.towerRoot = null;
        this.timelessFieldRoot = null;

        // Clock GLB load 完成之前先准备好空 registry。
        this.clockRegistry = [];

        // ------------------------------------------------------------
        // LOADING UI
        //
        // 必须在任何 loader 启动之前建立，否则前几个 progress 回调无处可去。
        // ------------------------------------------------------------

        this.loading = new LoadingUI();
        this.loading.addTask('tower', 'Clock Tower model', 30);
        this.loading.addTask('field', 'Timeless Field model', 15);
        this.loading.addTask('clock_dl', `Clock stems — download (${CLOCK_COUNT})`, 45);
        this.loading.addTask('drone_dl', `Drones — download (${DRONE_CONFIG.length})`, 10);
        this.loading.setStatus('Downloading assets…');

        console.log('[Audio] context sampleRate =', audioCtx.sampleRate);

        console.log(
            `[Mode] build=${BUILD_IS_MICHIGAN ? 'michigan' : 'standalone'} ` +
            `url=${URL_FORCED_MODE ?? 'none'} default=${DEFAULT_MODE} ` +
            `prefetch=${AUDIO_PREFETCH_ENABLED}`,
        );

        // ------------------------------------------------------------
        // CAMERA
        // ------------------------------------------------------------

        this.camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 1000);
        this.camera.position.set(0, cameraY, 0);

        // ------------------------------------------------------------
        // SCENE
        // ------------------------------------------------------------

        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x101820);

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

    _setVRButtonEnabled(enabled) {
        if (!this.vrButtonEl) return;

        this.vrButtonEl.style.pointerEvents = enabled ? 'auto' : 'none';
        this.vrButtonEl.style.opacity = enabled ? '1' : '0.35';
    }

    // PHASE 1 的每一个 task 结束时都会调用这个。全部结束 → 进入模式选择。
    _checkPhase1Done() {
    if (this.modeSelectionStarted) return;
    if (!this.loading || !this.loading.isComplete()) return;

    if (this.loading.hasFailures()) {
    this._setVRButtonEnabled(false);

    this.loading.showFatalError(
        'Some required assets failed to load.'
    );

    console.error(
        '[Loading] PHASE 1 FAILED — runtime mode selection blocked.'
    );

    return;
}

    this.modeSelectionStarted = true;

    this._runModeSelection();
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

        // 用户点击按钮是合法 user gesture，趁这一下把 AudioContext 解锁。
        // Michigan 模式也要解锁，因为 audioCtx.currentTime 仍然是作品的 master clock。
        try {
            await audioCtx.resume();
            console.log('[Audio] AudioContext state =', audioCtx.state);
        } catch (error) {
            console.warn('[Audio] AudioContext resume failed:', error);
        }

        // VR panel 标题里写上模式，头显里也能一眼确认自己跑的是哪个版本。
        this._drawPanelBackground();
        showModeBadge(mode);

        let modeReady = false;

if (this.isMichigan) {
    modeReady = await this._enterMichiganMode();
} else {
    modeReady = await this._enterStandaloneMode();
}

this._bindAudioBuffers();

if (!modeReady) {
    this._setVRButtonEnabled(false);

    this.loading.showFatalError(
        `${MODE_LABEL[this.runtimeMode]} setup failed.`
    );

    console.error(
        `[Loading] ${MODE_LABEL[this.runtimeMode]} setup FAILED — ENTER VR remains disabled.`
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

    this.loading.setProgress(
        'inviso',
        1,
        'connected'
    );

    this.loading.setStatus(
        'Quest sends listener pose only — no local playback.'
    );

    return true;

} catch (error) {

    console.error(
        '[Inviso] Bridge connection failed:',
        error
    );

    this.loading.fail(
        'inviso',
        'Inviso bridge connection failed'
    );

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

            return true;;
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

                    const movement = getMovementConfig(clockObj.name, index);

                    const audioNode = createClockSpatialChain(this.masterGain, originalPosition);

                    this.clockRegistry.push({
                        name: clockObj.name,
                        object: clockObj,
                        originalPosition,

                        audioBuffer: null,      // 由 _bindAudioBuffers() 填入
                        audioNode,

                        movementStart: movement.start,
                        duration: movement.duration,

                        // ------------------------------------------------
                        // DEMO TRAJECTORY
                        //
                        // 18 个 Clock 分成三层空间：Clock 1–6 = near = 5m, 7–12 = mid = 10m, 13–18 = far = 18m
                        // tt: 0 → movement start, 1 → expansion finished, >1 → continue orbiting
                        // ------------------------------------------------

                        trajectory: (originalPos, tt) => {
                            // WHICH SPATIAL LAYER? index 0–5 → group 0, 6–11 → group 1, 12–17 → group 2
                            const group = Math.floor(index / 6);

                            const radii = [5, 10, 18];      // near / mid / far
                            const heights = [2.5, 5.0, 8.0]; // near / mid / far

                            const radius = radii[group];
                            const baseHeight = heights[group];

                            // 每组六个钟平均分布在 360°，三层稍微错开角度避免三个 ring 完全重叠
                            const angleOffset = ((index % 6) / 6) * Math.PI * 2 + group * 0.35;

                            // tt: 0 → 第 5 秒, 1 → 第 15 秒。smoothstep 让 movement 不会突然启动 / 突然停止。
                            const expandProgress = THREE.MathUtils.smoothstep(Math.min(tt, 1), 0, 1);

                            // expansion 完成以前 orbitTime = 0，15 秒以后开始增加。
                            const orbitTime = Math.max(0, tt - 1);

                            // 0.8 是 rotation speed，因为 tt 的 1 大约对应 10 秒，所以实际 rotation 很慢。
                            const angle = angleOffset + orbitTime * 0.8;

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
    // LOAD TIMELESS FIELD
    // ========================================================================

    loadTimelessField() {
        const loader = new GLTFLoader();
        const modelUrl = `${import.meta.env.BASE_URL}models/TimelessField.glb`;

        loader.load(
            modelUrl,

            // SUCCESS
            (gltf) => {
                const field = gltf.scene;
                field.name = 'TimelessFieldRoot';

                field.position.set(0, 0, 0);
                field.scale.setScalar(1);

                // SAME THREE.SCENE
                this.scene.add(field);
                this.timelessFieldRoot = field;

                // ========================================================
                // FIND TIMELESS FIELD ORIGIN
                // ========================================================

                field.updateMatrixWorld(true);

                const originActor = field.getObjectByName('Origin');

                if (originActor) {
                    const originWorld = new THREE.Vector3();
                    originActor.getWorldPosition(originWorld);

                    this.timelessFieldOrigin = originActor;
                    this.timelessFieldOriginPosition = originWorld.clone();

                    console.log(
                        '%c[TimelessField] Origin found',
                        'color:#00ff88;font-weight:bold',
                        { position: originWorld.toArray().map((v) => Number(v.toFixed(3))) },
                    );

                    // --------------------------------------------------------
                    // IF WE ARE ALREADY WAITING IN TIMELESS FIELD,
                    // TELEPORT NOW THAT ORIGIN IS READY
                    // --------------------------------------------------------

                    if (this.experienceState === EXPERIENCE_STATE.TIMELESS_FIELD) {
                        this.teleportPlayerToTimelessOrigin();
                    }
                } else {
                    console.warn('[TimelessField] Origin actor not found');
                }

                // INSPECT GLB SIZE
                const box = new THREE.Box3().setFromObject(field);
                const size = new THREE.Vector3();
                const center = new THREE.Vector3();

                box.getSize(size);
                box.getCenter(center);

                console.log('%c[TimelessField] LOADED', 'color:#ffcc66;font-weight:bold', {
                    size: { x: size.x.toFixed(3), y: size.y.toFixed(3), z: size.z.toFixed(3) },
                    center: { x: center.x.toFixed(3), y: center.y.toFixed(3), z: center.z.toFixed(3) },
                    min: box.min.toArray().map((v) => Number(v.toFixed(3))),
                    max: box.max.toArray().map((v) => Number(v.toFixed(3))),
                });

                // STATE MACHINE CONTROLS VISIBILITY
                this.applyExperienceState();

                this.loading.setProgress('field', 1);
                this._checkPhase1Done();
            },

            // PROGRESS
            (xhr) => {
                const { p, text } = estimateProgress(xhr);

                this.loading.setProgress('field', p, text);
            },

            // ERROR
            (error) => {
                console.error('[TimelessField] Failed to load', error);

                this.loading.fail('field', 'Timeless Field failed to load');
                this._checkPhase1Done();
            },
        );
    }

    // ========================================================================
    // SET EXPERIENCE STATE
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

            if (nextState === EXPERIENCE_STATE.TIMELESS_FIELD) {
                this.teleportPlayerToTimelessOrigin();
            }

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

        // ------------------------------------------------------------
        // ENTER TIMELESS FIELD
        // ------------------------------------------------------------

        if (nextState === EXPERIENCE_STATE.TIMELESS_FIELD) {
            this.teleportPlayerToTimelessOrigin();
        }

        return true;
    }

    // ========================================================================
    // APPLY EXPERIENCE STATE
    // ========================================================================

    applyExperienceState() {
        const state = this.experienceState;

        // CLOCK TOWER VISIBILITY
        const towerVisible = [
            EXPERIENCE_STATE.INTRO,
            EXPERIENCE_STATE.READ_NOTES,
            EXPERIENCE_STATE.SPECIAL_CLOCK,
            EXPERIENCE_STATE.FINAL_TOWER,
            EXPERIENCE_STATE.END,
        ].includes(state);

        // TIMELESS FIELD VISIBILITY
        const timelessVisible = [
            EXPERIENCE_STATE.TIMELESS_FIELD,
            EXPERIENCE_STATE.RETURN,
        ].includes(state);

        // APPLY
        if (this.towerRoot) this.towerRoot.visible = towerVisible;
        if (this.timelessFieldRoot) this.timelessFieldRoot.visible = timelessVisible;

        // CLOCKS STAY ALIVE
        //
        // 这些 Clock 已经被 scene.attach() 到 this.scene，所以 Tower hidden ≠ Clock hidden。
        if (this.clockRegistry) {
            this.clockRegistry.forEach((clockData) => {
                clockData.object.visible = true;
            });
        }

        // ------------------------------------------------------------
        // LIGHTING PER STATE
        //
        // Tower 是室内、有环境反弹。
        // Timeless Field 是星球表面，环境光来自星云（偏蓝紫），
        // 直射光很弱且偏冷 —— 星球上没有太阳。
        // ------------------------------------------------------------

        if (timelessVisible) {
            this.hemiLight.color.setHex(0x4a5a8c);
            this.hemiLight.groundColor.setHex(0x0a1410);
            this.hemiLight.intensity = 0.85;

            this.dirLight.color.setHex(0x8fa4d0);
            this.dirLight.intensity = 0.35;
            this.dirLight.position.set(-0.4, 0.8, 0.3).normalize();

            // 雾同时解决氛围和草地远处的硬边界
            this.scene.fog = new THREE.FogExp2(0x0a0d1a, 0.035);
        } else {
            this.hemiLight.color.setHex(0xffffff);
            this.hemiLight.groundColor.setHex(0x202020);
            this.hemiLight.intensity = 0.6;

            this.dirLight.color.setHex(0xffffff);
            this.dirLight.intensity = 2;
            this.dirLight.position.set(1, 3, 2).normalize();

            this.scene.fog = null;
            if (this.debugGround) this.debugGround.visible = true;
            if (this.debugGrid) this.debugGrid.visible = true;
        }

        console.log('[State visuals]', {
            state, towerVisible, timelessVisible, clocks: this.clockRegistry?.length ?? 0,
        });
    }

    // ========================================================================
    // TELEPORT PLAYER TO TIMELESS FIELD ORIGIN
    // ========================================================================

    teleportPlayerToTimelessOrigin() {
        if (!this.timelessFieldOriginPosition || !this.dolly) {
            console.warn('[TimelessField] Cannot teleport — Origin not ready');
            return;
        }

        const target = this.timelessFieldOriginPosition;

        // Current headset world position
        const headPosition = new THREE.Vector3();
        this.camera.getWorldPosition(headPosition);

        // ------------------------------------------------------------
        // MOVE XR RIG
        // ------------------------------------------------------------
        //
        // Do NOT directly move the XR camera.
        //
        // Quest controls the camera pose.
        // We move the dolly / player rig instead.
        //
        // For now we only align X and Z.
        // Quest local-floor continues to control player height.
        // ------------------------------------------------------------

        this.dolly.position.x += target.x - headPosition.x;
        this.dolly.position.z += target.z - headPosition.z;

        console.log('[TimelessField] Player teleported to Origin', {
            origin: [target.x.toFixed(3), target.y.toFixed(3), target.z.toFixed(3)],
            headBefore: [headPosition.x.toFixed(3), headPosition.y.toFixed(3), headPosition.z.toFixed(3)],
        });
    }

    // ========================================================================
    // DEBUG STATE KEYS
    //
    // Desktop: 0 Intro / 1 Tower / 2 Special / 3 Collapse / 4 Field / 5 Return / 6 Final Tower
    // ========================================================================

    setupDebugStateControls() {
        window.addEventListener('keydown', (event) => {
            // 模式还没选完之前不响应，避免在加载界面上误触。
            if (!this.runtimeMode) return;

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

        console.log('[State keys] 0 Intro | 1 Tower | 2 Special | 3 Collapse | 4 Field | 5 Return | 6 Final Tower');
    }

    // ========================================================================
    // TEMPORARY AUTOMATIC TEST
    // ========================================================================

    updateDebugStateSequence() {
        if (!DEBUG_AUTO_STATE_TEST || !this.running || !this.timelineStarted) return;

        const t = this.getTimelineTime();

        let targetState = EXPERIENCE_STATE.READ_NOTES;

        if (t >= 18) {
            targetState = EXPERIENCE_STATE.FINAL_TOWER;
        } else if (t >= 8) {
            targetState = EXPERIENCE_STATE.TIMELESS_FIELD;
        } else if (t >= 5) {
            targetState = EXPERIENCE_STATE.COLLAPSE;
        }

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
    // ========================================================================

    setupDrones() {
        this.droneRegistry = DRONE_CONFIG.map((config) => {
            const audioNode = createDroneSpatialChain(this.masterGain, config.position, config.gain);

            return {
                name: config.name,
                position: config.position.clone(),
                audioBuffer: null,       // 由 _bindAudioBuffers() 填入
                audioNode,
                loop: config.loop,
            };
        });
    }

    // ========================================================================
    // CREATE & SCHEDULE ALL AUDIO SOURCES
    //
    // AudioBufferSourceNode 是 one-shot，所以第一次按 Start 的时候才真正创建所有 source。
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
        // STANDALONE: Quest local audio must be fully loaded before playback.
        // MICHIGAN: Quest is not the audio renderer —
        // do not block the artwork timeline on local MP3 readiness.
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
    // AUDIO LISTENER
    //
    // Listener = 玩家头的位置和朝向，Clock Panner = 声源位置。
    // Web Audio 根据这两者的相对位置计算 HRTF。
    // Michigan 模式下没有本地声源，更新 listener 没有意义，直接跳过省一点每帧开销。
    // ========================================================================

    updateAudioListener() {
        if (!this.localAudioEnabled) return;

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
        if (!this.clockRegistry || !this.running || !this.timelineStarted) return;

        // MASTER TIME COMES FROM AUDIO
        const t = this.getTimelineTime();

        this.clockRegistry.forEach((clockData) => {
            // NOT TIME TO MOVE YET
            if (t < clockData.movementStart) return;

            // MOVEMENT PROGRESS: tt = 0 → movement just started, tt = 1 → movement complete
            const tt = (t - clockData.movementStart) / clockData.duration;

            // GET POSITION ON TRAJECTORY
            const pos = clockData.trajectory(clockData.originalPosition, tt);

            // MOVE VISUAL CLOCK
            clockData.object.position.set(pos.x, pos.y, pos.z);

            // MOVE AUDIO PANNER：音频本身一直连续播放，这里只是改变它的空间坐标。
            // Michigan 模式下这个 panner 没接实际 source，写它也不花什么，保留以免两条路径分叉。
            setImmediatePannerPos(clockData.audioNode.panner, pos);
        });

        // DEBUG TIMELINE
        if (!this._timelineDebugFrame) this._timelineDebugFrame = 0;

        if (++this._timelineDebugFrame % 180 === 0) {
            console.log(`[Timeline] ${t.toFixed(3)}s`);
        }
    }

    // ========================================================================
    // VR PANEL
    // ========================================================================

    // Panel 背景和标题单独抽出来，因为选完模式之后要重画一次把模式名写上去。
    // 头显里 DOM 不可见，这是唯一能在 immersive 模式确认当前模式的地方。
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
        px.font = '38px sans-serif';
        px.textAlign = 'center';
        px.fillText('A Thousand Clocks', CW / 2, 58);

        if (this.runtimeMode) {
            px.fillStyle = this.isMichigan ? 'rgba(204,153,255,0.9)' : 'rgba(0,255,136,0.9)';
            px.font = 'bold 22px sans-serif';
            px.fillText(MODE_LABEL[this.runtimeMode], CW / 2, 96);
        }

        if (this.panelTexture) this.panelTexture.needsUpdate = true;
    }

    buildVRPanel() {
        const CW = 720;
        const CH = 260;

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
            new THREE.PlaneGeometry(1.05, 0.38),
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

        this.vrBtnExit = makeButtonMesh('✕  Exit VR', 225, 75, 75);
        this.vrBtnExit.userData.action = 'exit';

        this.vrPanel = new THREE.Group();
        this.vrPanel.add(bg, this.vrBtnStart, this.vrBtnResume, this.vrBtnRestart, this.vrBtnExit);

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
        if (!this.vrPanel) return;

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

        this._refreshPanel();
        this.vrPanel.visible = true;
    }

    hideVRPanel() {
        if (this.vrPanel) this.vrPanel.visible = false;
    }

    async pauseAndShowMenu() {
        if (this.running) await this.stopAudio();

        this.setPanelMode(this.timelineStarted ? 'paused' : 'initial');
        this.showVRPanel();
    }

    resetExperience() {
        if (this.clockRegistry) {
            this.clockRegistry.forEach((clockData) => {
                const source = clockData.audioNode.source;

                if (source) {
                    try { source.stop(); } catch (_) {}
                    try { source.disconnect(); } catch (_) {}
                    clockData.audioNode.source = null;
                }

                clockData.object.position.copy(clockData.originalPosition);
                setImmediatePannerPos(clockData.audioNode.panner, clockData.originalPosition);
            });
        }

        // STOP / RESET FIXED DRONES
        if (this.droneRegistry) {
            this.droneRegistry.forEach((droneData) => {
                const source = droneData.audioNode.source;

                if (source) {
                    try { source.stop(); } catch (_) {}
                    try { source.disconnect(); } catch (_) {}
                    droneData.audioNode.source = null;
                }

                // Drone 永远回到自己的固定世界坐标
                setImmediatePannerPos(droneData.audioNode.panner, droneData.position);
            });
        }

        // RESET PLAYER RIG
        //
        // 进过 Timeless Field 之后 dolly 被 teleport 移动过，
        // Restart 时如果不复位，人会站在上一次跑完停下来的地方。
        // Y 保持不动（眼高设置）。
        if (this.dolly) {
            this.dolly.position.x = 0;
            this.dolly.position.z = 0;
        }

        // RESET NARRATIVE
        this.setExperienceState(EXPERIENCE_STATE.INTRO, 'experience reset');

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
        if (this.running) await this.stopAudio();

        this.resetExperience();

        const session = this.renderer.xr.getSession();

        if (session) await session.end();
    }

    // ------------------------------------------------------------
    // 把一个按钮画成指定状态。mode = 'normal' | 'hover' | 'pressed'
    // 只有状态真的变了才重画 canvas，否则 Quest 会每一帧重传 4 张贴图。
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
        return [this.vrBtnStart, this.vrBtnResume, this.vrBtnRestart, this.vrBtnExit].filter(Boolean);
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
        if (!ctrl || !this.vrPanel || !this.vrPanel.visible) return null;

        const origin = new THREE.Vector3();
        const direction = new THREE.Vector3();

        ctrl.getWorldPosition(origin);
        direction.set(0, 0, -1).transformDirection(ctrl.matrixWorld).normalize();

        this.rc.set(origin, direction);

        const buttons = [this.vrBtnStart, this.vrBtnResume, this.vrBtnRestart, this.vrBtnExit].filter((btn) => btn && btn.visible);

        const hits = this.rc.intersectObjects(buttons, false);

        return hits.length > 0 ? hits[0] : null;
    }

    _processControllers() {
        const buttons = [this.vrBtnStart, this.vrBtnResume, this.vrBtnRestart, this.vrBtnExit].filter((btn) => btn && btn.visible);

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

            // DEBUG：只在 hit 状态改变时打印。注意变量名是 hoveredAction，不能叫 action —— 会和别处的 const action 冲突。
            const hoveredAction = btn?.userData?.action ?? null;

            if (state.debugLastAction !== hoveredAction) {
                console.log(
                    `[UI Ray ${i}]`, hoveredAction ? `HIT → ${hoveredAction}` : 'NO HIT',
                    hit ? { distance: hit.distance.toFixed(3), point: hit.point.toArray().map((v) => v.toFixed(3)) } : '',
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

            // INTERSECT REAL VISIBLE FLOOR
            if (direction.y < -0.001) {
                const t = (this.teleportFloorY - origin.y) / direction.y;

                if (t > 0 && t <= 12) {
                    ts.targetPoint.copy(origin).addScaledVector(direction, t);
                    ts.targetValid = true;

                    if (++this.teleportDebugFrame % 60 === 0) {
                        console.log('[Teleport target]', ts.targetPoint.x.toFixed(2), ts.targetPoint.y.toFixed(2), ts.targetPoint.z.toFixed(2));
                    }
                } else {
                    ts.targetValid = false;
                }
            } else {
                ts.targetValid = false;
            }

            // SHOW TELEPORT TARGET
            if (ts.targetValid) {
                this.teleportMarker.position.set(ts.targetPoint.x, this.teleportFloorY + 0.04, ts.targetPoint.z);
                this.teleportMarker.material.color.set(0x00ff88);
                this.teleportMarker.visible = true;

                // EXTEND CONTROLLER RAY TO TARGET
                const teleportDistance = origin.distanceTo(ts.targetPoint);
                this._updateRayLine(this.ctrlState[i].ray, teleportDistance);

                if (this.ctrlState[i].ray) {
                    const ray = this.ctrlState[i].ray;
                    ray.material.color.set(0x00ff88);

                    const cursor = ray.userData.cursor;

                    if (cursor) cursor.material.color.set(0x00ff88);
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

        // 资产加载完成 + 模式选定之前禁用 ENTER VR。
        this.vrButtonEl = VRButton.createButton(this.renderer);
        document.body.appendChild(this.vrButtonEl);
        this._setVRButtonEnabled(false);

        // DOLLY
        this.dolly = new THREE.Object3D();
        this.dolly.position.set(0, 0, 0);
        this.dolly.add(this.camera);
        this.scene.add(this.dolly);

        this.renderer.xr.addEventListener('sessionstart', () => {
            if (this.inviso) this.inviso.resetCalibration();

            this.controls.enabled = false;
            this.dolly.position.y = this.floorWorldY;

            this.setPanelMode('initial');
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

                // CASE 1: Panel 没有显示 → Trigger = Pause + 呼出 menu
                if (!this.vrPanel.visible) {
                    state.justFired = false;
                    state.pressedBtn = null;

                    await this.pauseAndShowMenu();
                    return;
                }

                // CASE 2: Panel 正在显示。Trigger DOWN 只让按钮进入 PRESSED 状态，
                // 此时绝对不执行 Start / Resume / Restart / Exit，所以用户按住 trigger 的时候
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
                    // IMPORTANT: 不改变 dolly.position.y，所以高度补偿完全保留，只移动 X / Z。
                    const headPosition = new THREE.Vector3();
                    this.camera.getWorldPosition(headPosition);

                    // 不直接写 dolly.x = target.x，因为 Quest 是 room-scale：
                    // 如果你现实里已经从 Guardian 中心走开，headset 本身就有一个 local X/Z offset，
                    // 所以这里移动的是差值。
                    this.dolly.position.x += ts.targetPoint.x - headPosition.x;
                    this.dolly.position.z += ts.targetPoint.z - headPosition.z;
                }

                ts.aiming = false;
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
    // ========================================================================

    render() {
        try {
            this.clock.getDelta(); // Three Clock 继续 tick，但是作品时间不再由它决定。
            this.stats.update();

            this._processControllers();
            this.updateTeleport();

            this.updateClocks();                 // Movement 从 Web Audio master timeline 读取时间。
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