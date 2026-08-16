require('dotenv').config();

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const pino = require('pino');
const { getAIReply, resetHistory } = require('./ai');
const { AUTH_DIR, loadSessionFromEnv } = require('./session-store');

const logger = pino({ level: 'silent' });

// Текущий QR и состояние связи. Нужны эндпоинту /qr: в логах Render код
// отсканировать нельзя — вьюер логов растягивает блок-символы по вертикали,
// и квадраты кода превращаются в прямоугольники. Плюс QR живёт около 20 секунд,
// так что в ленте логов нужный уже уехал вверх.
const status = { connection: 'connecting', qr: null, qrAt: 0 };

function getStatus() {
  return { ...status };
}

// «996700000000:0@s.whatsapp.net» -> «996700000000». Номер устройства после
// двоеточия отрезаем отдельно: иначе он приклеивается к телефону лишней цифрой,
// и номер получается почти правильный — а такую ошибку глазами не поймать.
function digitsFromJid(jid) {
  return String(jid || '').split('@')[0].split(':')[0].replace(/\D/g, '') || null;
}

// Настоящий телефон клиента. WhatsApp адресует чаты по LID — внутреннему
// идентификатору вида «123456789012345@lid», номера в нём нет. Владельцу в
// заявке нужен номер, по которому можно перезвонить, поэтому достаём его из
// маппинга, который Baileys держит в папке сессии (lid-mapping-*.json).
async function resolveCustomerPhone(sock, msg, chatId) {
  // Старая адресация: номер прямо в JID.
  if (chatId.endsWith('@s.whatsapp.net')) {
    return digitsFromJid(chatId);
  }

  // WhatsApp часто кладёт номер рядом с LID прямо в ключ сообщения —
  // это дешевле, чем лезть в хранилище.
  const alt = msg.key.remoteJidAlt || msg.key.participantAlt;
  if (alt && alt.endsWith('@s.whatsapp.net')) {
    return digitsFromJid(alt);
  }

  try {
    const pn = await sock.signalRepository?.lidMapping?.getPNForLID(chatId);
    if (pn) return digitsFromJid(pn);
  } catch (err) {
    console.error('Не удалось определить номер клиента по LID:', err.message);
  }

  // Номера нет — пусть заявка уйдёт без него. Потерять заявку хуже,
  // чем отдать её владельцу с пометкой «номер скрыт».
  return null;
}

// Картинка из сообщения клиента. WhatsApp хранит медиа зашифрованным на своих
// серверах, поэтому фото надо именно скачать и расшифровать — в самом сообщении
// лежит только миниатюра размером с ноготь, распознать по ней нечего.
async function downloadPhoto(sock, msg) {
  const image = msg.message.imageMessage;
  if (!image) return null;

  try {
    const data = await downloadMediaMessage(msg, 'buffer', {}, {
      logger,
      reuploadRequest: sock.updateMediaMessage,
    });
    return { data, mimeType: image.mimetype || 'image/jpeg' };
  } catch (err) {
    // Фото не скачалось — отвечаем клиенту по подписи, а не молчим.
    console.error('Не удалось скачать фото клиента:', err.message);
    return null;
  }
}

// Переподключаемся с нарастающей паузой. Повтор без паузы превращается в цикл:
// WhatsApp видит поток попыток, считает его флудом и рвёт соединение ещё охотнее —
// со стороны это выглядит как «бот то работает, то нет».
let reconnectDelay = 1000;
const RECONNECT_DELAY_MAX = 30000;

// Живое соединение с WhatsApp. Нужно наружу, чтобы админка могла написать
// клиенту сама — например, что его запись перенесли. Пишем только тем, кто уже
// переписывался с ботом: сообщение первым незнакомому номеру WhatsApp считает
// спамом и блокирует номер салона.
let liveSock = null;

async function sendToClient(chatId, text) {
  if (!chatId) return false;
  if (!liveSock || status.connection !== 'open') {
    console.error('WhatsApp не на связи — сообщение клиенту не отправлено.');
    return false;
  }
  try {
    await liveSock.sendMessage(chatId, { text });
    return true;
  } catch (err) {
    console.error('Не удалось написать клиенту в WhatsApp:', err.message);
    return false;
  }
}

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
  liveSock = sock;

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      status.qr = qr;
      status.qrAt = Date.now();
      // В локальном терминале код читается нормально, поэтому печатаем как раньше.
      console.log('Отсканируйте QR-код в WhatsApp (Связанные устройства):');
      qrcode.generate(qr, { small: true });
      console.log('Не получается отсканировать из логов? Откройте /qr у сервиса.');
      QRCode.toFile('qr.png', qr, { width: 400 }).catch((err) => {
        console.error('Не удалось сохранить QR как PNG:', err);
      });
    }

    if (connection === 'close') {
      status.connection = 'close';
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      const reason = lastDisconnect?.error?.message || 'причина неизвестна';
      if (!shouldReconnect) {
        console.log(`Соединение закрыто (код ${statusCode}): ${reason}. Нужен повторный вход по QR — откройте /qr.`);
        return;
      }
      const wait = reconnectDelay;
      reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_DELAY_MAX);
      console.log(`Соединение закрыто (код ${statusCode}): ${reason}. Переподключаюсь через ${Math.round(wait / 1000)} с.`);
      setTimeout(() => {
        startBot().catch((err) => console.error('Переподключение не удалось:', err.message));
      }, wait);
    } else if (connection === 'open') {
      status.connection = 'open';
      reconnectDelay = 1000;
      // QR больше не актуален: держать его в памяти незачем, а отдавать — опасно.
      status.qr = null;
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

        // Фото без подписи — тоже вопрос: «есть такое?». Раньше такие
        // сообщения молча пропускались, и клиент оставался без ответа.
        if (!text.trim() && !msg.message.imageMessage) continue;

        if (text.trim().toLowerCase() === '/reset') {
          resetHistory(chatId);
          await sock.sendMessage(chatId, { text: 'История диалога очищена.' });
          continue;
        }

        await sock.presenceSubscribe(chatId).catch(() => {});
        await sock.sendPresenceUpdate('composing', chatId).catch(() => {});

        const [phone, photo] = await Promise.all([
          resolveCustomerPhone(sock, msg, chatId),
          downloadPhoto(sock, msg),
        ]);
        const reply = await getAIReply(chatId, text.trim(), { phone, photo });

        await sock.sendPresenceUpdate('paused', chatId).catch(() => {});
        await sock.sendMessage(chatId, { text: reply });
      } catch (err) {
        console.error('Ошибка обработки сообщения:', err);
      }
    }
  });
}

if (require.main === module) {
  startBot().catch((err) => {
    console.error('Не удалось запустить бота:', err);
    process.exit(1);
  });
}

module.exports = { startBot, getStatus, sendToClient, resolveCustomerPhone, digitsFromJid };
