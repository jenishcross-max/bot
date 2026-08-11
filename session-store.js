const fs = require('fs');
const path = require('path');

const AUTH_DIR = process.env.AUTH_DIR || 'auth_info';

// Загружает сессию из переменной окружения AUTH_INFO_B64 (если папки с сессией ещё нет).
// Нужно для деплоя на Render free tier, где диск эфемерный и нет доступа к терминалу для QR.
function loadSessionFromEnv() {
  const b64 = process.env.AUTH_INFO_B64;
  if (!b64) return;

  const alreadyExists = fs.existsSync(AUTH_DIR) && fs.readdirSync(AUTH_DIR).length > 0;
  if (alreadyExists) return;

  const files = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  for (const [filename, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(AUTH_DIR, filename), content, 'utf8');
  }
  console.log(`Сессия WhatsApp восстановлена из AUTH_INFO_B64 (${Object.keys(files).length} файлов).`);
}

module.exports = { AUTH_DIR, loadSessionFromEnv };
