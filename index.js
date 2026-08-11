require('dotenv').config();

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const { getAIReply, resetHistory } = require('./ai');
const { AUTH_DIR, loadSessionFromEnv } = require('./session-store');

const logger = pino({ level: 'silent' });

async function startBot() {
  loadSessionFromEnv();
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
  });

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('Отсканируйте QR-код в WhatsApp (Связанные устройства):');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log('Соединение закрыто.', shouldReconnect ? 'Переподключение...' : 'Нужен повторный вход по QR.');
      if (shouldReconnect) {
        startBot();
      }
    } else if (connection === 'open') {
      console.log('Бот подключен к WhatsApp.');
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      try {
        if (!msg.message || msg.key.fromMe) continue;

        const chatId = msg.key.remoteJid;
        if (!chatId || chatId.endsWith('@g.us') || chatId === 'status@broadcast') continue;

        const text =
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          msg.message.imageMessage?.caption ||
          '';

        if (!text.trim()) continue;

        if (text.trim().toLowerCase() === '/reset') {
          resetHistory(chatId);
          await sock.sendMessage(chatId, { text: 'История диалога очищена.' });
          continue;
        }

        await sock.presenceSubscribe(chatId).catch(() => {});
        await sock.sendPresenceUpdate('composing', chatId).catch(() => {});

        const reply = await getAIReply(chatId, text.trim());

        await sock.sendPresenceUpdate('paused', chatId).catch(() => {});
        await sock.sendMessage(chatId, { text: reply });
      } catch (err) {
        console.error('Ошибка обработки сообщения:', err);
      }
    }
  });
}

startBot().catch((err) => {
  console.error('Не удалось запустить бота:', err);
  process.exit(1);
});
