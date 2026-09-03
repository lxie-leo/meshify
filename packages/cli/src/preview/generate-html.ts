import * as fs from 'node:fs';
import * as path from 'node:path';
import type { MeshifyReport } from '@meshify/core';

/**
 * before/after 对比预览页（plan §Step 3.1）：自包含单文件 HTML。
 * - GLB 以 base64 内嵌（零外部文件依赖），three.js 走 CDN（jsdelivr → unpkg 回退）
 * - 双视窗联动（共享相机状态：旋转/平移/缩放同步）
 * - 坑 10 防护：网格缺 NORMAL 属性时对该网格材质开 flatShading（避免产物看起来比预览暗）
 * - 坑 11 防护：按贴图平均亮度分段调 envMapIntensity（近白贴图不过曝白糊）
 *   TEXTURED_ENV_BASE=0.65 / ENV_MIN=0.3 / ENV_MAX=0.85 / KNEE=0.5
 * - 叠加 manifest 指标面板（面数/体积/警告）
 */

export interface PreviewModel {
	label: string;
	/** GLB 字节（多个部件逐个列出，全部装入 after 视窗） */
	bytes: Uint8Array;
}

export interface PreviewSpec {
	before: PreviewModel[];
	after: PreviewModel[];
	report: MeshifyReport;
	outPath: string;
}

const THREE_VERSION = '0.170.0';

export function writePreviewHtml(spec: PreviewSpec): string {
	const data = {
		report: spec.report,
		before: spec.before.map((m) => ({ label: m.label, b64: toBase64(m.bytes) })),
		after: spec.after.map((m) => ({ label: m.label, b64: toBase64(m.bytes) })),
	};
	const payload = JSON.stringify(data).replace(/</g, '\\u003c');
	// 注意 replace(string) 只换第一处：__THREE_VERSION__ 在模板里出现两次（jsdelivr + unpkg 回退）
	const html = HTML_TEMPLATE.replace(/__DATA__/g, () => payload).replace(/__THREE_VERSION__/g, THREE_VERSION);
	fs.mkdirSync(path.dirname(path.resolve(spec.outPath)), { recursive: true });
	fs.writeFileSync(spec.outPath, html, 'utf-8');
	return spec.outPath;
}

function toBase64(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString('base64');
}

const HTML_TEMPLATE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>meshify preview</title>
<style>
  html, body { margin: 0; height: 100%; background: #14171d; color: #dde3ec;
    font-family: "Segoe UI", "Microsoft YaHei", system-ui, sans-serif; overflow: hidden; }
  #app { display: flex; flex-direction: column; height: 100%; }
  header { padding: 8px 14px; font-size: 13px; color: #9fb0c8; background: #1b2028;
    border-bottom: 1px solid #2a3240; display: flex; gap: 16px; align-items: baseline; }
  header b { color: #e8eef7; font-size: 15px; }
  #panes { flex: 1; display: flex; min-height: 0; }
  .pane { flex: 1; position: relative; min-width: 0; }
  .pane + .pane { border-left: 1px solid #2a3240; }
  .pane .tag { position: absolute; top: 10px; left: 12px; z-index: 2; font-size: 12px;
    padding: 2px 10px; border-radius: 10px; background: rgba(20,24,31,.75); color: #b9c6da; }
  .pane canvas { display: block; width: 100%; height: 100%; }
  #metrics { position: fixed; right: 12px; top: 44px; z-index: 3; width: 300px; max-height: 70vh;
    overflow: auto; background: rgba(22,26,34,.92); border: 1px solid #2a3240; border-radius: 8px;
    padding: 10px 14px; font-size: 12px; line-height: 1.7; }
  #metrics h3 { margin: 0 0 4px; font-size: 12px; color: #7f93b1; font-weight: 600; }
  #metrics .row { display: flex; justify-content: space-between; gap: 10px; }
  #metrics .row span:last-child { color: #e8eef7; }
  #metrics .warn { color: #e8c268; }
  #status { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center;
    background: #14171d; z-index: 10; font-size: 14px; color: #9fb0c8; flex-direction: column; gap: 12px; }
  #status.err { color: #e88; white-space: pre-wrap; padding: 0 24px; text-align: center; }
</style>
</head>
<body>
<div id="app">
  <header>
    <b>meshify preview</b>
    <span id="head-cmd"></span>
    <span>拖动旋转 · 滚轮缩放 · 右键平移（双视窗联动）</span>
  </header>
  <div id="panes">
    <div class="pane" id="pane-before"><div class="tag">BEFORE · 原始</div></div>
    <div class="pane" id="pane-after"><div class="tag">AFTER · 产物</div></div>
  </div>
</div>
<div id="metrics"></div>
<div id="status">加载中…<div id="status-sub" style="font-size:12px;color:#5c6b82"></div></div>
<script>
var DATA = __DATA__;

function setStatus(msg, sub, isErr) {
  var el = document.getElementById('status');
  el.textContent = msg;
  if (isErr) el.className = 'err';
  var s = document.getElementById('status-sub');
  s.textContent = sub || '';
}

function b64ToBytes(b64) {
  var bin = atob(b64);
  var u8 = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8.buffer;
}

function pickCdn() {
  var bases = [
    'https://cdn.jsdelivr.net/npm/three@__THREE_VERSION__/',
    'https://unpkg.com/three@__THREE_VERSION__/'
  ];
  var idx = 0;
  function tryNext() {
    if (idx >= bases.length) return Promise.reject(new Error('three.js CDN 不可达（jsdelivr / unpkg 均失败）。预览页需要网络加载 three.js，请联网后重试。'));
    var base = bases[idx++];
    return fetch(base + 'package.json', { method: 'HEAD' })
      .then(function (r) { if (!r.ok) throw new Error('bad'); return base; })
      .catch(tryNext);
  }
  return tryNext();
}

// ---- maestro 坑 11 常量：贴图亮度 → 环境光强度分段映射 ----
var TEXTURED_ENV_BASE = 0.65;
var ENV_MIN = 0.3;
var ENV_MAX = 0.85;
var KNEE = 0.5;

function envIntensityForLuminance(L) {
  if (L < KNEE) return ENV_MAX - (ENV_MAX - TEXTURED_ENV_BASE) * (L / KNEE);
  return TEXTURED_ENV_BASE - (TEXTURED_ENV_BASE - ENV_MIN) * ((L - KNEE) / (1 - KNEE));
}

function textureLuminance(img) {
  var c = document.createElement('canvas');
  var s = 32;
  c.width = s; c.height = s;
  var ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0, s, s);
  var d = ctx.getImageData(0, 0, s, s).data;
  var sum = 0, n = 0;
  for (var i = 0; i < d.length; i += 4) {
    sum += (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
    n++;
  }
  return n ? sum / n : 0.5;
}

function collectMaterials(root) {
  var seen = {};
  root.traverse(function (o) {
    if (!o.isMesh) return;
    var mats = Array.isArray(o.material) ? o.material : [o.material];
    for (var i = 0; i < mats.length; i++) {
      if (mats[i]) seen[uuidOf(mats[i])] = mats[i];
    }
  });
  var out = [];
  for (var k in seen) out.push(seen[k]);
  return out;
  function uuidOf(m) { return m.uuid || (m.uuid = 'm' + Math.random()); }
}

function fixMeshShading(root) {
  // 坑 10：缺 NORMAL 的网格开 flatShading（glTF 规范本要求客户端算平面法线，
  // three.js 不自动处理 → 显式开启，避免渲染偏暗/错误）
  root.traverse(function (o) {
    if (!o.isMesh) return;
    var hasNormal = !!(o.geometry && o.geometry.getAttribute && o.geometry.getAttribute('normal'));
    var mats = Array.isArray(o.material) ? o.material : [o.material];
    for (var i = 0; i < mats.length; i++) {
      var m = mats[i];
      if (!m) continue;
      if (!hasNormal && m.flatShading !== true) { m.flatShading = true; m.needsUpdate = true; }
    }
  });
}

function applyEnvIntensity(root) {
  var mats = collectMaterials(root);
  var jobs = [];
  for (var i = 0; i < mats.length; i++) {
    (function (m) {
      if (m.map && m.map.image) {
        jobs.push(Promise.resolve().then(function () {
          return textureLuminance(m.map.image);
        }).then(function (L) {
          m.envMapIntensity = envIntensityForLuminance(L);
        }).catch(function () {
          m.envMapIntensity = TEXTURED_ENV_BASE;
        }));
      } else {
        m.envMapIntensity = ENV_MAX;
      }
    })(mats[i]);
  }
  return Promise.all(jobs);
}

function createViewer(pane, THREE, envTexture) {
  var renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio || 1);
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';
  pane.appendChild(renderer.domElement);
  var scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1e26);
  if (envTexture) scene.environment = envTexture;
  var grid = new THREE.GridHelper(10, 20, 0x2c3a4f, 0x222a36);
  grid.position.y = 0;
  scene.add(grid);
  function resize() {
    var w = pane.clientWidth || 1, h = pane.clientHeight || 1;
    renderer.setSize(w, h, false);
  }
  new ResizeObserver(resize).observe(pane);
  resize();
  return { renderer: renderer, scene: scene, pane: pane };
}

function attachControls(canvases, camera) {
  // 共享相机状态：任一视窗操作，两视窗同步
  var state = { theta: Math.PI / 4, phi: Math.PI / 3, radius: 5, target: { x: 0, y: 0, z: 0 } };
  var drag = null;
  function pos(e) {
    return { x: e.clientX, y: e.clientY, button: e.button, ctrl: e.ctrlKey };
  }
  for (var ci = 0; ci < canvases.length; ci++) {
    (function (canvas) {
      canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });
      canvas.addEventListener('pointerdown', function (e) {
        drag = pos(e);
        canvas.setPointerCapture(e.pointerId);
      });
      canvas.addEventListener('pointermove', function (e) {
        if (!drag) return;
        var p = pos(e);
        var dx = p.x - drag.x, dy = p.y - drag.y;
        drag = p;
        if (p.button === 2 || p.ctrl) {
          // 平移（相机右/上向量）
          var panScale = state.radius * 0.0016;
          var right = { x: Math.cos(state.theta), y: 0, z: -Math.sin(state.theta) };
          state.target.x -= right.x * dx * panScale;
          state.target.z -= right.z * dx * panScale;
          state.target.y += dy * panScale;
        } else {
          state.theta -= dx * 0.008;
          state.phi = Math.min(Math.max(state.phi - dy * 0.008, 0.05), Math.PI - 0.05);
        }
      });
      canvas.addEventListener('pointerup', function () { drag = null; });
      canvas.addEventListener('wheel', function (e) {
        e.preventDefault();
        state.radius *= Math.exp(e.deltaY * 0.0012);
        state.radius = Math.min(Math.max(state.radius, 0.05), 1e4);
      }, { passive: false });
    })(canvases[ci]);
  }
  function update() {
    var sp = Math.sin(state.phi);
    camera.position.set(
      state.target.x + state.radius * sp * Math.sin(state.theta),
      state.target.y + state.radius * Math.cos(state.phi),
      state.target.z + state.radius * sp * Math.cos(state.theta)
    );
    camera.lookAt(state.target.x, state.target.y, state.target.z);
  }
  return { update: update, state: state };
}

function fitCamera(controls, box) {
  if (box.isEmpty()) return;
  var size = { x: box.max.x - box.min.x, y: box.max.y - box.min.y, z: box.max.z - box.min.z };
  var maxDim = Math.max(size.x, size.y, size.z) || 1;
  var center = { x: (box.min.x + box.max.x) / 2, y: (box.min.y + box.max.y) / 2, z: (box.min.z + box.max.z) / 2 };
  controls.state.target = center;
  controls.state.radius = maxDim * 1.9;
}

function renderMetrics(report) {
  var el = document.getElementById('metrics');
  var rows = [];
  function row(k, v) { rows.push('<div class="row"><span>' + k + '</span><span>' + v + '</span></div>'); }
  var m = report.metrics || {};
  row('命令', report.command);
  row('Tier', report.tool && report.tool.tier);
  row('耗时', ((m.duration_ms || 0) / 1000).toFixed(2) + ' s');
  if (report.input) row('输入面数', (report.input.faces || 0).toLocaleString());
  if (report.output) {
    row('输出面数', (report.output.faces || 0).toLocaleString());
    row('输入体积', fmtBytes(report.input.bytes));
    row('输出体积', fmtBytes(report.output.bytes));
  }
  if (m.face_reduction !== undefined) row('面数削减', (100 * m.face_reduction).toFixed(1) + '%');
  if (m.byte_reduction !== undefined) row('体积削减', (100 * m.byte_reduction).toFixed(1) + '%');
  if (m.max_error_normalized !== undefined) row('最大误差(归一化)', m.max_error_normalized.toPrecision(3));
  if (m.parts) row('部件数', String(m.parts.length));
  if (m.lod_levels) row('LOD 级数', String(m.lod_levels.length));
  var html = '<h3>指标</h3>' + rows.join('');
  if (report.warnings && report.warnings.length) {
    html += '<h3 style="margin-top:10px">警告 (' + report.warnings.length + ')</h3>';
    for (var i = 0; i < report.warnings.length; i++) {
      var w = report.warnings[i];
      html += '<div class="warn">[' + w.code + '] ' + escapeHtml(w.message) + '</div>';
    }
  }
  html += '<div style="margin-top:10px;color:#5c6b82">完整报告见 .report.json</div>';
  el.innerHTML = html;
  document.getElementById('head-cmd').textContent =
    report.command + ' · ' + (report.input ? report.input.format : '');
}

function fmtBytes(n) {
  if (n === undefined || n === null) return '-';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(2) + ' MB';
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function main() {
  if (!DATA.report) { setStatus('预览数据缺失'); return; }
  renderMetrics(DATA.report);
  setStatus('加载 three.js…');
  var THREE, GLTFLoader, RoomEnvironment;
  return pickCdn().then(function (base) {
    var map = document.createElement('script');
    map.type = 'importmap';
    map.textContent = JSON.stringify({
      imports: { three: base + 'build/three.module.js', 'three/addons/': base + 'examples/jsm/' }
    });
    document.head.appendChild(map);
    setStatus('初始化渲染器…');
    return import('three').then(function (mod1) {
      THREE = mod1;
      return import('three/addons/loaders/GLTFLoader.js');
    }).then(function (mod2) {
      GLTFLoader = mod2.GLTFLoader;
      return import('three/addons/environments/RoomEnvironment.js');
    }).then(function (mod3) {
      RoomEnvironment = mod3.RoomEnvironment;
      setStatus('解析模型…');
      return boot(THREE, GLTFLoader, RoomEnvironment);
    });
  }).then(function () {
    var el = document.getElementById('status');
    el.style.display = 'none';
  }).catch(function (err) {
    setStatus('预览初始化失败：' + (err && err.message ? err.message : String(err)), '', true);
  });
}

function boot(THREE, GLTFLoader, RoomEnvironment) {
  var camera = new THREE.PerspectiveCamera(50, 1, 0.01, 1e5);
  var pmrem = new THREE.PMREMGenerator(new THREE.WebGLRenderer());
  var envTexture = null;
  try {
    envTexture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  } catch (e) { /* 环境贴图失败不致命 */ }

  var vBefore = createViewer(document.getElementById('pane-before'), THREE, envTexture);
  var vAfter = createViewer(document.getElementById('pane-after'), THREE, envTexture);
  var controls = attachControls([vBefore.renderer.domElement, vAfter.renderer.domElement], camera);

  var loader = new GLTFLoader();
  function loadInto(scene, models) {
    var chain = Promise.resolve();
    var box = new THREE.Box3();
    models.forEach(function (m) {
      chain = chain.then(function () {
        return loader.parseAsync(b64ToBytes(m.b64), '').then(function (gltf) {
          fixMeshShading(gltf.scene);
          return applyEnvIntensity(gltf.scene).then(function () {
            scene.add(gltf.scene);
            box.expandByObject(gltf.scene);
          });
        });
      });
    });
    return chain.then(function () { return box; });
  }

  return Promise.all([
    loadInto(vBefore.scene, DATA.before),
    loadInto(vAfter.scene, DATA.after)
  ]).then(function (boxes) {
    var all = new THREE.Box3();
    if (!boxes[0].isEmpty()) all.union(boxes[0]);
    if (!boxes[1].isEmpty()) all.union(boxes[1]);
    fitCamera(controls, all);
    var gridBefore = vBefore.scene.children[0];
    if (gridBefore && gridBefore.position) {
      gridBefore.position.y = all.min ? all.min.y : 0;
      var g2 = vAfter.scene.children[0];
      if (g2) g2.position.y = all.min ? all.min.y : 0;
    }
    (function tick() {
      controls.update();
      vBefore.renderer.render(vBefore.scene, camera);
      vAfter.renderer.render(vAfter.scene, camera);
      requestAnimationFrame(tick);
    })();
  });
}

main();
</script>
</body>
</html>
`;
