-- Этап II. Мастера переезжают в базу. Выполните один раз: SQL Editor → New query → Run.
--
-- Скрипт ничего не удаляет и ничего не переписывает. Он делает копию записей,
-- заводит три новые таблицы и добавляет записям ссылку на мастера. Заполнит
-- справочник и свяжет с ним старые записи сам бот при первом запуске.

-- 1. Резервная копия записей — ДО любых изменений.
--    Дальше бот будет проставлять записям master_id, и это первое изменение,
--    которое трогает уже существующие строки. Если что-то пойдёт не так,
--    записи целы в appointments_backup — таблицу можно посмотреть глазами
--    (select * from appointments_backup) и восстановить из неё что угодно.
create table if not exists appointments_backup as select * from appointments;

-- 2. Мастера.
create table if not exists masters (
  id bigint generated always as identity primary key,
  name text not null,
  -- Уволившегося мастера бот прячет, а не удаляет: его имя стоит в прошлых
  -- записях, и удаление стёрло бы историю клиента.
  active boolean not null default true,
  -- Рабочие дни недели строкой: 1 — понедельник, ... 7 — воскресенье.
  -- Отдельные отгулы и отпуск — ниже, в master_days_off.
  work_days text not null default '1,2,3,4,5,6,7',
  created_at timestamptz not null default now()
);

-- 3. Какие услуги делает мастер.
--    Пусто у мастера = делает всё. Салон, который ещё не расписал, кто что
--    умеет, не должен из-за этого перестать записывать клиентов.
create table if not exists master_services (
  master_id bigint not null references masters(id) on delete cascade,
  service_id bigint not null references products(id) on delete cascade,
  primary key (master_id, service_id)
);

-- 4. Выходные конкретными датами: отпуск, отгул, «завтра не выйдет».
create table if not exists master_days_off (
  master_id bigint not null references masters(id) on delete cascade,
  day date not null,
  primary key (master_id, day)
);

-- 5. Ссылка записи на мастера.
--    Колонку master (имя строкой) оставляем на месте: по ней бот работал до
--    сих пор, и в старых записях лежит именно она. Имя в записи и мастера в
--    справочнике свяжет сам бот — увидит незнакомое имя, заведёт мастера и
--    сразу пометит его скрытым, чтобы новые записи к нему не шли.
alter table appointments add column if not exists master_id bigint references masters(id);

create index if not exists appointments_master_id_idx on appointments (master_id);
create index if not exists master_days_off_day_idx on master_days_off (day);

-- Ключ служебный и лежит только на сервере, а писать в эти таблицы должны и
-- админ-бот, и WhatsApp-бот. Без этого база молча отклонит любую вставку.
alter table masters disable row level security;
alter table master_services disable row level security;
alter table master_days_off disable row level security;

-- Проверка: должно вернуть четыре строки.
select table_name from information_schema.tables
where table_schema = 'public'
  and table_name in ('masters', 'master_services', 'master_days_off', 'appointments_backup')
order by table_name;
