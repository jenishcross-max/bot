-- Схема базы салона. Выполните в Supabase: Project -> SQL Editor -> New query.
-- Если база уже заведена по старой версии — выполните supabase_salon_step1.sql,
-- он дополняет её, ничего не удаляя.

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
  created_at timestamptz not null default now()
);

alter table appointments add column if not exists duration_minutes integer;

create index if not exists appointments_starts_at_idx on appointments (starts_at);
create index if not exists appointments_status_idx on appointments (status, starts_at);
create index if not exists appointments_phone_idx on appointments (phone);

alter table appointments disable row level security;
