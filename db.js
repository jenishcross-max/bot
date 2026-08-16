// База салона: услуги с ценами и записи клиентов.
//
// Услуги живут в таблице products — имя досталось от прежней версии бота, и
// переименовывать таблицу с живыми данными ради красоты мы не стали. Колонки
// склада (quantity, in_stock, category, photo_url) в ней ещё есть, но код их
// больше не трогает: у услуги нет остатка, и «стрижка, 1 шт.» — бессмыслица,
// из-за которой всё это и переделывалось.
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

/* ---------------- услуги ---------------- */

// Длительность услуги в минутах. Пусто — значит «как обычно», это решает salon.js.
function cleanDuration(minutes) {
  const n = Number(minutes);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.round(n), 12 * 60) : null;
}

function cleanPrice(price) {
  if (price === undefined || price === null || price === '') return null;
  const n = Number(price);
  return Number.isFinite(n) ? n : null;
}

async function addService({ name, price, description, durationMinutes }) {
  const { data, error } = await supabase
    .from('products')
    .insert({
      name,
      price: cleanPrice(price),
      description: description || null,
      duration_minutes: cleanDuration(durationMinutes),
      // in_stock клиенту больше ничего не решает, но старые строки могли лечь с
      // false — ставим true, чтобы услуга не осталась невидимой в чужом коде.
      in_stock: true,
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

async function listServices({ limit = 50 } = {}) {
  const { data, error } = await supabase
    .from('products')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw error;
  return data;
}

async function deleteService(id) {
  const { error } = await supabase.from('products').delete().eq('id', id);
  if (error) throw error;
}

async function getService(id) {
  const { data, error } = await supabase.from('products').select('*').eq('id', id).single();
  if (error) throw error;
  return data;
}

// Названия услуг — подсказка каталога для разборщика фраз.
async function getServiceNames() {
  const { data, error } = await supabase.from('products').select('name').order('name');
  if (error) throw error;
  return data.map((s) => s.name);
}

// Экранируем спецсимволы PostgREST-фильтров (,()) и ILIKE-wildcards (%_), чтобы
// текст клиента нельзя было использовать для инъекции в запрос.
function sanitizeForIlike(text) {
  return text.replace(/[,()%_]/g, '\\$&');
}

// Слова, которые есть почти в любом вопросе клиента — искать по ним бессмысленно.
const STOP_WORDS = new Set([
  'есть', 'сколько', 'какая', 'какие', 'какой', 'цена', 'цены', 'стоит', 'стоят',
  'хочу', 'нужно', 'нужен', 'нужна', 'записаться', 'запись', 'записать',
  'здравствуйте', 'привет', 'подскажите', 'пожалуйста', 'услуга', 'услуги', 'салон',
]);

// Поиск по ключевым словам вопроса. Клиент пишет фразой («а окрашивание делаете?»),
// поэтому ищем по каждому значимому слову отдельно и по его основе — ILIKE по всей
// фразе не совпадёт с названием услуги никогда.
async function searchServices(query, { limit = 8 } = {}) {
  const wholePriceList = async () => {
    const { data, error } = await supabase.from('products').select('*').limit(limit);
    if (error) throw error;
    return data;
  };

  if (!query || !query.trim()) return wholePriceList();

  const words = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 4 && !STOP_WORDS.has(w));

  if (words.length === 0) return wholePriceList();

  const patterns = new Set();
  for (const word of words) {
    patterns.add(word);
    // Основа слова: «окрашивания» должно находить «окрашивание».
    if (word.length >= 6) patterns.add(word.slice(0, word.length - 2));
  }

  const filter = [...patterns]
    .map((p) => sanitizeForIlike(p))
    .flatMap((p) => [`name.ilike.%${p}%`, `description.ilike.%${p}%`])
    .join(',');

  const { data, error } = await supabase.from('products').select('*').or(filter).limit(limit);

  if (error) throw error;
  // Ничего не нашли — отдаём прайс целиком: пусть бот предложит, что есть,
  // вместо «не знаю».
  return data.length > 0 ? data : wholePriceList();
}

async function findByIlike(pattern) {
  const { data, error } = await supabase
    .from('products')
    .select('*')
    .ilike('name', pattern)
    .limit(1);
  if (error) throw error;
  return data?.[0] || null;
}

// Услуга по названию из живой речи: «на окрашивание» -> «Окрашивание».
// Нужна ради длительности — записать клиента на три часа можно, только зная,
// что он назвал именно окраску.
async function findServiceByName(name) {
  const trimmed = (name || '').trim();
  if (!trimmed) return null;

  const direct = await findByIlike(`%${sanitizeForIlike(trimmed)}%`);
  if (direct) return direct;

  const longestWord = trimmed.split(/\s+/).sort((a, b) => b.length - a.length)[0];
  if (!longestWord || longestWord.length < 5) return null;

  // Отсекаем до трёх последних символов, пока не найдём совпадение по основе.
  for (let cut = 1; cut <= 3; cut += 1) {
    const stem = longestWord.slice(0, longestWord.length - cut);
    if (stem.length < 4) break;
    const match = await findByIlike(`%${sanitizeForIlike(stem)}%`);
    if (match) return match;
  }

  return null;
}

async function updateServiceById(id, patch) {
  const { data, error } = await supabase
    .from('products')
    .update(patch)
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

// Добавляет услугу или правит существующую. Совпадение ищем точное (без учёта
// регистра), а не по основе слова: «стрижка» и «стрижка детская» — разные
// услуги, и цену второй нельзя записывать в первую.
async function saveService({ name, price, durationMinutes }) {
  const clean = String(name || '').trim();
  if (!clean) throw new Error('Не указано название услуги');

  const existing = await findByIlike(sanitizeForIlike(clean));
  if (existing) {
    const patch = { in_stock: true };
    if (cleanPrice(price) !== null) patch.price = cleanPrice(price);
    if (cleanDuration(durationMinutes) !== null) patch.duration_minutes = cleanDuration(durationMinutes);
    const updated = await updateServiceById(existing.id, patch);
    return { service: updated, created: false, before: existing };
  }

  const created = await addService({ name: clean, price, durationMinutes });
  return { service: created, created: true };
}

/* ---------------- записи клиентов ---------------- */

// Статусы держим строками, а не булевыми флагами: «отменена», «пришёл» и «не
// пришёл» — три разные вещи, и владельцу в истории важно, чем закончилось.
const APPOINTMENT_STATUSES = ['active', 'done', 'cancelled', 'no_show'];

async function createAppointment({
  clientName,
  phone,
  chatId,
  service,
  master,
  startsAt,
  durationMinutes,
  source = 'whatsapp',
  note,
}) {
  const { data, error } = await supabase
    .from('appointments')
    .insert({
      client_name: clientName,
      phone: phone ? String(phone).replace(/\D/g, '') : null,
      chat_id: chatId || null,
      service: service || null,
      master: master || null,
      starts_at: new Date(startsAt).toISOString(),
      // Длительность записываем снимком: услуга подорожает и удлинится, а
      // вчерашняя запись должна занимать столько, сколько занимала.
      duration_minutes: cleanDuration(durationMinutes),
      status: 'active',
      source,
      note: note || null,
    })
    .select()
    .single();

  if (error) throw explainAppointmentsError(error);
  return data;
}

// Таблица бывает создана через интерфейс Supabase — там защита строк (RLS)
// включена по умолчанию, и запись молча запрещена всем. Postgres сообщает об
// этом на своём языке, поэтому переводим: иначе в логах лежит «new row violates
// row-level security policy», а владелец видит только «не смог записать».
function explainAppointmentsError(error) {
  if (!/row-level security/i.test(error.message || '')) return error;
  return new Error(
    'Таблица appointments закрыта политикой RLS — записи не сохраняются. ' +
      'Выполните в Supabase (SQL Editor): alter table appointments disable row level security;'
  );
}

// from/to — моменты времени; всё остальное необязательно.
async function listAppointments({ from, to, status = 'active', limit = 50 } = {}) {
  let query = supabase.from('appointments').select('*').order('starts_at', { ascending: true });

  if (status) query = query.eq('status', status);
  if (from) query = query.gte('starts_at', new Date(from).toISOString());
  if (to) query = query.lt('starts_at', new Date(to).toISOString());

  const { data, error } = await query.limit(limit);
  if (error) throw error;
  return data;
}

async function getAppointment(id) {
  const { data, error } = await supabase.from('appointments').select('*').eq('id', id).single();
  if (error) throw error;
  return data;
}

async function setAppointmentStatus(id, status) {
  if (!APPOINTMENT_STATUSES.includes(status)) throw new Error(`Неизвестный статус записи: ${status}`);
  const { data, error } = await supabase
    .from('appointments')
    .update({ status })
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

// Перенос записи: меняется время, иногда заодно мастер. Отдельной функцией, а не
// «отменить и создать заново», — иначе в истории клиента вместо одного визита
// остаётся отменённая запись и загадочная новая.
async function moveAppointment(id, { startsAt, master, durationMinutes }) {
  const patch = {};
  if (startsAt) patch.starts_at = new Date(startsAt).toISOString();
  if (master !== undefined) patch.master = master || null;
  if (durationMinutes !== undefined) patch.duration_minutes = cleanDuration(durationMinutes);

  const { data, error } = await supabase
    .from('appointments')
    .update(patch)
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

// Записи конкретного клиента — по номеру или по чату WhatsApp. Номер не всегда
// известен (WhatsApp отдаёт LID), поэтому ищем по тому, что есть.
async function findClientAppointments({ phone, chatId, status = 'active', limit = 10 }) {
  const digits = phone ? String(phone).replace(/\D/g, '') : null;
  if (!digits && !chatId) return [];

  let query = supabase.from('appointments').select('*').order('starts_at', { ascending: true });
  if (status) query = query.eq('status', status);
  query = digits && chatId
    ? query.or(`phone.eq.${digits},chat_id.eq.${chatId}`)
    : query.eq(digits ? 'phone' : 'chat_id', digits || chatId);

  const { data, error } = await query.limit(limit);
  if (error) throw error;
  return data;
}

module.exports = {
  createAppointment,
  listAppointments,
  getAppointment,
  setAppointmentStatus,
  moveAppointment,
  findClientAppointments,
  addService,
  listServices,
  deleteService,
  getService,
  getServiceNames,
  saveService,
  searchServices,
  findServiceByName,
};
