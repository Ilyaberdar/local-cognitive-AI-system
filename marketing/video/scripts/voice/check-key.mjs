// Checks the ElevenLabs key in .env without spending credits: the plan and its character quota, and
// whether the key may list voices. Never prints the key.
//   node --env-file=.env scripts/voice/check-key.mjs
const key = process.env.ELEVENLABS_API_KEY;
if (!key) { console.error("ELEVENLABS_API_KEY is not set in .env"); process.exit(1); }
const get = async path => {
  const response = await fetch(`https://api.elevenlabs.io${path}`, { headers: { "xi-api-key": key } });
  return { status: response.status, body: response.ok ? await response.json() : (await response.text()).slice(0, 200) };
};
const subscription = await get("/v1/user/subscription");
if (subscription.status === 200) {
  const s = subscription.body;
  console.log(JSON.stringify({ tier: s.tier, status: s.status, characters: `${s.character_count} / ${s.character_limit}`, resetsAt: s.next_character_count_reset_unix ? new Date(s.next_character_count_reset_unix * 1000).toISOString() : null }));
} else {
  console.log(`subscription: HTTP ${subscription.status} ${typeof subscription.body === "string" ? subscription.body : ""}`);
}
const voices = await get("/v1/voices");
console.log(voices.status === 200 ? `voices: ${voices.body.voices.length} available to this account` : `voices: HTTP ${voices.status} ${voices.body}`);
