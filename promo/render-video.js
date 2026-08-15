// Собирает promo.html в готовый файл promo.mp4 размером 1080x1920.
//
//   npm run promo:video
//
// Нужны Chrome и ffmpeg. Пути можно задать переменными PROMO_CHROME и FFMPEG.
//
// Почему так, а не записью экрана. Вертикальный кадр 1080x1920 в монитор
// 1920x1080 не помещается: при записи экрана от ролика остаётся 607x1080, и
// мелкий текст переписки плывёт. Захват вкладки в headless-браузере тоже не
// выход — он отдаёт только виртуальный экран 1920x1080 и вдобавок роняет
// частоту до пяти кадров в секунду, потому что кадр делается лишь когда
// картинка меняется. Поэтому картинку и звук берём порознь:
//
//   1) звук — обычный прогон в реальном времени: пишем щелчки переписки
//      (и музыку, если она включена). Голос при этом приглушён, потому что чистый voice.mp3
//      подмешивается отдельно и ложится секунда в секунду;
//   2) картинку — покадрово. Ролик замедляется в SLOW раз (и его часы,
//      и CSS-анимации), снимок 1080x1920 стоит около 120 мс, так что
//      успеваем снять каждый кадр;
//   3) ffmpeg собирает 30 кадров в секунду и сводит звук.
//
// Занимает около пяти минут.
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const DIR = __dirname;
const WORK = path.join(os.tmpdir(), 'promo-render');
const PORT = Number(process.env.PROMO_PORT || 5599);
const URL = `http://localhost:${PORT}/promo.html?clean=1`;
const OUT = process.argv[2] || path.join(DIR, 'promo.mp4');
// ffmpeg из winget не прописывается в PATH уже открытых терминалов, поэтому
// если в PATH его нет — ищем сами по стандартным местам установки.
function findFfmpeg() {
  if (process.env.FFMPEG) return process.env.FFMPEG;
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return 'ffmpeg';
  } catch {}
  const roots = [
    path.join(os.homedir(), 'AppData\\Local\\Microsoft\\WinGet\\Packages'),
    'C:\\ffmpeg\\bin',
    '/usr/bin',
    '/opt/homebrew/bin',
  ];
  for (const root of roots) {
    const direct = path.join(root, 'ffmpeg.exe');
    if (fs.existsSync(direct)) return direct;
    if (fs.existsSync(path.join(root, 'ffmpeg'))) return path.join(root, 'ffmpeg');
    if (!fs.existsSync(root)) continue;
    for (const pkg of fs.readdirSync(root)) {
      if (!/ffmpeg/i.test(pkg)) continue;
      for (const build of fs.readdirSync(path.join(root, pkg))) {
        const exe = path.join(root, pkg, build, 'bin', 'ffmpeg.exe');
        if (fs.existsSync(exe)) return exe;
      }
    }
  }
  return 'ffmpeg';                    // пусть падает с внятной ошибкой ниже
}

const FFMPEG = findFfmpeg();

const FPS = 30;
const SLOW = 6;                     // во сколько раз замедляем ролик ради съёмки

const CHROME = process.env.PROMO_CHROME || [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(os.homedir(), 'AppData\\Local\\Google\\Chrome\\Application\\chrome.exe'),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
].find((p) => fs.existsSync(p));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- обвязка вокруг протокола отладки Chrome ---------- */
async function launch(port, flags) {
  const chrome = spawn(CHROME, [
    '--headless=new',
    '--remote-debugging-port=' + port,
    '--force-device-scale-factor=1',
    '--hide-scrollbars',
    '--no-first-run',
    '--user-data-dir=' + path.join(WORK, 'profile-' + port),
    ...flags,
    URL,
  ]);
  chrome.on('error', (e) => { throw new Error('не удалось запустить Chrome: ' + e.message); });

  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(250);
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      target = list.find((t) => t.type === 'page');
    } catch (e) { /* браузер ещё поднимается */ }
  }
  if (!target) { chrome.kill(); throw new Error('Chrome не отдал вкладку'); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params) =>
    new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });

  const evalJs = async (expression, userGesture) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture });
    const ex = r.result && r.result.exceptionDetails;
    if (ex) throw new Error(String((ex.exception && ex.exception.description) || ex.text).split('\n')[0]);
    return r.result.result.value;
  };

  // Вьюпорт задаём размером настоящего окна, а не эмуляцией: при эмуляции
  // снимок берётся с окна, а не со страницы, и кадр уезжает.
  async function setViewport(w, h) {
    const { windowId } = (await send('Browser.getWindowForTarget', { targetId: target.id })).result;
    for (let i = 0; i < 5; i++) {
      await sleep(400);
      const [iw, ih] = (await evalJs('innerWidth + "," + innerHeight')).split(',').map(Number);
      if (iw === w && ih === h) return true;
      const b = (await send('Browser.getWindowBounds', { windowId })).result.bounds;
      await send('Browser.setWindowBounds', {
        windowId, bounds: { left: 0, top: 0, width: b.width + (w - iw), height: b.height + (h - ih) },
      });
    }
    return false;
  }

  // Большие двоичные данные из страницы: одним куском base64 на десятки
  // мегабайт через протокол не пролезает.
  async function pullBytes(name) {
    const size = await evalJs(`window.${name}.length`);
    const CHUNK = 1 << 20;
    const parts = [];
    for (let off = 0; off < size; off += CHUNK) {
      parts.push(Buffer.from(await evalJs(`(function(){
        const a = window.${name}.subarray(${off}, ${off + CHUNK});
        let s = '';
        for (let i = 0; i < a.length; i += 4096) s += String.fromCharCode.apply(null, a.subarray(i, i + 4096));
        return btoa(s);
      })()`), 'base64'));
    }
    return Buffer.concat(parts);
  }

  // Вкладка появляется в списке раньше, чем страница успевает выполнить свой
  // скрипт. Без этого ожидания обращение к её переменным падает с «voice is
  // not defined» — и падает не всегда, а как повезёт по времени.
  await send('Runtime.enable');
  let ready = false;
  for (let i = 0; i < 80 && !ready; i++) {
    ready = await evalJs(
      "typeof play === 'function' && typeof voice !== 'undefined' && typeof CONFIG === 'object'"
    ).catch(() => false);
    if (!ready) await sleep(250);
  }
  if (!ready) { ws.close(); chrome.kill(); throw new Error('страница ролика не загрузилась'); }

  return { send, evalJs, setViewport, pullBytes, close: () => { ws.close(); chrome.kill(); } };
}

/* ---------- 1. Звуки переписки ---------- */
async function recordBed(bedFile) {
  console.log('[1/3] пишу звуки переписки…');
  const b = await launch(9231, [
    '--autoplay-policy=no-user-gesture-required',
    '--auto-accept-this-tab-capture',
    '--use-fake-ui-for-media-stream',
    '--window-size=900,1400',
  ]);

  try {
    await b.send('Runtime.enable');
    // Голос глушим, но не останавливаем: по нему идут часы ролика, а значит
    // и щелчки встают ровно там, где должны.
    await b.evalJs('voice.volume = 0, "ok"');

    await b.evalJs(`
      window.__done = null; window.__lag = null;
      window.__go = (async () => {
        const src = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        const rec = new MediaRecorder(new MediaStream(src.getAudioTracks()), { mimeType: 'audio/webm;codecs=opus' });
        const chunks = [];
        rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
        rec.onstop = async () => {
          src.getTracks().forEach((t) => t.stop());
          window.__bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
          window.__done = window.__bytes.length;
        };
        rec.start();
        const t0 = performance.now();
        document.getElementById('goSound').click();
        // Между командой «пиши» и первым сэмплом голоса есть задержка запуска.
        // Меряем её — на неё потом сдвинем дорожку при сведении.
        setTimeout(() => { window.__lag = (performance.now() - voice.currentTime * 1000 - t0) / 1000; }, 3000);
        onFinish = () => { voice.pause(); rec.stop(); };
        return 'пишу';
      })();
      'ok'`, true);
    await b.evalJs('window.__go', true);

    for (let i = 0; i < 90; i++) {
      await sleep(1000);
      const s = JSON.parse(await b.evalJs('JSON.stringify({t: +now().toFixed(1), done: window.__done, lag: window.__lag})'));
      if (i % 10 === 0) console.log('      время ролика', s.t, 'с');
      if (s.done) {
        fs.writeFileSync(bedFile, await b.pullBytes('__bytes'));
        console.log('      готово:', Math.round(s.done / 1024), 'КБ, задержка старта', s.lag.toFixed(3), 'с');
        return s.lag;
      }
    }
    throw new Error('звук не записался');
  } finally {
    b.close();
  }
}

/* ---------- 2. Кадры ---------- */
async function shootFrames(shotsDir, end) {
  console.log('[2/3] снимаю кадры 1080x1920…');
  fs.rmSync(shotsDir, { recursive: true, force: true });
  fs.mkdirSync(shotsDir, { recursive: true });

  const b = await launch(9232, ['--window-size=1200,2100']);
  try {
    await b.send('Runtime.enable');
    await b.send('Page.enable');
    await b.send('Animation.enable');
    if (!(await b.setViewport(1080, 1920))) throw new Error('не удалось выставить вьюпорт 1080x1920');

    // Замедляем часы ролика и таймеры. CSS-анимациями заведует протокол:
    // они живут на собственных часах, до которых из страницы не дотянуться.
    await b.evalJs(`(function () {
      const K = ${SLOW};
      const _now = performance.now.bind(performance);
      const base = _now();
      performance.now = () => base + (_now() - base) / K;
      const _st = window.setTimeout;
      window.setTimeout = function (f, d, ...a) { return _st(f, (d || 0) * K, ...a); };
    })(), 'ok'`);
    await b.send('Animation.setPlaybackRate', { playbackRate: 1 / SLOW });
    await b.evalJs("document.getElementById('goMute').click()", true);

    // Снимаем как можно чаще и запоминаем время ролика на каждом снимке —
    // потом разложим по ровной сетке. Так частота получается стабильной,
    // даже если очередной снимок задержался.
    const samples = [];
    const started = Date.now();
    let prev = -1;
    while (true) {
      const t = await b.evalJs('+now().toFixed(4)');
      // Ролик зациклен: до отметки конца часы не доходят, они прыгают в ноль.
      // Поэтому конец ловим по откату времени назад.
      if (t > end || t < prev) break;
      prev = t;

      const shot = await b.send('Page.captureScreenshot', { format: 'jpeg', quality: 92 });
      if (!shot.result || !shot.result.data) throw new Error('пустой кадр');
      const file = path.join(shotsDir, String(samples.length).padStart(5, '0') + '.jpg');
      fs.writeFileSync(file, Buffer.from(shot.result.data, 'base64'));
      samples.push({ t, file });

      if (samples.length % 150 === 0) console.log('      ' + t.toFixed(1) + ' / ' + end + ' с');
      if (Date.now() - started > 15 * 60 * 1000) throw new Error('съёмка затянулась');
    }
    console.log('      снимков:', samples.length, 'за', Math.round((Date.now() - started) / 1000), 'с');
    return samples;
  } finally {
    b.close();
  }
}

function buildSequence(samples, seqDir, end) {
  fs.rmSync(seqDir, { recursive: true, force: true });
  fs.mkdirSync(seqDir, { recursive: true });

  const total = Math.round(end * FPS);
  let j = 0;
  let worst = 0;
  for (let i = 0; i < total; i++) {
    const target = i / FPS;
    // Берём последний снимок, сделанный не позже нужного момента, — так же
    // ведёт себя настоящий экран: кадр висит, пока не пришёл следующий.
    while (j + 1 < samples.length && samples[j + 1].t <= target) j++;
    worst = Math.max(worst, Math.abs(target - samples[j].t));
    fs.copyFileSync(samples[j].file, path.join(seqDir, String(i).padStart(5, '0') + '.jpg'));
  }
  console.log('      кадров:', total, ', худшее расхождение по времени:', Math.round(worst * 1000), 'мс');
}

/* ---------- запуск ---------- */
(async () => {
  if (!CHROME) throw new Error('не нашёл Chrome. Укажите путь в переменной PROMO_CHROME');
  for (const f of ['promo.html', 'voice.mp3']) {
    if (!fs.existsSync(path.join(DIR, f))) throw new Error('нет файла promo/' + f);
  }

  fs.mkdirSync(WORK, { recursive: true });
  const bed = path.join(WORK, 'bed.webm');
  const shots = path.join(WORK, 'shots');
  const seq = path.join(WORK, 'seq');

  // Своя раздача файлов: страница читает voice.mp3, а по file:// браузер
  // такие запросы блокирует.
  const types = { '.html': 'text/html; charset=utf-8', '.mp3': 'audio/mpeg' };
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'promo.html';
    const file = path.join(DIR, rel);
    if (!file.startsWith(DIR)) return res.writeHead(403).end();
    fs.readFile(file, (err, buf) => {
      if (err) return res.writeHead(404).end();
      res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
      res.end(buf);
    });
  }).listen(PORT);

  try {
    // Длительность берём из самого ролика, чтобы она не разъезжалась с CONFIG.end.
    const probe = await launch(9230, ['--window-size=600,900']);
    const end = await probe.evalJs('CONFIG.end');
    probe.close();

    const lag = await recordBed(bed);
    buildSequence(await shootFrames(shots, end), seq, end);

    console.log('[3/3] собираю файл…');
    // Дорожку со звуками сдвигаем на задержку старта записи, голос кладём как есть:
    // он и задаёт нулевую отметку ролика. normalize=0 — иначе amix делит
    // громкость на число входов и всё становится вдвое тише.
    execFileSync(FFMPEG, [
      '-y',
      '-framerate', String(FPS), '-i', path.join(seq, '%05d.jpg'),
      '-ss', lag.toFixed(3), '-i', bed,
      '-i', path.join(DIR, 'voice.mp3'),
      // highpass — захват вкладки добавляет низкочастотные толчки, слышные в
      // хвосте, где голос уже отговорил. Все звуки переписки лежат выше 400 Гц,
      // поэтому срез на 150 убирает толчки и не трогает сами звуки.
      '-filter_complex',
      // afade — после 36.4 в ролике не звучит ничего запланированного, так что
      // хвост дорожки просто гасим: тишина под финальной карточкой чище шороха.
      '[1:a]highpass=f=150:poles=2,afade=t=out:st=36.4:d=0.6[sfx];'
        + '[sfx][2:a]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.97[a]',
      '-map', '0:v', '-map', '[a]',
      '-c:v', 'libx264', '-preset', 'slow', '-crf', '19', '-pix_fmt', 'yuv420p', '-r', String(FPS),
      '-c:a', 'aac', '-b:a', '192k',
      '-movflags', '+faststart', '-t', String(end),
      OUT,
    ], { stdio: ['ignore', 'ignore', 'inherit'] });

    console.log('готово:', OUT, (fs.statSync(OUT).size / 1048576).toFixed(1), 'МБ');
  } finally {
    server.close();
  }
})().catch((e) => { console.error('ОШИБКА:', e.message); process.exit(1); });
