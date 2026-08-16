// Единая точка входа для деплоя: поднимает WhatsApp-бота, Telegram-админку и
// HTTP-эндпоинт здоровья в одном процессе.
//
// Почему в одном: на бесплатном тарифе Render часы инстансов общие на аккаунт,
// двух круглосуточных сервисов там не хватит. Плюс free-тариф даёт только web-сервисы,
// поэтому нужен слушающий порт — им и служит health-эндпоинт (его же можно пинговать,
// чтобы сервис не засыпал).
require('dotenv').config();

const http = require('http');
const crypto = require('crypto');
const QRCode = require('qrcode');
const { startBot, getStatus } = require('./index');
const { launchAdminBot, getAdminStatus } = require('./telegram-admin-bot');

const PORT = process.env.PORT || 3000;
const startedAt = new Date();

// Обработчик вебхука Telegram. Появляется после запуска админки: до этого
// момента апдейтов быть не может — Telegram ещё не знает нашего адреса.
let telegramWebhook = null;

// Кто отсканирует QR — тот и привяжет свой WhatsApp к этому боту. Поэтому страница
// с кодом закрыта токеном: без него /qr не отдаётся вообще, даже если код готов.
const QR_TOKEN = process.env.QR_TOKEN || '';

// Сравнение постоянного времени: обычное === подсказывает подбирающему длину
// совпавшего префикса по времени ответа.
function tokenOk(given) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(QR_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function send(res, code, type, body) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

function page(body) {
  return (
    '<!doctype html><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>QR WhatsApp</title>' +
    '<body style="font-family:system-ui,sans-serif;text-align:center;padding:24px">' +
    body +
    '</body>'
  );
}

const routes = {
  '/': (req, res) =>
    send(
      res,
      200,
      'application/json; charset=utf-8',
      JSON.stringify({
        status: 'ok',
        whatsapp: getStatus().connection,
        // Состояние админки видно снаружи: чаще всего «бот отвечает не так» —
        // это незаполненная переменная на сервере, а не поломка в коде.
        salon: {
          masters: require('./salon').MASTERS,
          hours: require('./salon').workHoursText(),
        },
        telegram: getAdminStatus(),
        startedAt: startedAt.toISOString(),
        uptimeSeconds: Math.round(process.uptime()),
      })
    ),

  // Страница с кодом. Перезагружается сама: QR живёт около 20 секунд, вручную
  // обновлять быстрее, чем он протухает, никто не будет.
  '/qr': (req, res) => {
    const { connection, qr } = getStatus();
    if (connection === 'open') {
      return send(res, 200, 'text/html; charset=utf-8', page('<h2>Бот уже подключён к WhatsApp.</h2>'));
    }
    if (!qr) {
      return send(
        res,
        200,
        'text/html; charset=utf-8',
        page('<meta http-equiv="refresh" content="3"><h2>Код ещё не готов, ждём…</h2>')
      );
    }
    return send(
      res,
      200,
      'text/html; charset=utf-8',
      page(
        '<meta http-equiv="refresh" content="15">' +
          '<h2>WhatsApp → Связанные устройства → Привязка устройства</h2>' +
          `<img alt="QR" style="width:min(90vw,360px)" src="/qr.png?token=${encodeURIComponent(req.token)}&t=${Date.now()}">` +
          '<p>Страница обновляется сама каждые 15 секунд — код живёт недолго.</p>'
      )
    );
  },

  '/qr.png': async (req, res) => {
    const { qr } = getStatus();
    if (!qr) return send(res, 404, 'text/plain; charset=utf-8', 'QR сейчас нет');
    try {
      const png = await QRCode.toBuffer(qr, { width: 512, margin: 2 });
      return send(res, 200, 'image/png', png);
    } catch (err) {
      return send(res, 500, 'text/plain; charset=utf-8', `Не удалось нарисовать QR: ${err.message}`);
    }
  },
};

function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const route = routes[url.pathname];
  if (!route) return send(res, 404, 'text/plain; charset=utf-8', 'Не найдено');

  if (url.pathname.startsWith('/qr')) {
    if (!QR_TOKEN) {
      return send(
        res,
        503,
        'text/plain; charset=utf-8',
        'Не задана переменная QR_TOKEN — без неё страница с кодом не открывается.'
      );
    }
    if (!tokenOk(url.searchParams.get('token'))) {
      return send(res, 403, 'text/plain; charset=utf-8', 'Неверный токен');
    }
    req.token = url.searchParams.get('token');
  }

  return route(req, res);
}

http
  .createServer((req, res) => {
    // Апдейты Telegram приходят POST-ом на секретный путь. Обработчик сам
    // проверяет путь и секретный заголовок, а чужой запрос передаёт дальше.
    if (telegramWebhook) return telegramWebhook(req, res, () => handleRequest(req, res));
    return handleRequest(req, res);
  })
  .listen(PORT, () => console.log(`Health-эндпоинт слушает порт ${PORT}.`));

// Бесплатный тариф Render усыпляет сервис после ~15 минут без входящих запросов.
// Спящий бот не отвечает в WhatsApp: сообщение клиента сервис не будит, будит только
// HTTP-запрос. Поэтому раз в 10 минут дёргаем сами себя по внешнему адресу
// (RENDER_EXTERNAL_URL Render подставляет автоматически).
// Свой пинг — подстраховка, а не замена внешнему монитору: пока сервис уже уснул,
// разбудить себя он не может.
const KEEPALIVE_URL = process.env.KEEPALIVE_URL || process.env.RENDER_EXTERNAL_URL;
if (KEEPALIVE_URL && process.env.KEEPALIVE !== 'false') {
  const https = require('https');
  const client = KEEPALIVE_URL.startsWith('https') ? https : http;
  setInterval(() => {
    client
      .get(KEEPALIVE_URL, (res) => res.resume())
      .on('error', (err) => console.error('Самопинг не прошёл:', err.message));
  }, 10 * 60 * 1000).unref();
  console.log(`Самопинг каждые 10 минут: ${KEEPALIVE_URL}`);
}

// Публичный адрес сервиса. Telegram принимает вебхук только по https, поэтому
// локальный запуск (адреса нет) остаётся на опросе.
const PUBLIC_URL = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '';

launchAdminBot({ publicUrl: PUBLIC_URL.startsWith('https://') ? PUBLIC_URL : null })
  .then((handler) => {
    telegramWebhook = handler;
  })
  .catch((err) => console.error('Не удалось запустить Telegram-админку:', err.message));

startBot().catch((err) => {
  console.error('Не удалось запустить WhatsApp-бота:', err);
});
