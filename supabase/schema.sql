-- THE BOARD: accounts, bios, photos.
-- Run once in Supabase → SQL Editor. Safe to re-run.
--
-- Rules enforced by the database (not just the website):
--   * Only signed-in league members can read bios/photos.
--   * You can edit anyone's bio and photo EXCEPT your own.
--   * Every change is kept in profile_history.

-- Players who exist on the board (letters match the site).
create table if not exists public.players (
  id text primary key,
  name text not null
);
insert into public.players (id, name) values
  ('A', 'Alec'), ('D', 'Dirk'), ('K', 'Keval'), ('M', 'Mark'), ('P', 'Pat'), ('R', 'Ryan'), ('T', 'Tyler')
on conflict (id) do nothing;

-- Which account is which player. One account per player, one player per account.
create table if not exists public.members (
  user_id uuid primary key references auth.users on delete cascade,
  player_id text not null unique references public.players,
  created_at timestamptz not null default now()
);

-- Code needed to claim a player (the league password). No policies = nobody can read it.
create table if not exists public.league_secrets (code text not null);

create table if not exists public.profiles (
  player_id text primary key references public.players,
  bio text check (char_length(bio) <= 1500),
  photo text check (char_length(photo) <= 500000), -- small JPEG as a data URL
  bio_by text references public.players,
  photo_by text references public.players,
  updated_at timestamptz not null default now()
);

create table if not exists public.profile_history (
  id bigint generated always as identity primary key,
  player_id text not null,
  bio text,
  photo text,
  bio_by text,
  photo_by text,
  replaced_at timestamptz not null default now()
);

alter table public.players enable row level security;
alter table public.members enable row level security;
alter table public.league_secrets enable row level security;
alter table public.profiles enable row level security;
alter table public.profile_history enable row level security;

-- The signed-in user's player letter, or null.
create or replace function public.my_player() returns text
language sql stable security definer set search_path = public as $$
  select player_id from public.members where user_id = auth.uid()
$$;

drop policy if exists "members read players" on public.players;
create policy "members read players" on public.players for select to authenticated using (true);

drop policy if exists "members read members" on public.members;
create policy "members read members" on public.members for select to authenticated using (true);

drop policy if exists "members read profiles" on public.profiles;
create policy "members read profiles" on public.profiles for select to authenticated
  using (public.my_player() is not null);

drop policy if exists "roast others: insert" on public.profiles;
create policy "roast others: insert" on public.profiles for insert to authenticated
  with check (public.my_player() is not null and player_id <> public.my_player());

drop policy if exists "roast others: update" on public.profiles;
create policy "roast others: update" on public.profiles for update to authenticated
  using (public.my_player() is not null and player_id <> public.my_player())
  with check (public.my_player() is not null and player_id <> public.my_player());

drop policy if exists "members read history" on public.profile_history;
create policy "members read history" on public.profile_history for select to authenticated
  using (public.my_player() is not null);

-- Stamp who changed what, and archive the previous version.
create or replace function public.profiles_stamp() returns trigger
language plpgsql security definer set search_path = public as $$
declare me text := public.my_player();
begin
  new.updated_at := now();
  if tg_op = 'INSERT' then
    if new.bio is not null then new.bio_by := me; end if;
    if new.photo is not null then new.photo_by := me; end if;
    return new;
  end if;
  if new.bio is distinct from old.bio then new.bio_by := me; else new.bio_by := old.bio_by; end if;
  if new.photo is distinct from old.photo then new.photo_by := me; else new.photo_by := old.photo_by; end if;
  insert into public.profile_history (player_id, bio, photo, bio_by, photo_by)
    values (old.player_id, old.bio, old.photo, old.bio_by, old.photo_by);
  return new;
end $$;

drop trigger if exists profiles_stamp on public.profiles;
create trigger profiles_stamp before insert or update on public.profiles
  for each row execute function public.profiles_stamp();

-- Claim a player with the league code. Called from the site after signing up.
create or replace function public.claim_player(p_player text, p_code text) returns text
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  if not exists (select 1 from public.league_secrets where code = p_code) then
    raise exception 'Wrong league password';
  end if;
  if exists (select 1 from public.members where user_id = auth.uid()) then
    raise exception 'This account already has a player';
  end if;
  if exists (select 1 from public.members where player_id = p_player) then
    raise exception 'Someone already claimed that player. Tell the commissioner if it wasn''t you.';
  end if;
  insert into public.members (user_id, player_id) values (auth.uid(), p_player);
  return p_player;
end $$;

revoke all on function public.claim_player(text, text) from anon;
grant execute on function public.claim_player(text, text) to authenticated;
