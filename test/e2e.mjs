// End-to-end smoke test + screenshot capture.
// Drives two players and a spectator against a running server, plays the
// Scholar's Mate, and writes screenshots into docs/screenshots/.
import puppeteer from 'puppeteer';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SHOTS = join(__dirname, '..', 'docs', 'screenshots');
const PORT = process.env.PORT || 3199;
const BASE = `http://localhost:${PORT}`;
const ROOM = 'demo';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Boot a fresh server so the test never collides with stale room state.
function startServer() {
  const proc = spawn('node', [join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore',
  });
  return proc;
}

async function waitForServer(timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(BASE);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error('Server did not start in time');
}

async function joinAs(browser, name, role) {
  // Each participant gets an isolated context so they have their own
  // localStorage/token — exactly like separate machines on the LAN.
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 1280, height: 860, deviceScaleFactor: 1 });
  await page.goto(`${BASE}/?room=${ROOM}`, { waitUntil: 'networkidle0' });
  await page.type('#name-input', name);
  await page.evaluate((r) => {
    document.querySelectorAll('.role-btn').forEach((b) => b.classList.remove('active'));
    const btn = [...document.querySelectorAll('.role-btn')].find((b) => b.dataset.role === r);
    btn.classList.add('active');
    btn.click();
  }, role);
  await page.click('#enter-btn');
  await page.waitForSelector('#game-screen:not(.hidden)');
  await sleep(300);
  return page;
}

async function move(page, from, to) {
  await page.click(`.square[data-square="${from}"]`);
  await sleep(120);
  await page.click(`.square[data-square="${to}"]`);
  await sleep(250);
}

async function shot(page, name) {
  await page.screenshot({ path: join(SHOTS, name) });
  console.log('  📸', name);
}

(async () => {
  const server = startServer();
  let browser;
  let failed = false;
  try {
    await waitForServer();
    browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
    // --- Join screen screenshot (fresh page) ---
    const intro = await browser.newPage();
    await intro.setViewport({ width: 1280, height: 860 });
    await intro.goto(`${BASE}/?room=${ROOM}`, { waitUntil: 'networkidle0' });
    await intro.type('#name-input', 'Alice');
    await shot(intro, '1-join.png');
    await intro.close();

    // --- Seat two players + a spectator ---
    const white = await joinAs(browser, 'Alice', 'player');
    const black = await joinAs(browser, 'Bob', 'player');
    const spec = await joinAs(browser, 'Cara', 'spectator');

    // Verify role assignment in the UI.
    const whiteBadge = await white.$eval('#role-badge', (e) => e.textContent);
    const blackBadge = await black.$eval('#role-badge', (e) => e.textContent);
    const specBadge = await spec.$eval('#role-badge', (e) => e.textContent);
    console.log('  roles:', { whiteBadge, blackBadge, specBadge });
    if (!/White/.test(whiteBadge) || !/Black/.test(blackBadge) || !/Spectator/.test(specBadge)) {
      throw new Error('Role assignment in UI is wrong');
    }

    // --- Play the Scholar's Mate (white wins) ---
    await move(white, 'e2', 'e4');
    await move(black, 'e7', 'e5');
    await move(white, 'f1', 'c4');
    await move(black, 'b8', 'c6');
    await move(white, 'd1', 'h5');
    await move(black, 'g8', 'f6'); // blunder
    await sleep(300);

    // Mid-game screenshots from white's and spectator's perspective.
    await shot(white, '2-game-white.png');
    await shot(spec, '3-spectator.png');

    // Send a chat message from the spectator.
    await spec.type('#chat-input', 'Watch the queen! 👀');
    await spec.keyboard.press('Enter');
    await sleep(300);

    // Deliver mate: Qxf7#
    await move(white, 'h5', 'f7');
    await sleep(500);

    const banner = await white.$eval('#board-banner', (e) => e.textContent);
    console.log('  banner:', banner.replace(/\s+/g, ' ').trim());
    if (!/Checkmate/i.test(banner)) throw new Error('Expected checkmate banner');

    await shot(white, '4-checkmate.png');

    // Spectator should also see the move list populated.
    const specMoves = await spec.$$eval('#move-list li', (els) => els.length);
    if (specMoves < 4) throw new Error('Spectator did not receive move history');

    console.log('\n✅ E2E passed: roles, live sync, spectator view, chat, checkmate.');
  } catch (err) {
    failed = true;
    console.error('\n❌ E2E failed:', err.message);
  } finally {
    if (browser) await browser.close();
    server.kill();
  }
  process.exit(failed ? 1 : 0);
})();
