const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const LOW_STOCK_THRESHOLD = Number(process.env.LOW_STOCK_THRESHOLD || 5);

async function addProduct({ name, price, description, photoUrl, category, quantity }) {
  const qty = Math.max(0, Number(quantity) || 0);
  const { data, error } = await supabase
    .from('products')
    .insert({
      name,
      price,
      description,
      photo_url: photoUrl,
      category,
      quantity: qty,
      in_stock: qty > 0,
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

async function listProducts({ limit = 50 } = {}) {
  const { data, error } = await supabase
    .from('products')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw error;
  return data;
}

async function deleteProduct(id) {
  const { error } = await supabase.from('products').delete().eq('id', id);
  if (error) throw error;
}

async function getProduct(id) {
  const { data, error } = await supabase.from('products').select('*').eq('id', id).single();
  if (error) throw error;
  return data;
}

// Возвращает названия товаров — используется как подсказка каталога для ИИ-парсера.
async function getProductNames() {
  const { data, error } = await supabase.from('products').select('name').order('name');
  if (error) throw error;
  return data.map((p) => p.name);
}

// Экранируем спецсимволы PostgREST-фильтров (,()) и ILIKE-wildcards (%_), чтобы
// пользовательский текст нельзя было использовать для инъекции в запрос.
function sanitizeForIlike(text) {
  return text.replace(/[,()%_]/g, '\\$&');
}

// Слова, по которым искать бессмысленно — они есть почти в любом вопросе клиента.
const STOP_WORDS = new Set([
  'есть', 'сколько', 'какая', 'какие', 'какой', 'цена', 'цены', 'стоит', 'стоят',
  'наличии', 'наличие', 'хочу', 'нужно', 'нужен', 'нужна', 'купить', 'заказать',
  'здравствуйте', 'привет', 'подскажите', 'пожалуйста', 'товар', 'товары', 'магазин',
]);

// Поиск по ключевым словам вопроса. Клиент пишет фразой («а сухарики есть?»), поэтому
// ищем по каждому значимому слову отдельно и по его основе — иначе ILIKE по всей фразе
// никогда не совпадёт с названием товара.
async function searchProducts(query, { limit = 8 } = {}) {
  const inStockCatalog = async () => {
    const { data, error } = await supabase
      .from('products')
      .select('*')
      .eq('in_stock', true)
      .limit(limit);
    if (error) throw error;
    return data;
  };

  if (!query || !query.trim()) return inStockCatalog();

  const words = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 4 && !STOP_WORDS.has(w));

  if (words.length === 0) return inStockCatalog();

  const patterns = new Set();
  for (const word of words) {
    patterns.add(word);
    // Основа слова — «сухариков» должно находить «сухарики».
    if (word.length >= 6) patterns.add(word.slice(0, word.length - 2));
  }

  const filter = [...patterns]
    .map((p) => sanitizeForIlike(p))
    .flatMap((p) => [`name.ilike.%${p}%`, `description.ilike.%${p}%`, `category.ilike.%${p}%`])
    .join(',');

  const { data, error } = await supabase
    .from('products')
    .select('*')
    .or(filter)
    .eq('in_stock', true)
    .limit(limit);

  if (error) throw error;
  // Ничего не нашли — отдаём каталог, чтобы бот мог предложить альтернативу вместо «не знаю».
  return data.length > 0 ? data : inStockCatalog();
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

// Находит товар по имени. Кроме точного вхождения пробует основу слова, чтобы
// «ватрушек»/«ватрушками» находили товар «Ватрушки» — русские окончания меняются,
// а полноценной морфологии здесь не нужно.
async function findProductByName(name) {
  const trimmed = (name || '').trim();
  if (!trimmed) return null;

  const direct = await findByIlike(`%${sanitizeForIlike(trimmed)}%`);
  if (direct) return direct;

  // Берём самое длинное слово — оно обычно и есть название товара.
  const longestWord = trimmed
    .split(/\s+/)
    .sort((a, b) => b.length - a.length)[0];
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

async function updateProductById(id, patch) {
  const { data, error } = await supabase
    .from('products')
    .update(patch)
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

// Возвращает товар к состоянию из снимка (используется кнопкой «Отменить»).
async function restoreProduct(snapshot) {
  return updateProductById(snapshot.id, {
    name: snapshot.name,
    price: snapshot.price,
    quantity: snapshot.quantity,
    in_stock: snapshot.in_stock,
  });
}

// Краткая сводка по складу: сколько товаров, суммарный остаток, что заканчивается.
async function getStockSummary() {
  const { data, error } = await supabase
    .from('products')
    .select('name, quantity, in_stock, price')
    .order('name', { ascending: true });
  if (error) throw error;

  const totalProducts = data.length;
  const totalUnits = data.reduce((sum, p) => sum + (p.quantity || 0), 0);
  const totalValue = data.reduce((sum, p) => sum + (p.quantity || 0) * (Number(p.price) || 0), 0);
  const outOfStock = data.filter((p) => !p.in_stock || (p.quantity || 0) === 0);
  const lowStock = data.filter(
    (p) => (p.quantity || 0) > 0 && (p.quantity || 0) <= LOW_STOCK_THRESHOLD
  );

  return { totalProducts, totalUnits, totalValue, outOfStock, lowStock, products: data };
}

// Применяет одно действие от ИИ-парсера. Возвращает результат и снимок «до» —
// он нужен, чтобы пользователь мог откатить неверно распознанное изменение.
async function applyStockAction(action) {
  const { type, name, quantity } = action;
  const existing = await findProductByName(name);

  if (type === 'query') {
    return { action: existing ? 'query' : 'not_found', product: existing, name };
  }

  if (type === 'delete') {
    if (!existing) return { action: 'not_found', name };
    await deleteProduct(existing.id);
    return { action: 'deleted', product: existing, before: existing };
  }

  if (type === 'update') {
    if (!existing) return { action: 'not_found', name };

    const patch = {};
    if (action.new_name) patch.name = action.new_name;
    if (action.price !== undefined && action.price !== null && !Number.isNaN(Number(action.price))) {
      patch.price = Number(action.price);
    }
    if (
      action.set_quantity !== undefined &&
      action.set_quantity !== null &&
      !Number.isNaN(Number(action.set_quantity))
    ) {
      patch.quantity = Math.max(0, Number(action.set_quantity));
      patch.in_stock = patch.quantity > 0;
    }
    if (Object.keys(patch).length === 0) return { action: 'ignored', name };

    const updated = await updateProductById(existing.id, patch);
    return { action: 'updated', product: updated, before: existing };
  }

  if (type === 'restock') {
    const addQty = Math.max(0, Number(quantity) || 0);
    if (existing) {
      const newQty = (existing.quantity || 0) + addQty;
      const patch = { quantity: newQty, in_stock: newQty > 0 };
      if (action.price !== undefined && action.price !== null && !Number.isNaN(Number(action.price))) {
        patch.price = Number(action.price);
      }
      const updated = await updateProductById(existing.id, patch);
      return { action: 'updated', product: updated, before: existing };
    }
    const created = await addProduct({ name, quantity: addQty, price: action.price ?? null });
    return { action: 'created', product: created };
  }

  if (type === 'sale') {
    if (!existing) return { action: 'not_found', name };
    const subQty = Math.max(0, Number(quantity) || 0);
    const newQty = Math.max(0, (existing.quantity || 0) - subQty);
    const updated = await updateProductById(existing.id, { quantity: newQty, in_stock: newQty > 0 });
    return { action: 'updated', product: updated, before: existing };
  }

  if (type === 'out_of_stock') {
    if (!existing) return { action: 'not_found', name };
    const updated = await updateProductById(existing.id, { quantity: 0, in_stock: false });
    return { action: 'updated', product: updated, before: existing };
  }

  return { action: 'ignored', name };
}

/* ---------------- записи клиентов (режим салона) ---------------- */

// Активная запись — та, которую ещё не отменили и по которой клиент не пришёл.
// Статусы держим строками, а не булевыми флагами: «отменена» и «пришёл» —
// разные вещи, и владельцу в истории важно видеть, чем закончилось.
const APPOINTMENT_STATUSES = ['active', 'done', 'cancelled'];

async function createAppointment({
  clientName,
  phone,
  chatId,
  service,
  master,
  startsAt,
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
      status: 'active',
      source,
      note: note || null,
    })
    .select()
    .single();

  if (error) throw error;
  return data;
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

// Занято ли время. Если мастера в салоне не заведены, считаем занятым любое
// пересечение: у одного кресла не может быть двух клиентов одновременно.
async function findBusyAppointment(startsAt, { master, durationMinutes = 60 } = {}) {
  const start = new Date(startsAt);
  const from = new Date(start.getTime() - (durationMinutes - 1) * 60 * 1000);
  const to = new Date(start.getTime() + (durationMinutes - 1) * 60 * 1000);

  let query = supabase
    .from('appointments')
    .select('*')
    .eq('status', 'active')
    .gte('starts_at', from.toISOString())
    .lte('starts_at', to.toISOString());

  if (master) query = query.eq('master', master);

  const { data, error } = await query.limit(1);
  if (error) throw error;
  return data?.[0] || null;
}

module.exports = {
  LOW_STOCK_THRESHOLD,
  createAppointment,
  listAppointments,
  getAppointment,
  setAppointmentStatus,
  findClientAppointments,
  findBusyAppointment,
  addProduct,
  listProducts,
  deleteProduct,
  getProduct,
  getProductNames,
  searchProducts,
  findProductByName,
  applyStockAction,
  restoreProduct,
  getStockSummary,
};
