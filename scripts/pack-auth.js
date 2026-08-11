// Упаковывает локальную папку auth_info в base64-строку для переменной окружения
// AUTH_INFO_B64 на Render. Запуск: node scripts/pack-auth.js
const fs = require('fs');
const path = require('path');

const AUTH_DIR = process.env.AUTH_DIR || 'auth_info';
const OUT_FILE = 'auth_info.b64.txt';

if (!fs.existsSync(AUTH_DIR)) {
  console.error(`Папка "${AUTH_DIR}" не найдена. Сначала запустите "npm start" и отсканируйте QR-код.`);
  process.exit(1);
}

const filenames = fs.readdirSync(AUTH_DIR).filter((f) => f.endsWith('.json'));
if (filenames.length === 0) {
  console.error(`В папке "${AUTH_DIR}" нет файлов сессии. Сначала войдите по QR-коду.`);
  process.exit(1);
}

const files = {};
for (const filename of filenames) {
  files[filename] = fs.readFileSync(path.join(AUTH_DIR, filename), 'utf8');
}

const b64 = Buffer.from(JSON.stringify(files), 'utf8').toString('base64');
fs.writeFileSync(OUT_FILE, b64, 'utf8');

console.log(`Готово! ${filenames.length} файлов сессии упаковано.`);
console.log(`Base64-строка сохранена в ${OUT_FILE} (${b64.length} символов).`);
console.log('Скопируйте её содержимое в переменную окружения AUTH_INFO_B64 на Render.');
