// Player accounts (Supabase): sign in, claim your player, roast everyone else.
// The "not your own bio/photo" rule is enforced by row-level security in
// supabase/schema.sql; the UI just mirrors it.
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

const SDK = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/+esm';

export const acct = {
  enabled: !!(SUPABASE_URL && SUPABASE_ANON_KEY),
  client: null,
  user: null,      // auth user
  me: null,        // claimed player letter
  claimed: {},     // player letter -> true
  profiles: {},    // player letter -> { bio, photo, bio_by, photo_by, updated_at }
  ready: false,
};

let onChange = () => {};

export async function initAccounts(cb) {
  onChange = cb;
  if (!acct.enabled) { acct.ready = true; return; }
  const { createClient } = await import(SDK);
  acct.client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, storageKey: 'theboard.auth' },
  });
  const { data } = await acct.client.auth.getSession();
  acct.user = data.session?.user ?? null;
  await refresh();
  acct.client.auth.onAuthStateChange((_evt, session) => {
    const changed = (session?.user?.id ?? null) !== (acct.user?.id ?? null);
    acct.user = session?.user ?? null;
    if (changed) refresh().then(onChange);
  });
}

export async function refresh() {
  acct.me = null; acct.claimed = {}; acct.profiles = {};
  if (acct.user) {
    const members = await acct.client.from('members').select('user_id, player_id');
    for (const m of members.data || []) {
      acct.claimed[m.player_id] = true;
      if (m.user_id === acct.user.id) acct.me = m.player_id;
    }
    if (acct.me) {
      const profs = await acct.client.from('profiles').select('*');
      for (const p of profs.data || []) acct.profiles[p.player_id] = p;
    }
  }
  acct.ready = true;
}

const fail = (error) => { if (error) throw new Error(error.message); };

export async function signIn(email, password) {
  const { error } = await acct.client.auth.signInWithPassword({ email, password });
  fail(error);
}

export async function signUp(email, password) {
  const { data, error } = await acct.client.auth.signUp({
    email, password, options: { emailRedirectTo: location.origin + location.pathname + '#/account' },
  });
  fail(error);
  return { needsConfirm: !data.session };
}

export async function signOut() {
  await acct.client.auth.signOut();
  acct.user = null;
  await refresh();
}

export async function claim(playerId, code) {
  const { error } = await acct.client.rpc('claim_player', { p_player: playerId, p_code: code });
  fail(error);
  await refresh();
}

export const canEdit = (playerId) => acct.enabled && !!acct.me && acct.me !== playerId;

async function upsert(playerId, fields) {
  const { data, error } = await acct.client.from('profiles')
    .upsert({ player_id: playerId, ...fields }, { onConflict: 'player_id' })
    .select().single();
  fail(error);
  acct.profiles[playerId] = data;
}

export const saveBio = (playerId, bio) => upsert(playerId, { bio: bio.trim() || null });
export const savePhoto = (playerId, photo) => upsert(playerId, { photo });

// Center-crop to a square and shrink to a small JPEG data URL.
export function imageToDataURL(file, size = 360, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const s = Math.min(img.naturalWidth, img.naturalHeight);
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      canvas.getContext('2d').drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s, 0, 0, size, size);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Couldn't read that image")); };
    img.src = url;
  });
}
