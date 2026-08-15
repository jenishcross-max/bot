// Отправка уведомлений владельцу магазина в Telegram (используется WhatsApp-ботом,
// чтобы владелец сразу видел заявку клиента, а не искал её в переписке).
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_IDS = (process.env.ADMIN_TELEGRAM_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// Предупреждаем один раз, а не на каждую заявку: иначе при незаполненных
// переменных лог забьётся одинаковыми строками.
let warned = false;

// buttons — массив рядов инлайн-кнопок ([[{ text, callback_data }]]). Нужны для
// уведомления о новой записи: владельцу удобнее отметить приход прямо из него,
// чем открывать список и искать там нужную строку.
async function notifyAdmins(text, { buttons } = {}) {
  if (!BOT_TOKEN || ADMIN_IDS.length === 0) {
    // Раньше здесь был молчаливый return, и заявки просто пропадали: в логах
    // пусто, клиенту бот отвечает «передал менеджеру», владельцу не приходит
    // ничего. Понять, что не заполнена переменная, было неоткуда.
    if (!warned) {
      warned = true;
      console.error(
        'Заявка НЕ отправлена владельцу: не заданы ' +
          [!BOT_TOKEN && 'TELEGRAM_BOT_TOKEN', ADMIN_IDS.length === 0 && 'ADMIN_TELEGRAM_IDS']
            .filter(Boolean)
            .join(' и ') +
          '. Клиенту при этом бот обещает, что заявка передана.'
      );
    }
    return;
  }

  await Promise.all(
    ADMIN_IDS.map(async (chatId) => {
      try {
        const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text,
            ...(buttons && buttons.length > 0 ? { reply_markup: { inline_keyboard: buttons } } : {}),
          }),
        });
        if (!res.ok) {
          console.error('Не удалось отправить уведомление в Telegram:', await res.text());
        }
      } catch (err) {
        console.error('Ошибка отправки уведомления в Telegram:', err.message);
      }
    })
  );
}

module.exports = { notifyAdmins };
