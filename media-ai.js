// Фото и голос — всё, что приходит в салон не текстом.
//
// Клиент присылает фотографию причёски или цвета вместо описания словами
// («хочу вот так»), а владелец наговаривает записи голосом, потому что на
// работе печатать некогда. И то, и другое здесь превращается в текст, дальше
// всё идёт обычным путём.
const Groq = require('groq-sdk');
const { toFile } = require('groq-sdk');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Модель, умеющая смотреть на картинки. Прежняя llama-4-scout из Groq пропала —
// запросы к ней возвращали 404, и распознавание фото молча переставало работать.
// Если и эта исчезнет, список доступных моделей: https://console.groq.com/docs/models
const VISION_MODEL = process.env.GROQ_VISION_MODEL || 'qwen/qwen3.6-27b';
const AUDIO_MODEL = process.env.GROQ_AUDIO_MODEL || 'whisper-large-v3';

// Рассуждающие модели пишут ход мыслей рядом с JSON, и голый JSON.parse на этом падает.
function extractJson(raw) {
  const text = String(raw || '').replace(/<think>[\s\S]*?<\/think>/gi, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

const PHOTO_SYSTEM_PROMPT = `Ты смотришь на фото, которое клиент прислал в салон красоты. Опиши, что на нём.
Верни ТОЛЬКО JSON без пояснений, в формате:
{"description": "что видно: причёска, длина, цвет волос, укладка, маникюр — одна-две фразы",
 "query": "2-4 слова названия услуги, которая ближе всего к желаемому (например «окрашивание блонд»)"}

Правила:
- Пиши по-русски.
- Описывай только то, что действительно видно. Название краски, номер цвета и
  технику не выдумывай: если не разобрать, так и не упоминай.
- Если на фото не причёска и не работа мастера (документ, скриншот, что-то
  неразборчивое) — оставь "query" пустой строкой, а в "description" честно
  напиши, что видно.`;

async function describeClientPhoto(base64Image, mimeType = 'image/jpeg', caption = '') {
  const completion = await groq.chat.completions.create({
    model: VISION_MODEL,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            // Подпись помогает модели: «а так сможете?» подсказывает, что важна
            // причёска, а не фон комнаты.
            text: PHOTO_SYSTEM_PROMPT + (caption ? `\n\nПодпись клиента к фото: «${caption}»` : ''),
          },
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Image}` } },
        ],
      },
    ],
    temperature: 0,
    response_format: { type: 'json_object' },
    max_completion_tokens: 1200,
  });

  const parsed = extractJson(completion.choices[0]?.message?.content);
  const description = String((parsed && parsed.description) || '').trim();
  if (!description) return null;
  return { description, query: String((parsed && parsed.query) || '').trim() };
}

// Голосовое сообщение из Telegram (ogg/opus) -> текст, дальше разбирается как обычное.
async function transcribeVoice(buffer, filename = 'voice.ogg') {
  const transcription = await groq.audio.transcriptions.create({
    file: await toFile(buffer, filename),
    model: AUDIO_MODEL,
    language: 'ru',
  });

  return transcription.text?.trim() || '';
}

module.exports = { describeClientPhoto, transcribeVoice };
