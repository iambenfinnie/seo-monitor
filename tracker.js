require('dotenv').config();
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const KEYWORDS_FILE = path.join(__dirname, 'keywords.json');
const HISTORY_FILE = path.join(__dirname, 'rank-history.json');
const SCREENSHOTS_DIR = path.join(__dirname, 'screenshots');

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const RESULTS_TO_CHECK = 30; // check top 30 results per keyword
const DELAY_MS = 3000; // delay between searches to avoid rate limiting

function loadHistory() {
  if (!fs.existsSync(HISTORY_FILE)) return {};
  return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
}

function saveHistory(history) {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
}

function today() {
  return new Date().toISOString().split('T')[0];
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function searchGoogle(browser, keyword, targetSite) {
  const page = await browser.newPage();
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
  await page.setViewportSize({ width: 1280, height: 900 });

  const query = encodeURIComponent(keyword);
  const url = `https://www.google.com/search?q=${query}&num=${RESULTS_TO_CHECK}&hl=en&gl=us`;

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(1500);

    // Extract organic result URLs
    const results = await page.evaluate(() => {
      const anchors = Array.from(document.querySelectorAll('div.g a[href^="http"], div[data-sokoban-container] a[href^="http"]'));
      return anchors
        .map(a => a.href)
        .filter(href => !href.includes('google.com') && !href.includes('youtube.com'))
        .slice(0, 30);
    });

    // Find position of target site
    const position = results.findIndex(url => url.includes(targetSite));
    const rank = position === -1 ? null : position + 1;

    // Find which competitors appear and at what rank
    const competitorRanks = {};
    results.forEach((url, i) => {
      const domain = new URL(url).hostname.replace('www.', '');
      if (!competitorRanks[domain]) competitorRanks[domain] = i + 1;
    });

    await page.close();
    return { rank, competitors: competitorRanks, resultsChecked: results.length };
  } catch (err) {
    await page.close();
    return { rank: null, competitors: {}, error: err.message };
  }
}

async function screenshotCompetitor(browser, domain, screenshotsDir) {
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1280, height: 900 });
  const file = path.join(screenshotsDir, `${domain.replace(/\./g, '_')}.png`);
  try {
    await page.goto(`https://${domain}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await sleep(1000);
    await page.screenshot({ path: file, fullPage: false });
  } catch (err) {
    // skip if site unreachable
  }
  await page.close();
  return file;
}

async function run() {
  const config = JSON.parse(fs.readFileSync(KEYWORDS_FILE, 'utf8'));
  const history = loadHistory();
  const date = today();

  if (!fs.existsSync(SCREENSHOTS_DIR)) fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  const todayScreenshots = path.join(SCREENSHOTS_DIR, date);
  if (!fs.existsSync(todayScreenshots)) fs.mkdirSync(todayScreenshots, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const results = {};

  for (const client of config.clients) {
    console.log(`\n=== ${client.name} ===`);
    results[client.site] = { keywords: {}, screenshots: [] };

    for (const keyword of client.keywords) {
      console.log(`  Checking: "${keyword}"`);
      const result = await searchGoogle(browser, keyword, client.site);
      const prev = history[client.site]?.[keyword]?.rank ?? null;
      const change = result.rank !== null && prev !== null ? prev - result.rank : null;

      results[client.site].keywords[keyword] = {
        rank: result.rank,
        previousRank: prev,
        change,
        competitors: result.competitors,
        checkedAt: new Date().toISOString()
      };

      const rankStr = result.rank ? `#${result.rank}` : 'Not in top 30';
      const changeStr = change !== null ? (change > 0 ? `▲${change}` : change < 0 ? `▼${Math.abs(change)}` : '—') : 'new';
      console.log(`    ${rankStr} ${changeStr}`);

      await sleep(DELAY_MS);
    }

    // Weekly competitor screenshots (Mondays only, or forced via env)
    const isMonday = new Date().getDay() === 1;
    if (isMonday || process.env.FORCE_SCREENSHOTS === 'true') {
      console.log(`  Taking competitor screenshots...`);
      for (const competitor of client.competitors) {
        const file = await screenshotCompetitor(browser, competitor, todayScreenshots);
        results[client.site].screenshots.push({ domain: competitor, file });
        console.log(`    Screenshotted: ${competitor}`);
        await sleep(1000);
      }
    }
  }

  await browser.close();

  // Merge into history
  for (const [site, data] of Object.entries(results)) {
    if (!history[site]) history[site] = {};
    for (const [keyword, result] of Object.entries(data.keywords)) {
      history[site][keyword] = { rank: result.rank, date };
    }
  }
  saveHistory(history);

  // Save today's snapshot
  const snapshotFile = path.join(__dirname, `snapshot-${date}.json`);
  fs.writeFileSync(snapshotFile, JSON.stringify(results, null, 2));
  console.log(`\nSnapshot saved: ${snapshotFile}`);

  return results;
}

run().catch(console.error);
