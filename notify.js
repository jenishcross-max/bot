// Отправка уведомлений владельцу магазина в Telegram (используется WhatsApp-ботом,
// чтобы владелец сразу видел заявку клиента, а не искал её в переписке).
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_IDS = (process.env.ADMIN_TELEGRAM_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

async function notifyAdmins(text) {
  if (!BOT_TOKEN || ADMIN_IDS.length === 0) return;

  await Promise.all(
    ADMIN_IDS.map(async (chatId) => {
      try {
        const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text }),
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
