/* 视频混剪网页版：对照 music-editor 的做法
 * 工程 = [{视频, start, end}] + 单播放器连播预览 + ffmpeg 真合成导出
 */

let tracks = [];
let uid = 1;

const playSession = { id: 0, playing: false, timeline: [], totalDur: 0, elapsedBefore: 0, curPos: 0, single: null };
const rafState = { raf: 0 };

const $ = (id) => document.getElementById(id);
const clipListEl = () => $('clipList');
const previewEl = () => $('preview');

function fmt(s) {
  s = Math.max(0, s);
  const m = Math.floor(s / 60);
  const sec = (s % 60).toFixed(1);
  return m > 0 ? `${m}:${sec.padStart(4, '0')}` : `${sec}s`;
}
function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

/* ---------- 添加视频：原生播放优先，播不了的用 ffmpeg 转 mp4 再预览 ---------- */
const FFMPEG_ONLY = /\.(mkv|avi|wmv|flv|ts|m2ts|mpg|mpeg|vob)$/i;

function probeBlob(name, blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const v = document.createElement('video');
    v.muted = true;
    v.preload = 'auto';
    v.playsInline = true;
    v.src = url;
    const done = () => {
      let dur = v.duration;
      // MediaRecorder 产出的 webm 偶尔 duration=Infinity，seek 一下触发修正
      if (!isFinite(dur)) {
        const onDur = () => { v.removeEventListener('durationchange', onDur); finish(v.duration); };
        v.addEventListener('durationchange', onDur);
        v.currentTime = 1e7;
        return;
      }
      finish(dur);
    };
    const finish = (dur) => {
      if (!dur || !isFinite(dur) || dur <= 0) {
        URL.revokeObjectURL(url);
        reject(new Error('读不到时长'));
        return;
      }
      resolve({ url, duration: dur, width: v.videoWidth || 0, height: v.videoHeight || 0 });
    };
    v.addEventListener('loadedmetadata', done, { once: true });
    v.addEventListener('error', () => { URL.revokeObjectURL(url); reject(new Error('浏览器播不了')); }, { once: true });
    setTimeout(() => reject(new Error('读取超时')), 30000);
  });
}

async function transcodePreviewWithFFmpeg(file) {
  if (!window.__ffmpegTranscodePreview) {
    throw new Error('转码模块还没就绪，请用 http 打开并联网刷新一次');
  }
  $('nowPlaying').textContent = '转码组件下载中（约30MB，仅首次）…';
  const u8 = await window.__ffmpegTranscodePreview(file);
  return new Blob([u8.slice(0)], { type: 'video/mp4' });
}

async function addFileSmart(file) {
  if (FFMPEG_ONLY.test(file.name)) {
    $('nowPlaying').textContent = `${file.name} 浏览器播不了，用 ffmpeg 转码预览中…`;
    const mp4 = await transcodePreviewWithFFmpeg(file);
    return await probeBlob(file.name, mp4).then(p => ({ ...p, blob: mp4 }));
  }
  try {
    const p = await probeBlob(file.name, file);
    return { ...p, blob: file };
  } catch (e1) {
    console.info('原生播放失败，转 ffmpeg:', file.name);
    $('nowPlaying').textContent = `${file.name} 原生播不了，用 ffmpeg 转码中…`;
    const mp4 = await transcodePreviewWithFFmpeg(file);
    const p = await probeBlob(file.name, mp4);
    return { ...p, blob: mp4 };
  }
}

async function handleFiles(fileList) {
  for (const file of fileList) {
    if (!file.type.startsWith('video') && !/\.(mp4|webm|mov|m4v|mkv|avi|wmv|flv|ts|mpg|mpeg)$/i.test(file.name)) {
      alert(`跳过不支持的文件：${file.name}`);
      continue;
    }
    if (file.size > 800 * 1024 * 1024) {
      alert(`${file.name} 太大了（>800MB），浏览器内存吃不消，先在本地截一段再剪`);
      continue;
    }
    try {
      $('nowPlaying').textContent = `正在读取 ${file.name}…`;
      const p = await addFileSmart(file);
      const transcoded = p.blob !== file;
      addTrackFromProbe(file.name.replace(/\.\w+$/, ''), p.blob, p.url, p.duration, p.width, p.height, transcoded ? 'mp4' : extOf(file.name));
      $('nowPlaying').textContent = `已添加 ${file.name}`;
    } catch (e) {
      console.error(e);
      alert(`读取失败：${file.name}（${e.message || e}），可先转成 MP4(H.264) 再试`);
      $('nowPlaying').textContent = '未播放';
    }
  }
}

function addTrackFromProbe(name, blob, url, duration, width, height, ext = 'mp4') {
  const t = {
    id: uid++,
    name,
    ext,
    blob,
    url,
    duration,
    width,
    height,
    start: 0,
    end: Math.min(duration, 10),
    gain: 1.0,
    loop: false,
    thumbs: null,
  };
  tracks.push(t);
  renderList();
  captureThumbs(t);
}

/* ---------- 示例视频：本地 canvas 合成，免找文件（对照示例歌曲） ---------- */
function recordDemoClip({ label, hue, freq, dur = 6 }) {
  return new Promise((resolve, reject) => {
    const W = 640, H = 360;
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const c = canvas.getContext('2d');
    const stream = canvas.captureStream(30);

    // 配点声音，预览/导出能听见
    let audioTrack = null;
    let actx = null;
    try {
      actx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = actx.createOscillator();
      const g = actx.createGain();
      osc.frequency.value = freq;
      osc.type = 'triangle';
      g.gain.value = 0.06;
      const dest = actx.createMediaStreamDestination();
      osc.connect(g); g.connect(dest);
      osc.start();
      audioTrack = dest.stream.getAudioTracks()[0];
      osc._stop = () => { try { osc.stop(); } catch (_) {} };
      recordDemoClip._oscs = recordDemoClip._oscs || [];
      recordDemoClip._oscs.push(osc);
    } catch (e) { console.warn('示例音频失败', e); }

    const mixed = new MediaStream([...stream.getVideoTracks(), ...(audioTrack ? [audioTrack] : [])]);
    const mime = ['video/webm;codecs=vp9', 'video/webm'].find(m => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
    let rec;
    try {
      rec = new MediaRecorder(mixed, mime ? { mimeType: mime, videoBitsPerSecond: 2_500_000 } : undefined);
    } catch (e) { reject(e); return; }
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    rec.onstop = () => {
      try { (recordDemoClip._oscs || []).forEach(o => o._stop && o._stop()); } catch (_) {}
      recordDemoClip._oscs = [];
      if (actx) actx.close().catch(() => {});
      resolve(new Blob(chunks, { type: 'video/webm' }));
    };

    const t0 = performance.now();
    const draw = () => {
      const el = (performance.now() - t0) / 1000;
      const grad = c.createLinearGradient(0, 0, W, H);
      grad.addColorStop(0, `hsl(${hue} 70% 30%)`);
      grad.addColorStop(1, `hsl(${(hue + 60) % 360} 70% 45%)`);
      c.fillStyle = grad;
      c.fillRect(0, 0, W, H);
      // 移动条块
      for (let i = 0; i < 5; i++) {
        const x = ((el * 120 * (i + 1) / 3) % (W + 200)) - 100;
        c.fillStyle = `hsla(${(hue + i * 30) % 360} 90% 65% / .85)`;
        c.fillRect(x, 60 + i * 48, 120, 26);
      }
      // 大标题 + 时间码
      c.fillStyle = '#fff';
      c.font = 'bold 54px sans-serif';
      c.textAlign = 'center';
      c.fillText(label, W / 2, H / 2 - 6);
      c.font = '28px monospace';
      c.fillText(`${el.toFixed(1)}s / ${dur.toFixed(0)}s · ${freq}Hz`, W / 2, H / 2 + 44);
      if (el < dur) requestAnimationFrame(draw);
    };
    draw();
    rec.start(200);
    setTimeout(() => { try { rec.stop(); } catch (e) { reject(e); } }, dur * 1000 + 150);
  });
}

async function addDemoVideos() {
  const btn = $('demoBtn');
  btn.disabled = true;
  const old = btn.textContent;
  try {
    const defs = [
      { label: '示例·日出', hue: 20, freq: 220 },
      { label: '示例·海洋', hue: 200, freq: 174.6 },
      { label: '示例·森林', hue: 140, freq: 196 },
    ];
    for (const d of defs) {
      btn.textContent = `生成${d.label}中…`;
      $('nowPlaying').textContent = `生成${d.label}中…`;
      const blob = await recordDemoClip(d);
      const p = await probeBlob(d.label, blob);
      addTrackFromProbe(d.label, blob, p.url, p.duration, p.width, p.height, 'webm');
      // 示例默认截法：对照音乐示例（5-10s / 19-35s 之意），这里取前中后各一段
      const t = tracks[tracks.length - 1];
      if (tracks.length === 1) setTimes(t.id, 0, Math.min(5, t.duration));
      else if (tracks.length === 2) setTimes(t.id, 1, Math.min(6, t.duration));
      else setTimes(t.id, 0, Math.min(4, t.duration));
    }
    $('nowPlaying').textContent = '示例视频已添加';
  } catch (e) {
    console.error(e);
    alert('生成示例失败：' + (e.message || e));
  } finally {
    btn.disabled = false; btn.textContent = old;
  }
}

/* ---------- 胶片缩略图（对照波形峰值缓存） ---------- */
const THUMB_N = 8;
async function captureThumbs(t) {
  try {
    const v = document.createElement('video');
    v.muted = true;
    v.preload = 'auto';
    v.playsInline = true;
    v.src = t.url;
    await new Promise((res, rej) => {
      v.addEventListener('loadedmetadata', res, { once: true });
      v.addEventListener('error', () => rej(new Error('thumb load fail')), { once: true });
    });
    const thumbs = [];
    const cv = document.createElement('canvas');
    cv.width = 160; cv.height = 90;
    const cc = cv.getContext('2d');
    for (let i = 0; i < THUMB_N; i++) {
      const tm = t.duration * (i + 0.5) / THUMB_N;
      await new Promise((res) => {
        const to = setTimeout(res, 1500);
        v.addEventListener('seeked', function h() {
          v.removeEventListener('seeked', h);
          clearTimeout(to);
          res();
        });
        v.currentTime = Math.min(Math.max(0.05, tm), Math.max(0.05, t.duration - 0.05));
      });
      try {
        const vw = v.videoWidth || 160, vh = v.videoHeight || 90;
        const s = Math.max(vw / 160, vh / 90);
        const dw = vw / s, dh = vh / s;
        cc.fillStyle = '#000';
        cc.fillRect(0, 0, 160, 90);
        cc.drawImage(v, (160 - dw) / 2, (90 - dh) / 2, dw, dh);
        thumbs.push(cv.toDataURL('image/jpeg', 0.6));
      } catch (_) { thumbs.push(null); }
    }
    t.thumbs = thumbs;
    t._thumbImgs = thumbs.map(src => {
      if (!src) return null;
      const im = new Image();
      im.src = src;
      return im;
    });
    const card = clipListEl().querySelector(`.clip[data-id="${t.id}"]`);
    if (card) drawStrip(card.querySelector('.strip'), t);
  } catch (e) {
    console.warn('缩略图失败', t.name, e);
  }
}

/* ---------- 列表渲染（对照 music renderList） ---------- */
function renderList() {
  const list = clipListEl();
  list.innerHTML = '';
  $('emptyTip').style.display = tracks.length ? 'none' : 'block';

  tracks.forEach((t, idx) => {
    const card = document.createElement('div');
    card.className = 'clip';
    card.dataset.id = t.id;
    card.innerHTML = `
      <div class="clip-head">
        <span class="drag-handle" title="按住拖动排序">⠿</span>
        <span class="badge">${idx + 1}</span>
        <span class="clip-name" title="${escapeHtml(t.name)}">${escapeHtml(t.name)}</span>
        <span class="clip-meta meta"></span>
        <div class="clip-actions">
          <button class="btn small ghost btn-up" title="上移">↑</button>
          <button class="btn small ghost btn-down" title="下移">↓</button>
          <button class="btn small ghost btn-play">▶本段</button>
          <button class="btn small ghost btn-loop" title="循环播放本段，边看边卡点">循环关</button>
          <button class="btn small ghost danger btn-del">删</button>
        </div>
      </div>
      <canvas class="strip"></canvas>
      <div class="ctl-grid">
        <div class="ctl">
          <label>开始(秒) <input class="in-start" type="number" step="0.1" min="0" /></label>
          <input class="rg-start" type="range" step="0.1" min="0" />
        </div>
        <div class="ctl">
          <label>结束(秒) <input class="in-end" type="number" step="0.1" min="0" /></label>
          <input class="rg-end" type="range" step="0.1" min="0" />
        </div>
      </div>
      <div class="row">
        <div class="ctl" style="flex:1">
          <label>音量 <span class="gain-label">100%</span></label>
          <input class="rg-gain" type="range" min="0" max="150" value="100" />
        </div>
        <button class="btn small ghost q5">前5秒</button>
        <button class="btn small ghost q10">前10秒</button>
        <button class="btn small ghost qall">整段</button>
      </div>`;

    const canvas = card.querySelector('.strip');
    const inS = card.querySelector('.in-start');
    const inE = card.querySelector('.in-end');
    const rgS = card.querySelector('.rg-start');
    const rgE = card.querySelector('.rg-end');
    const rgG = card.querySelector('.rg-gain');

    rgS.max = t.duration.toFixed(1); rgE.max = t.duration.toFixed(1);
    inS.max = t.duration.toFixed(1); inE.max = t.duration.toFixed(1);
    rgG.value = Math.round(t.gain * 100);

    const refreshInputs = () => {
      inS.value = t.start.toFixed(1); inE.value = t.end.toFixed(1);
      rgS.value = t.start; rgE.value = t.end;
      const wh = (t.width && t.height) ? ` · ${t.width}x${t.height}` : '';
      card.querySelector('.meta').textContent =
        `原长${fmt(t.duration)}${wh} · 截取${fmt(t.end - t.start)} (${t.start.toFixed(1)}~${t.end.toFixed(1)}s)`;
      card.querySelector('.gain-label').textContent = Math.round(t.gain * 100) + '%';
    };
    refreshInputs();
    card._refresh = refreshInputs;

    inS.onchange = () => setTimes(t.id, parseFloat(inS.value), t.end);
    inE.onchange = () => setTimes(t.id, t.start, parseFloat(inE.value));
    rgS.oninput = () => setTimes(t.id, parseFloat(rgS.value), t.end, true);
    rgE.oninput = () => setTimes(t.id, t.start, parseFloat(rgE.value), true);
    rgG.oninput = () => { t.gain = parseInt(rgG.value, 10) / 100; card.querySelector('.gain-label').textContent = rgG.value + '%'; };

    card.querySelector('.btn-up').onclick = () => move(t.id, -1);
    card.querySelector('.btn-down').onclick = () => move(t.id, 1);
    card.querySelector('.btn-del').onclick = () => { stopPlayback(); tracks = tracks.filter(x => x.id !== t.id); renderList(); };
    card.querySelector('.btn-play').onclick = () => playSingle(t.id);
    const loopBtn = card.querySelector('.btn-loop');
    const paintLoop = () => { loopBtn.textContent = t.loop ? '循环开' : '循环关'; };
    paintLoop();
    loopBtn.onclick = () => {
      t.loop = !t.loop; paintLoop();
      const playing = document.querySelector(`.clip[data-id="${t.id}"]`)?.classList.contains('playing');
      if (playing) playSingle(t.id);
    };
    card.querySelector('.q5').onclick = () => setTimes(t.id, 0, Math.min(5, t.duration));
    card.querySelector('.q10').onclick = () => setTimes(t.id, 0, Math.min(10, t.duration));
    card.querySelector('.qall').onclick = () => setTimes(t.id, 0, t.duration);

    bindCardDrag(card, t);
    bindStrip(canvas, t, card);
    list.appendChild(card);
    requestAnimationFrame(() => drawStrip(canvas, t));
    if (t._thumbImgs) {
      t._thumbImgs.forEach(im => { if (im) im.onload = () => drawStrip(canvas, t); });
    }
  });

  updateMixInfo();
}
function setTimes(id, s, e, live = false) {
  const t = tracks.find(x => x.id === id);
  if (!t) return;
  s = isNaN(s) ? t.start : clamp(s, 0, t.duration);
  e = isNaN(e) ? t.end : clamp(e, 0, t.duration);
  if (e - s < 0.1) {
    if (!live) {
      if (s + 0.5 <= t.duration) e = s + 0.5; else s = Math.max(0, e - 0.5);
    }
  }
  if (e < s) [s, e] = [e, s];
  t.start = Math.round(s * 10) / 10;
  t.end = Math.round(e * 10) / 10;
  const card = clipListEl().querySelector(`.clip[data-id="${id}"]`);
  if (card) {
    card._refresh();
    drawStrip(card.querySelector('.strip'), t);
  }
  updateMixInfo(true);
  if (!live) updateMixInfo();
}

function move(id, dir) {
  const i = tracks.findIndex(x => x.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= tracks.length) return;
  stopPlayback();
  [tracks[i], tracks[j]] = [tracks[j], tracks[i]];
  renderList();
}

/* 自由拖动排序：按住 ⠿ 拖到任意位置（对照 music） */
let dragSrcId = null;
function bindCardDrag(card, t) {
  const handle = card.querySelector('.drag-handle');
  card.draggable = false;
  handle.addEventListener('pointerdown', () => { card.draggable = true; });
  handle.addEventListener('pointerup', () => { card.draggable = false; });
  card.addEventListener('dragstart', (e) => {
    dragSrcId = t.id;
    card.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', String(t.id)); } catch (_) {}
  });
  card.addEventListener('dragend', () => {
    card.classList.remove('dragging');
    card.draggable = false;
    document.querySelectorAll('.clip.drag-over').forEach(el => el.classList.remove('drag-over'));
  });
  card.addEventListener('dragover', (e) => {
    if (dragSrcId == null || dragSrcId === t.id) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    card.classList.add('drag-over');
  });
  card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
  card.addEventListener('drop', (e) => {
    e.preventDefault();
    card.classList.remove('drag-over');
    if (dragSrcId == null || dragSrcId === t.id) return;
    const from = tracks.findIndex(x => x.id === dragSrcId);
    const to = tracks.findIndex(x => x.id === t.id);
    if (from < 0 || to < 0) return;
    stopPlayback();
    const [m] = tracks.splice(from, 1);
    tracks.splice(to, 0, m);
    dragSrcId = null;
    renderList();
  });
}

/* ---------- 胶片条（对照波形）：缩略图 + 选中高亮 + 拖拉选段 ---------- */
function drawStrip(canvas, t, playTime = null) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 600, h = 92;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const c = canvas.getContext('2d');
  c.scale(dpr, dpr);
  c.fillStyle = '#141824';
  c.fillRect(0, 0, w, h);

  // 铺缩略图
  const imgs = (t._thumbImgs || []).filter(Boolean);
  if (imgs.length) {
    const tw = w / THUMB_N;
    for (let i = 0; i < THUMB_N; i++) {
      const im = t._thumbImgs[i];
      if (im && im.complete && im.naturalWidth) {
        try {
          const s = Math.max(im.naturalWidth / tw, im.naturalHeight / h);
          const dw = im.naturalWidth / s, dh = im.naturalHeight / s;
          c.drawImage(im, i * tw + (tw - dw) / 2, (h - dh) / 2, dw, dh);
        } catch (_) {}
      } else {
        c.fillStyle = '#232b40';
        c.fillRect(i * tw + 1, 0, tw - 2, h);
      }
    }
  } else {
    c.fillStyle = 'rgba(255,255,255,.55)';
    c.font = '12px sans-serif';
    c.fillText('缩略图生成中…', 10, h / 2);
  }

  // 未选中加暗罩
  const sx = (t.start / t.duration) * w, ex = (t.end / t.duration) * w;
  c.fillStyle = 'rgba(0,0,0,0.62)';
  c.fillRect(0, 0, sx, h);
  c.fillRect(ex, 0, w - ex, h);
  // 起止线
  c.fillStyle = '#ffd32a';
  c.fillRect(sx - 1, 0, 2.5, h);
  c.fillRect(ex - 1, 0, 2.5, h);
  // 播放头
  if (playTime != null && playTime >= t.start && playTime <= t.end) {
    const px = (playTime / t.duration) * w;
    c.fillStyle = '#ff4757';
    c.fillRect(px - 1, 0, 2.5, h);
    c.beginPath();
    c.moveTo(px - 5, 0); c.lineTo(px + 5, 0); c.lineTo(px, 8); c.closePath();
    c.fill();
  }
  c.fillStyle = '#fff';
  c.font = '11px sans-serif';
  c.fillText(t.start.toFixed(1) + 's', clamp(sx + 4, 0, w - 40), 14);
  c.fillText(t.end.toFixed(1) + 's', clamp(ex - 36, 0, w - 40), 14);
  c.fillStyle = 'rgba(255,255,255,.75)';
  c.fillText('在胶片条上按住拖拉即可选段', 8, h - 8);
}

function bindStrip(canvas, t, card) {
  let dragging = false, anchor = 0;
  const toTime = (ev) => {
    const r = canvas.getBoundingClientRect();
    const x = clamp((ev.clientX - r.left), 0, r.width);
    return (x / r.width) * t.duration;
  };
  canvas.addEventListener('pointerdown', (ev) => {
    dragging = true;
    try { canvas.setPointerCapture(ev.pointerId); } catch (_) {}
    anchor = toTime(ev);
    setTimes(t.id, anchor, anchor, true);
  });
  canvas.addEventListener('pointermove', (ev) => {
    if (!dragging) return;
    setTimes(t.id, anchor, toTime(ev), true);
  });
  const up = () => {
    if (!dragging) return;
    dragging = false;
    if (t.end - t.start < 0.2) setTimes(t.id, Math.max(0, t.start - 0.25), Math.min(t.duration, t.start + 0.45));
    else setTimes(t.id, t.start, t.end);
  };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
}

/* ---------- 拼接信息条（对照 music） ---------- */
function mixTotal() { return tracks.reduce((a, t) => a + Math.max(0, t.end - t.start), 0); }

function updateMixInfo(light = false) {
  const total = mixTotal();
  const size = $('mp4Size')?.value || 'original';
  const mbps = size === '1920x1080' ? 6 : size === '1280x720' ? 3 : 5;
  const mb = (total * mbps / 8).toFixed(1);
  $('mixInfo').textContent = `共 ${tracks.length} 段，总长 ${total.toFixed(1)} 秒 · MP4(${size === 'original' ? '原画' : size})约${mb}MB`;
  if (light) return;
  const bar = $('mixBar');
  bar.innerHTML = '';
  const palette = [222, 340, 160, 20, 260, 140, 0, 100];
  tracks.forEach((t, i) => {
    const d = Math.max(0, t.end - t.start);
    const seg = document.createElement('div');
    seg.className = 'mix-seg';
    seg.style.flexGrow = Math.max(1, d * 10);
    seg.style.background = `hsl(${palette[i % palette.length]} 70% 45%)`;
    seg.textContent = `${i + 1}. ${t.name} ${d.toFixed(1)}s`;
    seg.title = '点击从这一段开始预览';
    seg.onclick = () => playAll(i);
    bar.appendChild(seg);
  });
  if (!tracks.length) bar.innerHTML = '<span class="small">还没有片段</span>';
}

/* ---------- 播放引擎：单个 video 元素顺序连播（对照 WebAudio 连播） ---------- */
function clearPlayingUI() {
  document.querySelectorAll('.clip.playing').forEach(el => el.classList.remove('playing'));
}
function stopPlayback() {
  playSession.id++;
  playSession.playing = false;
  playSession.single = null;
  playSession.timeline = [];
  cancelAnimationFrame(rafState.raf);
  const v = previewEl();
  try { v.pause(); } catch (_) {}
  v.removeAttribute('src');
  try { v.load(); } catch (_) {}
  clearPlayingUI();
  document.querySelectorAll('.clip').forEach(el => {
    const tr = tracks.find(x => x.id == el.dataset.id);
    if (tr) drawStrip(el.querySelector('.strip'), tr);
  });
  const pp = $('playProgress');
  if (pp) pp.style.width = '0%';
  $('nowPlaying').textContent = '已停止';
}
function markPlaying(id) {
  clearPlayingUI();
  document.querySelector(`.clip[data-id="${id}"]`)?.classList.add('playing');
}
function waitEvent(el, name) {
  return new Promise((res, rej) => {
    const ok = () => { cleanup(); res(); };
    const err = () => { cleanup(); rej(new Error('视频加载失败')); };
    const cleanup = () => { el.removeEventListener(name, ok); el.removeEventListener('error', err); };
    el.addEventListener(name, ok, { once: true });
    el.addEventListener('error', err, { once: true });
  });
}

async function playSingle(id) {
  const t = tracks.find(x => x.id === id);
  if (!t) return;
  const dur = t.end - t.start;
  if (dur <= 0.2) return alert('这段太短了，先拖大一点');
  stopPlayback();
  const myId = ++playSession.id;
  const v = previewEl();
  playSession.playing = true;
  playSession.single = { trackId: id };
  markPlaying(id);
  v.src = t.url;
  v.volume = clamp(t.gain, 0, 1);
  v.muted = t.gain <= 0.01;
  v.currentTime = Math.min(t.start + 0.001, Math.max(0, t.duration - 0.05));
  $('nowPlaying').textContent = `单段预览：${t.name} ${t.start.toFixed(1)}~${t.end.toFixed(1)}s`;
  try { await waitEvent(v, 'loadedmetadata'); } catch (_) {}
  if (playSession.id !== myId) return;
  try { await v.play(); } catch (e) { if (playSession.id === myId) alert('播放被拦截，点一下播放器再试'); return; }
  tickSingle(myId, t);
}

function tickSingle(myId, t) {
  if (playSession.id !== myId || !playSession.playing) return;
  const v = previewEl();
  const dur = t.end - t.start;
  const pos = v.currentTime - t.start;
  if (!v.paused && !v.ended) {
    if (v.currentTime >= t.end - 0.03) {
      if (t.loop) {
        v.currentTime = t.start + 0.001;
      } else {
        stopPlayback();
        return;
      }
    }
    if (pos >= -0.5 && pos <= dur + 0.5) {
      $('playProgress').style.width = clamp(pos / dur * 100, 0, 100).toFixed(1) + '%';
      $('nowPlaying').textContent =
        `单段预览：${t.name} ${t.start.toFixed(1)}~${t.end.toFixed(1)}s · ` +
        `${clamp(pos, 0, dur).toFixed(1)}/${dur.toFixed(1)}s${t.loop ? ' · 循环中（点停止结束）' : ''}`;
      const card = document.querySelector(`.clip[data-id="${t.id}"]`);
      if (card) drawStrip(card.querySelector('.strip'), t, v.currentTime);
    }
  }
  rafState.raf = requestAnimationFrame(() => tickSingle(myId, t));
}

async function playAll(fromIdx = 0) {
  if (!tracks.length) return alert('先添加视频');
  stopPlayback();
  const myId = ++playSession.id;
  const v = previewEl();
  const timeline = [];
  let total = 0;
  for (let i = fromIdx; i < tracks.length; i++) {
    const t = tracks[i];
    const dur = t.end - t.start;
    if (dur <= 0.2) continue;
    timeline.push({ track: t, idx: i, mixOffset: total, dur });
    total += dur;
  }
  if (!timeline.length) return alert('每段都太短');
  playSession.timeline = timeline;
  playSession.totalDur = total;
  playSession.playing = true;

  for (let k = 0; k < timeline.length; k++) {
    if (playSession.id !== myId) return;
    const seg = timeline[k];
    const t = seg.track;
    playSession.elapsedBefore = seg.mixOffset;
    playSession.curPos = k;
    markPlaying(t.id);
    v.src = t.url;
    v.volume = clamp(t.gain, 0, 1);
    v.muted = t.gain <= 0.01;
    try { await waitEvent(v, 'loadedmetadata'); } catch (e) { console.warn('跳过坏段', t.name); continue; }
    if (playSession.id !== myId) return;
    v.currentTime = Math.min(t.start + 0.001, Math.max(0, t.duration - 0.05));
    const segDone = new Promise((resolve) => {
      const onTime = () => {
        if (playSession.id !== myId) { cleanup(); resolve('stop'); }
        else if (v.currentTime >= t.end - 0.05) { cleanup(); resolve('next'); }
      };
      const onEnd = () => { cleanup(); resolve('next'); };
      const cleanup = () => { v.removeEventListener('timeupdate', onTime); v.removeEventListener('ended', onEnd); };
      v.addEventListener('timeupdate', onTime);
      v.addEventListener('ended', onEnd);
    });
    try { await v.play(); } catch (e) { console.warn(e); break; }
    tickAll(myId);
    const r = await segDone;
    cancelAnimationFrame(rafState.raf);
    if (r === 'stop') return;
  }
  if (playSession.id === myId) stopPlayback();
}

function tickAll(myId) {
  cancelAnimationFrame(rafState.raf);
  const step = () => {
    if (playSession.id !== myId || !playSession.playing) return;
    const v = previewEl();
    const seg = playSession.timeline[playSession.curPos];
    if (seg) {
      const el = playSession.elapsedBefore + Math.max(0, v.currentTime - seg.track.start);
      $('playProgress').style.width = clamp(el / playSession.totalDur * 100, 0, 100).toFixed(1) + '%';
      $('nowPlaying').textContent =
        `正在播 第${seg.idx + 1}段 ${seg.track.name} ` +
        `${clamp(v.currentTime - seg.track.start, 0, seg.dur).toFixed(1)}/${seg.dur.toFixed(1)}s · 总 ${el.toFixed(1)}/${playSession.totalDur.toFixed(1)}s`;
      const card = document.querySelector(`.clip[data-id="${seg.track.id}"]`);
      if (card) drawStrip(card.querySelector('.strip'), seg.track, v.currentTime);
    }
    rafState.raf = requestAnimationFrame(step);
  };
  step();
}

/* ---------- 导出：ffmpeg 按段裁剪重编码 + concat 合成 MP4（对照 Offline 导出） ---------- */
function extOf(name, fallback = 'mp4') {
  const m = /\.([a-z0-9]+)$/i.exec(name || '');
  return (m ? m[1] : fallback).toLowerCase().replace(/[^a-z0-9]/g, '') || fallback;
}
async function exportMp4() {
  if (!tracks.length) return alert('先添加视频');
  const total = mixTotal();
  if (total < 0.5) return alert('总长太短');
  if (total > 600) return alert('太长了（>10分钟），先缩短再导出，浏览器内存吃不消');
  const btn = $('exportBtn');
  btn.disabled = true;
  btn.textContent = '合成中…';
  try {
    if (!window.__ffmpegEnsure) throw new Error('转码模块还没加载（请用 http 打开）');
    $('nowPlaying').textContent = '转码组件准备中（首次需联网下载约25MB）…';
    const ffmpeg = await window.__ffmpegEnsure();
    const size = $('mp4Size').value || 'original';
    const scaleVf = size === '1280x720' ? 'scale=-2:720' : size === '1920x1080' ? 'scale=-2:1080' : null;

    ffmpeg.on('progress', ({ progress }) => {
      if (typeof progress === 'number') {
        $('playProgress').style.width = (progress * 100).toFixed(0) + '%';
      }
    });
    const { fetchFile } = await import('https://esm.sh/@ffmpeg/util@0.12.2');
    const segs = [];
    const listLines = [];
    let idx = 0;
    for (const t of tracks) {
      const dur = t.end - t.start;
      if (dur <= 0.2) continue;
      const inFile = `in${idx}.${(t.ext || 'mp4')}`;
      try { await ffmpeg.deleteFile(inFile); } catch (_) {}
      await ffmpeg.writeFile(inFile, await fetchFile(t.blob));
      const segName = `seg${idx}.mp4`;
      try { await ffmpeg.deleteFile(segName); } catch (_) {}
      const vf = [];
      if (scaleVf) vf.push(scaleVf);
      vf.push('format=yuv420p');
      const args = [
        '-ss', t.start.toFixed(2), '-t', dur.toFixed(2),
        '-i', inFile,
        '-vf', vf.join(','),
        '-af', `volume=${clamp(t.gain, 0, 1.5).toFixed(2)}`,
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
        '-c:a', 'aac', '-b:a', '128k',
        '-movflags', '+faststart',
        segName,
      ];
      $('nowPlaying').textContent = `合成第 ${idx + 1} 段：${t.name}（${dur.toFixed(1)}s）…`;
      const code = await ffmpeg.exec(args);
      if (code !== 0) throw new Error(`第${idx + 1}段合成失败`);
      try { await ffmpeg.deleteFile(inFile); } catch (_) {}
      segs.push(segName);
      listLines.push(`file '${segName}'`);
      idx++;
    }
    if (!segs.length) throw new Error('没有可导出的片段');
    await ffmpeg.writeFile('list.txt', new TextEncoder().encode(listLines.join('\n')));
    try { await ffmpeg.deleteFile('out.mp4'); } catch (_) {}
    $('nowPlaying').textContent = '拼接输出中…';
    const code2 = await ffmpeg.exec(['-f', 'concat', '-safe', '0', '-i', 'list.txt', '-c', 'copy', 'out.mp4']);
    if (code2 !== 0) throw new Error('拼接失败');
    const data = await ffmpeg.readFile('out.mp4');
    const u8 = data instanceof Uint8Array ? data.slice(0) : new Uint8Array(data);
    const blob = new Blob([u8.buffer], { type: 'video/mp4' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `混剪_${total.toFixed(1)}s.mp4`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 8000);
    for (const s of segs) { try { await ffmpeg.deleteFile(s); } catch (_) {} }
    try { await ffmpeg.deleteFile('list.txt'); } catch (_) {}
    try { await ffmpeg.deleteFile('out.mp4'); } catch (_) {}
    $('nowPlaying').textContent = `已导出 ${total.toFixed(1)}s MP4（${(blob.size / 1048576).toFixed(1)}MB）`;
    $('playProgress').style.width = '100%';
  } catch (e) {
    console.error(e);
    alert('导出失败：' + (e.message || e));
  } finally {
    btn.disabled = false;
    btn.textContent = '⬇ 导出 MP4';
  }
}

/* ---------- 事件（对照 music） ---------- */
$('fileInput').addEventListener('change', (e) => { handleFiles(e.target.files); e.target.value = ''; });
$('demoBtn').onclick = addDemoVideos;
$('clearBtn').onclick = () => { if (confirm('清空全部视频？')) { stopPlayback(); tracks = []; renderList(); } };
$('playAllBtn').onclick = () => playAll(0);
$('stopBtn').onclick = stopPlayback;
$('exportBtn').onclick = exportMp4;
$('mp4Size').onchange = () => updateMixInfo();

const dz = $('dropzone');
['dragover', 'dragenter'].forEach(ev => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.style.background = '#efe9ff'; }));
['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.style.background = ''; }));
dz.addEventListener('drop', (e) => { if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files); });

let rsz;
window.addEventListener('resize', () => {
  clearTimeout(rsz);
  rsz = setTimeout(() => document.querySelectorAll('.clip').forEach(card => {
    const t = tracks.find(x => x.id == card.dataset.id);
    if (t) drawStrip(card.querySelector('.strip'), t);
  }), 200);
});

renderList();
