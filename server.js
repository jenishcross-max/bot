// Единая точка входа для деплоя: поднимает WhatsApp-бота, Telegram-админку и
// HTTP-эндпоинт здоровья в одном процессе.
//
// Почему в одном: на бесплатном тарифе Render часы инстансов общие на аккаунт,
// двух круглосуточных сервисов там не хватит. Плюс free-тариф даёт только web-сервисы,
// поэтому нужен слушающий порт — им и служит health-эндпоинт (его же можно пинговать,
// чтобы сервис не засыпал).
require('dotenv').config();

const http = require('http');
const { startBot } = require('./index');
const { launchAdminBot } = require('./telegram-admin-bot');

const PORT = process.env.PORT || 3000;
const startedAt = new Date();

http
  .createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(
      JSON.stringify({
        status: 'ok',
        shopMode: process.env.SHOP_MODE === 'true',
        startedAt: startedAt.toISOString(),
        uptimeSeconds: Math.round(process.uptime()),
      })
    );
  })
  .listen(PORT, () => console.log(`Health-эндпоинт слушает порт ${PORT}.`));

launchAdminBot();

startBot().catch((err) => {
  console.error('Не удалось запустить WhatsApp-бота:', err);
});
