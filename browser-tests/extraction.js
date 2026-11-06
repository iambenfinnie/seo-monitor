const {test,after,before} = require('node:test');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {extractGooglePage,classifyResults} = require('../tracker');
let browser;
before(async()=>{browser=await chromium.launch({headless:true, executablePath:process.env.PLAYWRIGHT_TEST_EXECUTABLE_PATH || undefined});});
after(async()=>{if(browser)await browser.close();});
async function extract(html) {
  const page=await browser.newPage();
  try {await page.route('**/*', route=>route.abort());await page.setContent(html);return await page.evaluate(extractGooglePage);}
  finally {await page.close();}
}
test('real DOM extraction selects organic titles and excludes ads and sitelinks',async()=>{
  const r=await extract(`<div id="search"><div id="tads"><a href="https://ad.test"><h3>Ad</h3></a></div><div data-text-ad><a href="https://ad2.test"><h3>Ad 2</h3></a></div><div id="rso"><a href="https://one.test/"><h3>First organic</h3></a><a href="https://one.test/sub">Sitelink</a><a href="https://example.com/"><h3>Target</h3></a><a href="https://youtube.com/watch?v=1"><h3>Video result</h3></a></div></div>`);
  assert.deepEqual(r.links,['https://one.test/','https://example.com/','https://youtube.com/watch?v=1']);
  assert.equal(classifyResults(r.links,'example.com').rank,2);assert.equal(r.blocked,false);
});
test('real DOM challenge and consent controls are detected',async()=>{
  assert.equal((await extract('<form id="captcha-form">Human verification</form>')).blocked,true);
  assert.equal((await extract('<iframe src="https://fixture.test/recaptcha"></iframe>')).blocked,true);
  assert.equal((await extract('<form action="https://consent.google.com/save">Consent</form>')).consent,true);
});
test('real DOM with no organic titles fails closed',async()=>{
  const r=await extract('<div id="search"><a href="https://example.com">No organic title</a></div>');
  assert.equal(classifyResults(r.links,'example.com').status,'error');
});

test('dashboard renders collection and email failure with no external network',async()=>{
  const fs=require('node:fs');const path=require('node:path');
  const page=await browser.newPage({viewport:{width:390,height:844}});
  const fixtures={
    'rank-history.json':{},
    'latest-run.json':{attemptId:'fixture:1',date:'2026-11-06',finishedAt:new Date().toISOString(),status:'error',successful:0,total:2,skipped:1,report:{attemptId:'fixture:1',status:'failed',error:{message:'The configured sender domain is not verified in Resend.'}}},
    'snapshot-2026-11-06.json':{'example.com':{keywords:{first:{status:'error',rank:null,resultsChecked:0,error:{message:'Google returned a challenge.'}},second:{status:'skipped',rank:null,resultsChecked:0,error:{message:'Not attempted after challenge.'}}}}}
  };
  try {
    await page.route('**/*',route=>{
      const u=new URL(route.request().url());const name=u.pathname.split('/').at(-1);
      if(u.hostname==='raw.githubusercontent.com' && Object.hasOwn(fixtures,name)) return route.fulfill({status:200,contentType:'application/json',headers:{'access-control-allow-origin':'*'},body:JSON.stringify(fixtures[name])});
      return route.abort();
    });
    await page.setContent(fs.readFileSync(path.join(__dirname,'../dashboard/index.html'),'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,''));
    await page.addScriptTag({path:path.join(__dirname,'../dashboard/rank-data.js')});
    await page.addScriptTag({path:path.join(__dirname,'../dashboard/app.js')});
    await page.getByText('Report not sent:',{exact:false}).waitFor();
    assert.match(await page.locator('#collection-status').innerText(),/0\/2 usable checks; 1 not attempted/);
    assert.match(await page.locator('#app').innerText(),/Not checked/);
    assert.match(await page.locator('#report-status').innerText(),/not verified in Resend/);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true,'mobile page does not overflow horizontally');
  } finally {await page.close();}
});
