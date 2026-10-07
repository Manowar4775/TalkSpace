// Public browser configuration only.
// NEVER put a Supabase service_role/secret key or SMTP secret here.

window.SUPABASE_CONFIG = {
  url: "https://tofdqdwyoqkrixbnhwwv.supabase.co",
  anonKey: "sb_publishable_m7lBEQM41LHhzJMoJcjpSQ_G--Un4h7",

  // This must be the REAL Cloudflare Turnstile sitekey paired with
  // the Turnstile secret configured in Supabase Auth.
  // Do not replace this with Cloudflare's test key in production.
  turnstileSiteKey: "0x4AAAAAAFKz_0krKmaCJIF_"
};
