/* Демо режима «Торгаш» без WhatsApp: поторговаться прямо в терминале.
 *
 *   node scripts/haggle-demo.js          — диалог с ботом (нужен GROQ_API_KEY)
 *   node scripts/haggle-demo.js --test   — самопроверка распознавания и фильтра
 *                                          скидок, без сети и без ключей
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// Демо всегда с торгом, что бы ни стояло в .env.
process.env.HAGGLE_MODE = 'true';

const haggle = require('../haggle');
const { grantsDiscount, namedOffer, HAGGLE_INTENT } = haggle._internal;

function selfTest() {
  const cases = [
    // [что проверяем, значение, ожидание]
    ['торг: «скидка будет?»', HAGGLE_INTENT.test('скидка будет?'), true],
    ['торг: «дороговато»', HAGGLE_INTENT.test('дороговато конечно'), true],
    ['торг: «а если 90000?»', HAGGLE_INTENT.test('а если 90000?'), true],
    ['торг: «последняя цена?»', HAGGLE_INTENT.test('какая последняя цена?'), true],
    ['торг: «за 90 000 отдадите?»', HAGGLE_INTENT.test('а если за 90 000 отдадите?'), true],
    ['не торг: «дорогой, привет»', HAGGLE_INTENT.test('дорогой, привет'), false],
    ['не торг: «есть в наличии?»', HAGGLE_INTENT.test('есть в наличии?'), false],
    ['не торг: «сколько стоит?»', HAGGLE_INTENT.test('сколько стоит?'), false],

    ['сумма: «за 90 000 отдадите»', namedOffer('за 90 000 отдадите?'), 90000],
    ['сумма: «дам 85к»', namedOffer('дам 85к'), 85000],
    ['сумма: «айфон 17»', namedOffer('айфон 17 есть?'), null],

    ['скидка: «сделаю скидку 10%»', grantsDiscount('Хорошо, сделаю скидку 10%'), true],
    ['скидка: «отдам за 80000»', grantsDiscount('Ладно, отдам за 80000'), true],
    ['скидка: «минус 5%»', grantsDiscount('Договорились, минус 5%'), true],
    ['отказ: «скидок нет»', grantsDiscount('Скидок нет, цена окончательная'), false],
    ['отказ: «скидку сделать не могу»', grantsDiscount('Скидку сделать не могу, извините'), false],
    ['обычный ответ', grantsDiscount('Цена 129 900 сом, есть в наличии 3 шт.'), false],
  ];

  let bad = 0;
  for (const [name, got, want] of cases) {
    const ok = got === want;
    if (!ok) bad += 1;
    console.log(`${ok ? '✅' : '❌'} ${name} → ${JSON.stringify(got)}`);
  }

  console.log('\nЗаготовки по раундам:');
  for (let n = 1; n <= 5; n += 1) {
    const ctx = { state: { n }, offer: n === 2 ? 90000 : null };
    console.log(`  ${n}. ${haggle.fallback(ctx)}${haggle.badge(ctx)}`.replace(/\n/g, ' '));
  }

  console.log(bad ? `\n${bad} проверок не прошло.` : '\nВсе проверки прошли.');
  process.exit(bad ? 1 : 0);
}

async function chat() {
  if (!process.env.GROQ_API_KEY) {
    console.error('Нет GROQ_API_KEY в .env — живой диалог не запустится.');
    console.error('Проверить логику без сети: node scripts/haggle-demo.js --test');
    process.exit(1);
  }

  const { getAIReply } = require('../ai');
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const chatId = 'demo@s.whatsapp.net';

  console.log('Режим «Торгаш». Пишите как клиент, торгуйтесь. Ctrl+C — выход.\n');
  rl.setPrompt('Клиент: ');
  rl.prompt();

  rl.on('line', async (line) => {
    const text = line.trim();
    if (!text) return rl.prompt();
    try {
      const reply = await getAIReply(chatId, text);
      console.log(`\nБот: ${reply}\n`);
    } catch (err) {
      console.error('Ошибка:', err.message, '\n');
    }
    rl.prompt();
  });
}

if (process.argv.includes('--test')) selfTest();
else chat();
