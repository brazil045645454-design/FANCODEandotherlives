// Extractor. Only reads publicly served HTML/JSON/text. Returns one .m3u8 URL.
// Env: SOURCE_URL (page/API to fetch), SOURCE_MATCH (optional substring to pick one URL).

async function readText(res, max) {
  const rd = res.body.getReader();
  const parts = [];
  let n = 0;
  while (n < max) {
    const { done, value } = await rd.read();
    if (done) break;
    parts.push(value);
    n += value.length;
  }
  rd.cancel().catch(() => {});
  return Buffer.concat(parts).toString('utf8').slice(0, max);
}

function candidates(text) {
  // Undo JSON/HTML escaping of the *page* so the URL is extracted as the site intended.
  const t = text.replace(/\\u0026/g, '&').replace(/\\\//g, '/').replace(/&amp;/g, '&');
  return [...new Set(t.match(/https?:\/\/[^\s"'<>\\]+?\.m3u8[^\s"'<>\\]*/g) || [])];
}

async function getStreamUrl() {
  const src = (process.env.SOURCE_URL || '').trim();
  const match = (process.env.SOURCE_MATCH || '').trim();
  if (!src) throw new Error('SOURCE_URL not set');
  const res = await fetch(src, {
    signal: AbortSignal.timeout(10000),
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; stremio-live-manager)' }
  });
  if (!res.ok) throw new Error('source HTTP ' + res.status);
  let list = candidates(await readText(res, 2e6));
  if (match) list = list.filter((u) => u.includes(match));
  if (!list.length) throw new Error('no .m3u8 URL found in source');
  if (list.length > 1) throw new Error(list.length + ' .m3u8 URLs found; set SOURCE_MATCH');
  return list[0];
}

module.exports = { getStreamUrl, readText };
