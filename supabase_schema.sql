-- Схема базы салона. Выполните в Supabase: Project -> SQL Editor -> New query.
-- Если база уже заведена по старой версии — выполните supabase_salon_step1.sql,
-- supabase_salon_step2.sql и supabase_salon_step3.sql: они дополняют её,
-- ничего не удаляя.

-- --- Услуги ---
-- Таблица называется products с прежних времён, когда бот вёл ещё и магазин.
-- Переименовывать её на живых данных ради красоты имени не стали; складские
-- колонки (quantity, in_stock, category, photo_url) остались, но код их не
-- трогает: у услуги нет остатка.
create table if not exists products (
  id bigint generated always as identity primary key,
  name text not null,
  price numeric,
  description text,
  -- Сколько минут занимает услуга. Пусто — берётся SALON_SLOT_MINUTES.
  duration_minutes integer,
  photo_url text,
  category text,
  quantity integer not null default 0,
  in_stock boolean not null default true,
  created_at timestamptz not null default now()
);

alter table products add column if not exists duration_minutes integer;

create index if not exists products_name_idx on products using gin (to_tsvector('russian', name));
create index if not exists products_description_idx on products using gin (to_tsvector('russian', coalesce(description, '')));

-- Отключаем RLS: ключ служебный и лежит только на сервере, а писать в таблицу
-- должны и админ-бот (Telegram), и WhatsApp-бот.
alter table products disable row level security;

-- --- Записи клиентов ---

create table if not exists appointments (
  id bigint generated always as identity primary key,
  client_name text not null,
  phone text,
  chat_id text,
  service text,
  master text,
  starts_at timestamptz not null,
  -- Снимок длительности на момент записи: услуга потом удлинится, а вчерашнее
  -- расписание должно остаться таким, каким было.
  duration_minutes integer,
  -- active — предстоит, done — клиент пришёл, no_show — не пришёл,
  -- cancelled — отменена
  status text not null default 'active',
  -- whatsapp — записал бот, telegram — записал владелец руками
  source text not null default 'whatsapp',
  note text,
  -- Ссылка на справочник мастеров (таблица ниже). Имя мастера остаётся строкой
  -- рядом: по нему читают расписание, а ссылка держит запись за человеком, даже
  -- если владелец потом поправит написание имени.
  master_id bigint,
  -- Когда клиенту напомнили о записи. Хранится в базе, а не в памяти бота:
  -- сервис перезапускается по нескольку раз в сутки, и после каждого
  -- перезапуска напоминания уходили бы заново.
  reminded_at timestamptz,
  created_at timestamptz not null default now()
);

alter table appointments add column if not exists duration_minutes integer;
alter table appointments add column if not exists reminded_at timestamptz;

create index if not exists appointments_starts_at_idx on appointments (starts_at);
create index if not exists appointments_status_idx on appointments (status, starts_at);
create index if not exists appointments_phone_idx on appointments (phone);
create index if not exists appointments_reminder_idx
  on appointments (status, starts_at)
  where reminded_at is null;

alter table appointments disable row level security;

-- --- Мастера ---
-- Состав салона правится из Телеграма, а не из настроек сервера. Бот заполняет
-- эту таблицу сам при первом запуске — из SALON_MASTERS и из имён, которые уже
-- стоят в старых записях.

create table if not exists masters (
  id bigint generated always as identity primary key,
  name text not null,
  -- Уволившегося прячем, а не удаляем: его имя стоит в прошлых записях.
  active boolean not null default true,
  -- Рабочие дни недели: 1 — понедельник, ... 7 — воскресенье.
  work_days text not null default '1,2,3,4,5,6,7',
  created_at timestamptz not null default now()
);

-- Какие услуги делает мастер. Пусто у мастера = делает всё.
create table if not exists master_services (
  master_id bigint not null references masters(id) on delete cascade,
  service_id bigint not null references products(id) on delete cascade,
  primary key (master_id, service_id)
);

-- Выходные конкретными датами: отпуск, отгул, «завтра не выйдет».
create table if not exists master_days_off (
  master_id bigint not null references masters(id) on delete cascade,
  day date not null,
  primary key (master_id, day)
);

create index if not exists appointments_master_id_idx on appointments (master_id);
create index if not exists master_days_off_day_idx on master_days_off (day);

alter table masters disable row level security;
alter table master_services disable row level security;
alter table master_days_off disable row level security;
