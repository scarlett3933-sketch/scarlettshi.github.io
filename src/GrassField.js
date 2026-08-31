import * as THREE from 'three';

// ============================================================================
// GRASS FIELD
//
// 把 GrassClump.glb 撒到 TimelessField_Planet.glb 的表面上。
//
// 形状：Spencer 的 donut 是一个 spindle torus（管半径 198 > 环半径 102，
// 管子粗到把中间的洞吞掉了）。这是他的设计意图，不是导出问题。
// 后果是表面大部分区域接近 37° 的恒定斜面，只有约 17% 的面积够平能站人。
//
// ============================================================================
// 为什么改成局部撒点
//
// 旧版对整个表面做面积加权采样。这在几十米的场地上没问题，
// 但 donut 一旦做大就彻底失效 —— 表面积按尺寸的平方增长：
//
//     外径  65 m  →  表面积   9,355 m²  →  铺满需要  14,000 簇   ✓
//     外径 300 m  →  表面积 199,279 m²  →  铺满需要 299,000 簇   ✗
//     外径 600 m  →  表面积 797,117 m²  →  铺满需要 1,196,000 簇  ✗
//
// Quest 3 整个场景的三角形预算大约 30 万。所以"整个表面铺满草"
// 只有在 65 米时成立 —— 而那个尺寸小到看起来像个碗。
//
// 现在改成：只在参与者脚下一个半径内撒，远处交给雾。
// 这样草的开销和 donut 的大小完全脱钩，Spencer 想做多大做多大。
//
// 密度还带径向衰减：中心最密，接近边界逐渐稀疏。
// 好处有两个 —— 一是省下的配额可以用来把中心堆得更密，
// 二是没有一圈突兀的硬边界，草是渐渐淡进雾里的。
// ============================================================================

const UP = new THREE.Vector3(0, 1, 0);

// ============================================================================
// SOURCE CLUMP PREP
//
// GrassClump.glb 有三个问题必须在这里修掉，都不需要回去找 Spencer：
//
//   1. 节点上有没归零的 translation [-47.34, -4.54, -47.07]
//      → 只取几何体，完全丢弃节点变换
//   2. 原点在半腰不在根部（几何 Y 范围 -0.342 … 0.519）
//      → 整体上移，让最低点落在 y = 0
//   3. XZ 不居中（X 中心在 -0.25）
//      → 不居中的话，绕 Y 随机旋转会让草簇甩圈而不是原地转
// ============================================================================

function prepareClumpPrimitives(clumpScene, { flattenNormals = true } = {}) {
    const sources = [];

    clumpScene.updateMatrixWorld(true);

    clumpScene.traverse((object) => {
        if (!object.isMesh) return;

        sources.push({
            geometry: object.geometry.clone(),
            material: object.material,
        });
    });

    if (sources.length === 0) {
        throw new Error('[GrassField] GrassClump.glb 里没有找到任何 mesh。');
    }

    // 三个 primitive 共同的包围盒 —— 必须一起算，
    // 分开算会让三组卡片各自被推到不同高度，草簇就散架了。
    const union = new THREE.Box3();

    sources.forEach(({ geometry }) => {
        geometry.computeBoundingBox();
        union.union(geometry.boundingBox);
    });

    const offsetX = -(union.min.x + union.max.x) / 2;
    const offsetY = -union.min.y;                       // 根部落到 y = 0
    const offsetZ = -(union.min.z + union.max.z) / 2;

    const clumpHeight = union.max.y - union.min.y;

    sources.forEach(({ geometry }) => {
        geometry.translate(offsetX, offsetY, offsetZ);

        // Spencer 导出的法线是每张卡片自己的朝向（例如 [-0.9, 0.41, 0.13]），
        // 也就是横着指向侧面。植被用这种法线打光会一片一片地闪，
        // 因为相邻卡片的法线差了将近 90°。改成统一朝上之后，
        // 每簇草受光一致，读起来才像草丛而不像立着的纸片。
        if (flattenNormals) {
            const normal = geometry.getAttribute('normal');

            if (normal) {
                for (let i = 0; i < normal.count; i++) {
                    normal.setXYZ(i, 0, 1, 0);
                }

                normal.needsUpdate = true;
            }
        }

        geometry.computeBoundingBox();
        geometry.computeBoundingSphere();
    });

    const triangleCount = sources.reduce((sum, { geometry }) => {
        const index = geometry.getIndex();
        const count = index ? index.count : geometry.getAttribute('position').count;

        return sum + count / 3;
    }, 0);

    return {
        sources,
        clumpHeight,
        triangleCount,
        appliedOffset: new THREE.Vector3(offsetX, offsetY, offsetZ),
    };
}

// ============================================================================
// RADIAL FALLOFF
//
// 距离中心 falloffStart × radius 以内是满密度，
// 之后平滑降到边界处的 0。用 smoothstep 而不是线性，
// 线性衰减在起点处有个可见的折角。
// ============================================================================

function radialWeight(distance, radius, falloffStart) {
    if (distance >= radius) return 0;

    const inner = radius * falloffStart;

    if (distance <= inner) return 1;

    const t = (distance - inner) / (radius - inner);   // 0 … 1

    return 1 - t * t * (3 - 2 * t);                    // smoothstep 反向
}

// ============================================================================
// SURFACE TRIANGLES
//
// 把目标表面的三角形收集成世界坐标下的一张表，同时算出每个三角形的
// 面积和法线。
//
// 和旧版的区别：现在每个三角形还带一个 weight = 面积 × 径向衰减。
// 采样按 weight 而不是面积做加权，所以：
//   - 半径之外的三角形 weight = 0，直接不参与，连遍历成本都省了
//   - 边缘的三角形被选中的概率低，草自然变稀
//
// 面积加权本身仍然保留 —— 大三角形被选中的概率更高，
// 否则草会在网格细分密的地方堆成一坨。
// ============================================================================

function collectSurfaceTriangles(surfaceRoot, { minNormalY, center, radius, falloffStart }) {
    surfaceRoot.updateMatrixWorld(true);

    const triangles = [];

    let totalArea = 0;
    let rejectedByNormal = 0;
    let rejectedByRadius = 0;
    let weightedArea = 0;

    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const ab = new THREE.Vector3();
    const ac = new THREE.Vector3();
    const cross = new THREE.Vector3();

    // 局部撒点时用三角形重心到中心的**三维**距离做筛选。
    //
    // 一开始写的是水平距离，在 spindle torus 上错得离谱：
    // 管壁近乎垂直，水平 60 m 的一圈会捞进上下两百多米的管壁，
    // 有效面积翻一倍，包围球半径 205 m（等于放弃视锥剔除），
    // 而且草会长在头顶和脚下的墙上。
    // 三维距离才对应"我站着能看到的一圈"。
    const useRadius = Boolean(center) && radius > 0;

    surfaceRoot.traverse((object) => {
        if (!object.isMesh) return;

        const geometry = object.geometry;
        const position = geometry.getAttribute('position');

        if (!position) return;

        const index = geometry.getIndex();
        const triCount = index ? index.count / 3 : position.count / 3;

        for (let t = 0; t < triCount; t++) {
            const i0 = index ? index.getX(t * 3 + 0) : t * 3 + 0;
            const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
            const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;

            a.fromBufferAttribute(position, i0).applyMatrix4(object.matrixWorld);
            b.fromBufferAttribute(position, i1).applyMatrix4(object.matrixWorld);
            c.fromBufferAttribute(position, i2).applyMatrix4(object.matrixWorld);

            ab.subVectors(b, a);
            ac.subVectors(c, a);
            cross.crossVectors(ab, ac);

            const length = cross.length();
            const area = length * 0.5;

            if (area <= 1e-9) continue;

            totalArea += area;

            const ny = cross.y / length;

            // 朝下的面和过陡的斜坡不撒草。
            if (ny < minNormalY) {
                rejectedByNormal += area;
                continue;
            }

            let weight = area;

            if (useRadius) {
                const cx = (a.x + b.x + c.x) / 3;
                const cy = (a.y + b.y + c.y) / 3;
                const cz = (a.z + b.z + c.z) / 3;

                const distance = Math.hypot(cx - center.x, cy - center.y, cz - center.z);
                const falloff = radialWeight(distance, radius, falloffStart);

                if (falloff <= 0) {
                    rejectedByRadius += area;
                    continue;
                }

                weight = area * falloff;
            }

            weightedArea += weight;

            triangles.push({
                a: a.clone(),
                ab: ab.clone(),
                ac: ac.clone(),
                normal: cross.clone().divideScalar(length),
                area,
                weight,
            });
        }
    });

    // 累积权重表，采样时二分查找。
    const cumulative = new Float64Array(triangles.length);

    let running = 0;

    for (let i = 0; i < triangles.length; i++) {
        running += triangles[i].weight;
        cumulative[i] = running;
    }

    return {
        triangles,
        cumulative,
        weightedArea: running,
        totalArea,
        rejectedByNormal,
        rejectedByRadius,
    };
}

function pickTriangleIndex(cumulative, target) {
    let low = 0;
    let high = cumulative.length - 1;

    while (low < high) {
        const mid = (low + high) >> 1;

        if (cumulative[mid] < target) {
            low = mid + 1;
        } else {
            high = mid;
        }
    }

    return low;
}

// 可重现的伪随机。撒点必须每次一样，否则每 reload 一次草的位置就变一次，
// 调试时永远对不上现象，headset 上更难判断是不是自己改的东西起了作用。
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
// BUILD
// ============================================================================

/**
 * @param {THREE.Object3D} clumpScene    GrassClump.glb 的 gltf.scene
 * @param {THREE.Object3D} surfaceRoot   要撒草的表面（Planet），必须已经是最终世界变换
 *
 * 关键选项：
 *   center   撒草的中心（通常 = 出生点）。传 null 就回到旧的全表面撒点。
 *   radius   撒草半径（世界单位 = 米）。超出这个距离一簇都不撒。
 */
export function createGrassField(clumpScene, surfaceRoot, options = {}) {
    const {
        // 撒草中心。传 null / undefined = 整个表面（donut 大了会被截断，见文件头注释）。
        center = null,

        // 撒草半径。雾在 0.004 时可见度约 250 m，
        // 所以 70 m 的边界完全落在雾里，看不出硬边。
        radius = 60,

        // 从半径的百分之几开始变稀。0.45 = 前 45% 满密度，之后平滑降到 0。
        falloffStart = 0.45,

        // 满密度区每平方米撒几簇。
        // 每簇 scale 2.0 时高约 1.7 m、地面足迹直径约 1 m，
        // 2.2 簇/m² 就已经互相重叠、看不见地面了。
        //
        // 这三个数（radius / falloffStart / density）是一起定的：
        // 带衰减的有效面积约等于 0.6 × πR²，再乘地形起伏系数约 1.2。
        // radius 60 / density 2.2 → 约 13,400 簇，在 16,000 之内还留有余量。
        // 动其中任何一个都要回头看 console 有没有报截断。
        density = 2.2,

        // 硬上限。三角形预算 = maxInstances × 每簇三角形数。
        maxInstances = 16000,

        // 草簇相对原始尺寸的缩放。GrassClump 原本高约 0.85 单位。
        scale = 2.0,

        // 每簇随机缩放的浮动比例，0.35 = 0.65× … 1.35×。
        scaleVariance = 0.35,

        // 法线 Y 分量下限。1 = 只有完全水平的面，0 = 所有朝上的面。
        // spindle torus 大部分是 37° 斜面（normal.y ≈ 0.8），
        // 0.35 能覆盖到它们，再高就会在斜坡上留一大片秃地。
        minNormalY = 0.35,

        // 草簇朝向在「世界向上」和「表面法线」之间插值。
        // 1 = 完全贴合坡面（陡坡上会横着长），0 = 永远竖直（陡坡上会浮空）。
        alignToNormal = 0.55,

        // 沿表面法线往下沉多少，避免曲面上根部露出缝隙。
        sink = 0.05,

        flattenNormals = true,
        seed = 20260830,
    } = options;

    const t0 = performance.now();

    const { sources, clumpHeight, triangleCount, appliedOffset } =
        prepareClumpPrimitives(clumpScene, { flattenNormals });

    const surface = collectSurfaceTriangles(surfaceRoot, {
        minNormalY,
        center,
        radius,
        falloffStart,
    });

    if (surface.triangles.length === 0) {
        console.warn(
            center
                ? `[GrassField] 中心 [${center.x.toFixed(1)}, ${center.z.toFixed(1)}] ` +
                  `半径 ${radius} m 之内没有满足 minNormalY=${minNormalY} 的三角形，草场为空。` +
                  `检查出生点是不是落在洞里或者太陡的地方。`
                : `[GrassField] 表面上没有满足 minNormalY=${minNormalY} 的三角形，草场为空。`,
        );

        return null;
    }

    const wanted = Math.floor(surface.weightedArea * density);
    const count = Math.min(wanted, maxInstances);

    const random = makeRandom(seed);

    const matrices = new Array(count);

    const point = new THREE.Vector3();
    const up = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const yaw = new THREE.Quaternion();
    const scaleVec = new THREE.Vector3();

    // 草实际占据的范围，用来算包围球。
    const grassBounds = new THREE.Box3();

    for (let i = 0; i < count; i++) {
        const triangle = surface.triangles[
            pickTriangleIndex(surface.cumulative, random() * surface.weightedArea)
        ];

        // 三角形内均匀取点：折叠 u+v>1 的那一半，否则会集中在一个角。
        let u = random();
        let v = random();

        if (u + v > 1) {
            u = 1 - u;
            v = 1 - v;
        }

        point.copy(triangle.a)
            .addScaledVector(triangle.ab, u)
            .addScaledVector(triangle.ac, v);

        up.copy(UP).lerp(triangle.normal, alignToNormal).normalize();

        point.addScaledVector(up, -sink);

        quaternion.setFromUnitVectors(UP, up);
        yaw.setFromAxisAngle(up, random() * Math.PI * 2);
        quaternion.premultiply(yaw);

        const s = scale * (1 + (random() - 0.5) * 2 * scaleVariance);
        scaleVec.set(s, s, s);

        matrices[i] = new THREE.Matrix4().compose(point, quaternion, scaleVec);

        grassBounds.expandByPoint(point);
    }

    // ------------------------------------------------------------
    // INSTANCED MESHES
    //
    // 三个 primitive 共用同一份 matrices —— 它们是同一簇草的三组卡片，
    // 不是三个独立变体，分开撒会把每簇拆散。
    // ------------------------------------------------------------

    const group = new THREE.Group();
    group.name = 'GrassField';

    // InstancedMesh 默认用源几何体（约 1 单位）的包围球做视锥剔除，
    // 结果就是人一转头整片草就整体消失。手动换成草的实际范围。
    //
    // 旧版这里用的是整个星球的包围球 —— 局部撒点之后那个球大了几十倍，
    // 等于放弃了剔除。现在只包住草自己，转身背对草地时能真的剔掉。
    const boundingSphere = new THREE.Sphere();

    grassBounds.getBoundingSphere(boundingSphere);
    boundingSphere.radius += clumpHeight * scale * (1 + scaleVariance);

    sources.forEach(({ geometry, material }, index) => {
        const instanced = new THREE.InstancedMesh(geometry, material, count);

        instanced.name = `GrassField_${index}`;

        for (let i = 0; i < count; i++) {
            instanced.setMatrixAt(i, matrices[i]);
        }

        instanced.instanceMatrix.needsUpdate = true;

        // 撒完之后不再改动，告诉 Three.js 不用每帧重传矩阵缓冲。
        instanced.instanceMatrix.setUsage(THREE.StaticDrawUsage);

        instanced.boundingSphere = boundingSphere.clone();
        instanced.frustumCulled = true;

        instanced.castShadow = false;
        instanced.receiveShadow = false;

        group.add(instanced);
    });

    // 之后想重新撒（例如参与者 teleport 走远了）需要的信息，挂在 group 上。
    group.userData.grassCenter = center ? center.clone() : null;
    group.userData.grassRadius = radius;

    const totalTriangles = count * triangleCount;

    console.log(
        `%c[GrassField] ${count.toLocaleString()} 簇 / ${totalTriangles.toLocaleString()} 三角形 / ` +
        `${sources.length} draw call` +
        (center ? `  —  中心半径 ${radius} m 局部撒点` : '  —  全表面撒点'),
        'color:#7ed957;font-weight:bold',
    );

    console.log('[GrassField]', {
        mode: center ? 'local' : 'whole-surface',
        center: center ? center.toArray().map((v) => Number(v.toFixed(1))) : null,
        radius,
        falloffStart,
        weightedArea: Number(surface.weightedArea.toFixed(1)),
        totalSurfaceArea: Number(surface.totalArea.toFixed(1)),
        rejectedByNormal: Number(surface.rejectedByNormal.toFixed(1)),
        rejectedByRadius: Number(surface.rejectedByRadius.toFixed(1)),
        usableTriangles: surface.triangles.length,
        requested: wanted,
        placed: count,
        cappedByMaxInstances: wanted > maxInstances,
        clumpHeight: Number(clumpHeight.toFixed(3)),
        clumpPivotOffset: appliedOffset.toArray().map((v) => Number(v.toFixed(3))),
        effectiveHeight: Number((clumpHeight * scale).toFixed(3)),
        cullingRadius: Number(boundingSphere.radius.toFixed(1)),
        buildMs: Number((performance.now() - t0).toFixed(1)),
    });

    if (wanted > maxInstances) {
        console.warn(
            `[GrassField] density=${density} 在半径 ${radius} m 内需要 ${wanted.toLocaleString()} 簇，` +
            `被 maxInstances=${maxInstances.toLocaleString()} 截断。` +
            `要么降 density，要么缩小 radius —— 别直接抬 maxInstances，` +
            `每簇 ${triangleCount} 三角形，${maxInstances.toLocaleString()} 已经是 ` +
            `${(maxInstances * triangleCount / 1000).toFixed(0)}k 三角形了。`,
        );
    }

    // 撒点范围明显小于半径，通常意味着出生点附近的地形不满足 minNormalY。
    if (center) {
        const actualRadius = Math.max(
            grassBounds.max.x - center.x, center.x - grassBounds.min.x,
            grassBounds.max.y - center.y, center.y - grassBounds.min.y,
            grassBounds.max.z - center.z, center.z - grassBounds.min.z,
        );

        if (actualRadius < radius * 0.6) {
            console.warn(
                `[GrassField] 草实际只铺到 ${actualRadius.toFixed(1)} m，远小于 radius=${radius} m。` +
                `出生点周围大部分地形比 minNormalY=${minNormalY} 更陡，或者已经到了 donut 边缘。`,
            );
        }
    }

    return group;
}

// ============================================================================
// SURFACE SAMPLING
//
// spindle torus 上没有一个固定的「地面高度」，所以落脚点必须靠射线找。
// teleport 和初始出生点都要用这个。
// ============================================================================

const _downRaycaster = new THREE.Raycaster();
const _downOrigin = new THREE.Vector3();
const _down = new THREE.Vector3(0, -1, 0);

/**
 * 从 (x, fromY, z) 垂直向下打一条射线，返回最先撞到的表面点和法线。
 * 打不中返回 null。
 */
export function sampleSurfaceBelow(surfaceRoot, x, z, fromY = 1000) {
    _downOrigin.set(x, fromY, z);
    _downRaycaster.set(_downOrigin, _down);

    // donut 会自我重叠，同一条 XZ 上可能有上下两层。
    // 这里取最上面那层。要指定层请用 app.js 里的 _resolveSpawnFromAnchor，
    // 它会挑最接近期望高度的那一层。
    _downRaycaster.firstHitOnly = true;

    const hits = _downRaycaster.intersectObject(surfaceRoot, true);

    if (hits.length === 0) return null;

    return {
        point: hits[0].point.clone(),
        normal: hits[0].face
            ? hits[0].face.normal.clone().transformDirection(hits[0].object.matrixWorld).normalize()
            : UP.clone(),
        object: hits[0].object,
    };
}

// ============================================================================
// 已废弃：findSpawnPoint
//
// 它从 bounding box 中心向外螺旋找第一块平地。对 spindle torus 来说
// bbox 中心是管子内部或者洞，射线要么打空要么打在内壁上，
// 落点完全由几何体的偶然形状决定，和创作意图无关。
//
// 现在出生点由 app.js 顶部的 SPAWN_ANCHOR 常量指定（归一化坐标），
// 由 _resolveSpawnFromAnchor() 解析。不要再用这个函数。
// 保留导出只是为了不破坏可能还引用它的旧代码。
// ============================================================================

export function findSpawnPoint(surfaceRoot, { minNormalY = 0.85, maxRadius = 30, samples = 400 } = {}) {
    console.warn(
        '[GrassField] findSpawnPoint 已废弃 —— 它对 spindle torus 会给出无意义的落点。' +
        '请改用 app.js 的 SPAWN_ANCHOR + _resolveSpawnFromAnchor()。',
    );

    const bounds = new THREE.Box3().setFromObject(surfaceRoot);
    const center = bounds.getCenter(new THREE.Vector3());
    const top = bounds.max.y + 10;

    for (let i = 0; i < samples; i++) {
        const t = i / samples;
        const radius = t * maxRadius;
        const angle = t * Math.PI * 2 * 8;

        const hit = sampleSurfaceBelow(
            surfaceRoot,
            center.x + Math.cos(angle) * radius,
            center.z + Math.sin(angle) * radius,
            top,
        );

        if (hit && hit.normal.y >= minNormalY) return hit;
    }

    return null;
}
