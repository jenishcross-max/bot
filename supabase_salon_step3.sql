-- Этап III. Напоминания клиентам. Выполните один раз: SQL Editor → New query → Run.
--
-- Скрипт добавляет записям одну колонку — отметку «напоминание отправлено».
-- Ничего не удаляет и ничего не переписывает.
--
-- Зачем отметка в базе, а не в памяти бота: бесплатный Render перезапускает
-- сервис по нескольку раз в сутки. Держи мы список отправленных напоминаний в
-- памяти, после каждого перезапуска клиенты получали бы их заново — а это
-- ровно тот случай, когда забота превращается в спам и номер салона
-- блокируют.
alter table appointments add column if not exists reminded_at timestamptz;

-- Выборка «кому ещё не напомнили» идёт по трём полям сразу.
create index if not exists appointments_reminder_idx
  on appointments (status, starts_at)
  where reminded_at is null;

-- Проверка: должно вернуть одну строку — reminded_at.
select column_name, data_type from information_schema.columns
where table_schema = 'public'
  and table_name = 'appointments'
  and column_name = 'reminded_at';
