const fs = require('node:fs');
const path = require('node:path');
const RankData = require('./dashboard/rank-data');

const RESULTS_TO_CHECK = 30;
const DELAY_MS = 3000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const today = () => new Date().toISOString().slice(0, 10);
const failure = (code, message) => ({status: 'error', rank: null, competitors: {}, resultsChecked: 0, error: {code, message}});

function normalizeHost(value) {
  return new URL(value.includes('://') ? value : `https://${value}`).hostname.toLowerCase().replace(/^www\./, '');
}
function matchesSite(url, site) {
  const host = normalizeHost(url), target = normalizeHost(site);
  return host === target || host.endsWith(`.${target}`);
}
function classifyResults(urls, targetSite) {
  const results = [];
  const seen = new Set();
  for (const href of urls) {
    try {
      const url = new URL(href);
      if (!['http:', 'https:'].includes(url.protocol)) continue;
      const host = normalizeHost(url.href);
      if (host === 'google.com' || host.endsWith('.google.com')) continue;
      url.hash = '';
      if (seen.has(url.href)) continue;
      seen.add(url.href);
      results.push(url.href);
    } catch { /* Invalid links cannot be rank observations. */ }
    if (results.length === RESULTS_TO_CHECK) break;
  }
  if (!results.length) return failure('no_organic_results', 'No organic result links were extracted. Ranking is unknown.');
  const position = results.findIndex(url => matchesSite(url, targetSite));
  const competitors = {};
  results.forEach((url, i) => { const host = normalizeHost(url); if (!matchesSite(url, targetSite) && !Object.hasOwn(competitors, host)) competitors[host] = i + 1; });
  return {status: 'ok', rank: position < 0 ? null : position + 1, competitors,
    resultsChecked: results.length, organicResults: results, error: null};
}

function extractGooglePage() {
      const blocked = location.pathname.startsWith('/sorry') || Boolean(document.querySelector('#captcha-form, .g-recaptcha, iframe[src*="recaptcha"]'));
      const consent = location.hostname === 'consent.google.com' || Boolean(document.querySelector('form[action*="consent.google"]'));
      const links = Array.from(document.querySelectorAll('#search a:has(h3), #rso a:has(h3)'))
        .filter(a => !a.closest('#tads, #bottomads, [data-text-ad], [data-pla]'))
        .map(a => a.href);
      return {blocked, consent, links};
}

async function searchGoogle(browser, keyword, targetSite, wait = sleep) {
  let page;
  try {
    page = await browser.newPage();
    await page.setExtraHTTPHeaders({'Accept-Language':'en-US,en;q=0.9'});
    await page.setViewportSize({width:1280,height:900});
    const response = await page.goto(`https://www.google.com/search?q=${encodeURIComponent(keyword)}&num=${RESULTS_TO_CHECK}&hl=en&gl=us`,
      {waitUntil:'domcontentloaded',timeout:30000});
    if (!response || response.status() >= 400) return {...failure('http_error', `Search returned HTTP ${response ? response.status() : 'unknown'}.`), httpStatus: response?.status() || null};
    await wait(1500);
    const observation = await page.evaluate(extractGooglePage);
    if (observation.blocked) return failure('blocked', 'Google returned a challenge. No ranking was measured.');
    if (observation.consent) return failure('consent_required', 'Google returned a consent page. No ranking was measured.');
    return classifyResults(observation.links, targetSite);
  } catch (err) {
    return failure('request_failed', String(err.message).slice(0, 500));
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

async function screenshotCompetitor(browser, domain, screenshotsDir, wait = sleep) {
  let page;
  const file = path.join(screenshotsDir, `${domain.replace(/\./g,'_')}.png`);
  try {
    page = await browser.newPage();
    await page.setViewportSize({width:1280,height:900});
    const response = await page.goto(`https://${domain}`, {waitUntil:'domcontentloaded',timeout:20000});
    if (!response || response.status() >= 400) return null;
    await wait(1000);
    await page.screenshot({path:file,fullPage:false});
    return file;
  } catch { return null; }
  finally { if (page) await page.close().catch(() => {}); }
}

async function collect(options = {}) {
  const rootDir = options.rootDir || __dirname;
  const now = options.now || (() => new Date());
  const wait = options.wait || sleep;
  const startedAt = now().toISOString();
  const date = startedAt.slice(0,10);
  const config = JSON.parse(fs.readFileSync(path.join(rootDir,'keywords.json'),'utf8'));
  if (!Array.isArray(config.clients) || !config.clients.length || config.clients.some(c => !c.site || !Array.isArray(c.keywords) || !c.keywords.length)) {
    throw new Error('No valid configured keyword set. Refusing to report success.');
  }
  const historyFile = path.join(rootDir,'rank-history.json');
  const history = fs.existsSync(historyFile) ? JSON.parse(fs.readFileSync(historyFile,'utf8')) : {};
  const screenshotDir = path.join(rootDir,'screenshots',date);
  fs.mkdirSync(screenshotDir,{recursive:true});
  const results = {};
  let browser, launchError, stoppedReason;
  try { browser = await (options.launch || (() => require('playwright').chromium.launch({headless:true})))(); }
  catch (err) { launchError = failure('browser_launch_failed', String(err.message).slice(0,500)); }
  try {
    for (const client of config.clients) {
      results[client.site] = {keywords:{},screenshots:[]};
      for (const keyword of client.keywords) {
        const skipped = Boolean(stoppedReason);
        const result = skipped
          ? {...failure('collection_stopped', `Not attempted: ${stoppedReason} Remaining Google queries were stopped; no ranking was measured.`), status:'skipped'}
          : launchError || await searchGoogle(browser,keyword,client.site,wait);
        if (!skipped && (['blocked','consent_required'].includes(result.error?.code) || [403,429].includes(result.httpStatus))) {
          stoppedReason = result.error.message;
        }
        const previous = history[client.site]?.[keyword];
        const prev = RankData.valid(previous) ? previous.rank : null;
        const valid = RankData.valid(result);
        results[client.site].keywords[keyword] = {...result,previousRank:prev,
          previousCheckedAt:RankData.valid(previous) ? previous.checkedAt : null,
          change:valid && result.rank !== null && prev !== null ? prev-result.rank : null,
          checkedAt:skipped || launchError ? null : now().toISOString(), recordedAt:now().toISOString(), attempted:!skipped && !launchError, source:'google', country:'us', language:'en', device:'desktop',
          cityTargeting:null, requestedResultLimit:RESULTS_TO_CHECK};
        console.log(`${client.site} | ${keyword} | ${RankData.label(result)}${result.error ? `: ${result.error.code}` : ''}`);
        if (browser && !stoppedReason) await wait(DELAY_MS);
      }
      if (browser && (now().getUTCDay() === 1 || process.env.FORCE_SCREENSHOTS === 'true')) {
        for (const domain of client.competitors || []) {
          const file = await screenshotCompetitor(browser,domain,screenshotDir,wait);
          if (file) results[client.site].screenshots.push({domain,file});
          await wait(1000);
        }
      }
    }
  } finally { if (browser) await browser.close().catch(err => console.warn(`Browser cleanup failed: ${err.message}`)); }
  const summary = {...RankData.summarize(results),attemptId:options.attemptId,startedAt,finishedAt:now().toISOString(),date,
    report:{status:'pending',attemptId:options.attemptId,updatedAt:now().toISOString()}};
  fs.writeFileSync(path.join(rootDir,`snapshot-${date}.json`),JSON.stringify(results,null,2));
  fs.writeFileSync(path.join(rootDir,'latest-run.json'),JSON.stringify(summary,null,2));
  const next = RankData.mergeHistory(history,results,date);
  if (summary.successful) fs.writeFileSync(historyFile,JSON.stringify(next,null,2));
  console.log(`Collection ${summary.status}: ${summary.successful}/${summary.total} checks returned usable result links.`);
  return {results,summary};
}

function currentAttempt(env = process.env) {
  return env.GITHUB_RUN_ID ? `${env.GITHUB_RUN_ID}:${env.GITHUB_RUN_ATTEMPT || '1'}` : require('node:crypto').randomUUID();
}
async function run(options = {}) {
  const attemptId = options.attemptId || currentAttempt();
  try { return await collect({...options,attemptId}); }
  catch (err) {
    const rootDir = options.rootDir || __dirname;
    const timestamp = (options.now || (() => new Date()))().toISOString();
    const date = timestamp.slice(0,10);
    // A fatal failure must replace attempt status, never masquerade as an earlier run.
    fs.writeFileSync(path.join(rootDir,`snapshot-${date}.json`),'{}');
    fs.writeFileSync(path.join(rootDir,'latest-run.json'),JSON.stringify({attemptId,date,startedAt:timestamp,finishedAt:timestamp,
      status:'error',successful:0,total:0,failed:0,skipped:0,report:{status:'pending',attemptId,updatedAt:timestamp},error:{code:'collection_failed',message:String(err.message).slice(0,500)}},null,2));
    throw err;
  }
}

if (require.main === module) {
  require('dotenv').config();
  run().then(({summary}) => { if (summary.status !== 'ok') process.exitCode = 1; })
    .catch(err => {console.error(err);process.exitCode = 1;});
}
module.exports = {run,searchGoogle,classifyResults,matchesSite,screenshotCompetitor,extractGooglePage};

