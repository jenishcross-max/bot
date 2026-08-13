-- Выполните этот SQL в Supabase: Project -> SQL Editor -> New query

create table if not exists products (
  id bigint generated always as identity primary key,
  name text not null,
  price numeric,
  description text,
  photo_url text,
  category text,
  quantity integer not null default 0,
  in_stock boolean not null default true,
  created_at timestamptz not null default now()
);

-- Если таблица уже существовала без поля quantity — добавит его.
alter table products add column if not exists quantity integer not null default 0;

create index if not exists products_name_idx on products using gin (to_tsvector('russian', name));
create index if not exists products_description_idx on products using gin (to_tsvector('russian', coalesce(description, '')));

-- Отключаем RLS: используется публичный (publishable) ключ, писать в таблицу должны
-- и админ-бот (Telegram), и WhatsApp-бот. Т.к. ключ и так не передаётся конечным пользователям
-- напрямую, а таблица не хранит чувствительные данные, это приемлемо для MVP.
alter table products disable row level security;
