const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const {spawnSync} = require('node:child_process');
const {run,searchGoogle,classifyResults,matchesSite} = require('../tracker');
const D = require('../dashboard/rank-data');
const {buildReport} = require('../reporter');
const instant = async()=>{};
const row = (rank=2) => ({status:'ok',rank,resultsChecked:3,error:null,checkedAt:'2026-11-04T12:00:00.000Z'});
const errorRow = {status:'error',rank:null,resultsChecked:0,error:{code:'blocked',message:'Challenge returned'}};
function fakeBrowser({links=['https://example.com/'],blocked=false,consent=false,status=200,throwOnGoto=false}={}) {
  let closed=0;
  return {get closed(){return closed;},close:async()=>{},newPage:async()=>({
    setExtraHTTPHeaders:instant,setViewportSize:instant,
    goto:async()=>{if(throwOnGoto) throw new Error('timeout');return {status:()=>status};},
    evaluate:async()=>({links,blocked,consent}),close:async()=>{closed++;}
  })};
}
function fixture(t,history={'example.com':{keyword:row(2)}}) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'seo-monitor-test-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  fs.writeFileSync(path.join(dir,'keywords.json'),JSON.stringify({clients:[{site:'example.com',name:'Example',keywords:['keyword'],competitors:[]}]}));
  fs.writeFileSync(path.join(dir,'rank-history.json'),JSON.stringify(history));
  return dir;
}
const now=()=>new Date('2026-11-05T12:00:00.000Z');

test('only explicit nonempty measurements are valid',()=>{
  assert.equal(D.valid(row()),true);
  for(const r of [{rank:2},errorRow,{...row(),rank:0},{...row(),rank:4},{...row(),resultsChecked:0},{...row(),error:'failed'}]) assert.equal(D.valid(r),false);
});
test('null is only absence within actual observed results',()=>{
  assert.equal(D.label(row(null)),'Not found among 3 observed results');
  assert.equal(D.label({rank:null}),'Unverified data');
  assert.equal(D.label(errorRow),'Check failed');
});
test('hostname matching rejects query-string and suffix false positives',()=>{
  assert.equal(matchesSite('https://example.com/a','example.com'),true);
  assert.equal(matchesSite('https://www.example.com/a','example.com'),true);
  assert.equal(matchesSite('https://shop.example.com/a','example.com'),true);
  assert.equal(matchesSite('https://notexample.com/?x=example.com','example.com'),false);
  assert.equal(matchesSite('https://example.com.attacker.test','example.com'),false);
});
test('extracted links are validated, exact URL duplicates removed, and YouTube not silently excluded',()=>{
  const r=classifyResults(['bad','javascript:alert(1)','https://google.com/search','https://competitor.test/','https://competitor.test/#part','https://youtube.com/watch?v=1','https://example.com/a'],'example.com');
  assert.equal(r.rank,3);assert.equal(r.resultsChecked,3);assert.equal(r.competitors['youtube.com'],2);
});
test('zero extracted results fail instead of claiming not found',()=>{
  const r=classifyResults([],'example.com');assert.equal(r.status,'error');assert.equal(r.error.code,'no_organic_results');
});
for(const [name,opts,code] of [
  ['challenge',{blocked:true},'blocked'],['consent',{consent:true},'consent_required'],
  ['HTTP error',{status:429},'http_error'],['navigation failure',{throwOnGoto:true},'request_failed'],
  ['empty extraction',{links:[]},'no_organic_results']
]) test(`${name} is unknown, and the page closes`,async()=>{
  const browser=fakeBrowser(opts);const r=await searchGoogle(browser,'keyword','example.com',instant);
  assert.equal(r.error.code,code);assert.equal(D.valid(r),false);assert.equal(browser.closed,1);
});
test('successful extraction records actual checked depth',async()=>{
  const r=await searchGoogle(fakeBrowser({links:['https://one.test/','https://example.com/']}),'keyword','example.com',instant);
  assert.equal(r.rank,2);assert.equal(r.resultsChecked,2);assert.equal(D.valid(r),true);
});
test('history keeps last valid data when latest check fails',()=>{
  const history={'example.com':{keyword:row(2)}};
  const next=D.mergeHistory(history,{'example.com':{keywords:{keyword:errorRow}}},'2026-11-05');
  assert.deepEqual(next,history);assert.deepEqual(history['example.com'].keyword,row(2));
});
test('partial run updates only valid measurements',()=>{
  const history={'example.com':{a:row(2),b:row(3)}};
  const results={'example.com':{keywords:{a:errorRow,b:row(1)}}};
  assert.equal(D.summarize(results).status,'partial');
  const next=D.mergeHistory(history,results,'2026-11-05');assert.equal(next['example.com'].a.rank,2);assert.equal(next['example.com'].b.rank,1);
});
test('failed run writes diagnostics and does not overwrite history',async t=>{
  const dir=fixture(t);const before=fs.readFileSync(path.join(dir,'rank-history.json'),'utf8');
  const result=await run({rootDir:dir,now,wait:instant,launch:async()=>fakeBrowser({links:[]})});
  assert.equal(result.summary.status,'error');assert.equal(fs.readFileSync(path.join(dir,'rank-history.json'),'utf8'),before);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'latest-run.json'))).failed,1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'snapshot-2026-11-05.json')))['example.com'].keywords.keyword.error.code,'no_organic_results');
});
test('browser launch failure is recorded for every configured keyword',async t=>{
  const dir=fixture(t);const result=await run({rootDir:dir,now,wait:instant,launch:async()=>{throw new Error('missing browser');}});
  assert.equal(result.summary.failed,1);assert.equal(result.results['example.com'].keywords.keyword.error.code,'browser_launch_failed');
});
test('successful run persists evidence and comparable previous rank',async t=>{
  const dir=fixture(t);const result=await run({rootDir:dir,now,wait:instant,launch:async()=>fakeBrowser()});
  assert.equal(result.summary.status,'ok');const measurement=result.results['example.com'].keywords.keyword;
  assert.equal(measurement.rank,1);assert.equal(measurement.change,1);assert.equal(measurement.resultsChecked,1);
  assert.equal(measurement.cityTargeting,null);assert.equal(measurement.previousRank,2);
});
test('old unverified rank never produces a movement claim',async t=>{
  const dir=fixture(t,{'example.com':{keyword:{rank:7,date:'2026-11-04'}}});
  const result=await run({rootDir:dir,now,wait:instant,launch:async()=>fakeBrowser()});
  assert.equal(result.results['example.com'].keywords.keyword.change,null);
});
test('CLI returns failure status on browser launch error',t=>{
  const dir=fixture(t);fs.mkdirSync(path.join(dir,'dashboard'));
  fs.copyFileSync(path.join(__dirname,'../tracker.js'),path.join(dir,'tracker.js'));
  fs.copyFileSync(path.join(__dirname,'../dashboard/rank-data.js'),path.join(dir,'dashboard/rank-data.js'));
  fs.writeFileSync(path.join(dir,'mock.cjs'),`const Module=require('node:module');const original=Module._load;Module._load=function(name,...args){if(name==='dotenv')return {config(){}};if(name==='playwright')return {chromium:{launch:async()=>{throw new Error('fixture failure')}}};return original.call(this,name,...args);};`);
  const p=spawnSync(process.execPath,['--require',path.join(dir,'mock.cjs'),path.join(dir,'tracker.js')],{encoding:'utf8'});
  assert.equal(p.status,1,p.stdout+p.stderr);
});
test('report labels failures and legacy data without not-found claims',()=>{
  const {text,html}=buildReport({'example.com':{keywords:{'<script>':errorRow,legacy:{rank:null,competitors:{}}}}},'2026-11-05');
  assert.match(text,/0\/2/);assert.match(text,/Check failed/);assert.match(text,/Unverified data/);
  assert.doesNotMatch(text,/Not in top 30|Not found/);assert.doesNotMatch(html,/<script>/);assert.match(html,/&lt;script&gt;/);
});
test('report describes successful absence at observed depth',()=>{
  assert.match(buildReport({'example.com':{keywords:{keyword:row(null)}}}).text,/Not found among 3 observed results/);
});
async function renderDashboard(files) {
  const nodes={app:{innerHTML:''},'last-updated':{textContent:''},'collection-status':{textContent:''},'report-status':{textContent:''}};
  const ctx={RankData:D,document:{getElementById:id=>nodes[id]},fetch:async url=>{const key=url.split('/').at(-1);return {ok:Object.hasOwn(files,key),json:async()=>files[key]};},Date,console};
  vm.createContext(ctx);vm.runInContext(fs.readFileSync(path.join(__dirname,'../dashboard/app.js'),'utf8'),ctx);await vm.runInContext('render()',ctx);return nodes;
}
test('dashboard legacy fallback uses stored date and warns unverified',async()=>{
  const nodes=await renderDashboard({'rank-history.json':{'example.com':{keyword:{rank:null,date:'2026-11-04'}}}});
  assert.match(nodes['last-updated'].textContent,/2026-11-04/);assert.match(nodes.app.innerHTML,/Unverified data/);
  assert.doesNotMatch(nodes.app.innerHTML,/Not in top 30/);assert.match(nodes['collection-status'].textContent,/unavailable/);
});
test('dashboard shows failed latest attempt separately from last valid observation',async()=>{
  const nodes=await renderDashboard({'rank-history.json':{'example.com':{keyword:row(2)}},'latest-run.json':{date:'2026-11-05',finishedAt:'2026-11-05T12:00:00.000Z',status:'error',successful:0,total:1},'snapshot-2026-11-05.json':{'example.com':{keywords:{keyword:errorRow}}}});
  assert.match(nodes.app.innerHTML,/Check failed/);assert.match(nodes.app.innerHTML,/Observed #2/);assert.match(nodes['collection-status'].textContent,/0\/1/);
});
test('fatal error replaces earlier status and preserves history',async t=>{
  const dir=fixture(t);const before=fs.readFileSync(path.join(dir,'rank-history.json'),'utf8');
  fs.writeFileSync(path.join(dir,'latest-run.json'),JSON.stringify({attemptId:'older',status:'ok',finishedAt:now().toISOString()}));
  fs.writeFileSync(path.join(dir,'keywords.json'),'broken JSON');
  await assert.rejects(run({rootDir:dir,attemptId:'new-attempt',now,wait:instant}));
  const latest=JSON.parse(fs.readFileSync(path.join(dir,'latest-run.json')));
  assert.equal(latest.attemptId,'new-attempt');assert.equal(latest.status,'error');
  assert.equal(fs.readFileSync(path.join(dir,'rank-history.json'),'utf8'),before);
});
test('browser cleanup failure does not discard completed results',async t=>{
  const dir=fixture(t);const browser=fakeBrowser();browser.close=async()=>{throw new Error('cleanup failure');};
  const result=await run({rootDir:dir,now,wait:instant,launch:async()=>browser});
  assert.equal(result.summary.status,'ok');assert.ok(fs.existsSync(path.join(dir,'latest-run.json')));
});
test('reporter requires exact workflow attempt and sane timestamps',()=>{
  const {validateAttempt}=require('../reporter');
  const meta={attemptId:'123:2',date:'2026-11-05',finishedAt:new Date().toISOString()};
  const env={GITHUB_RUN_ID:'123',GITHUB_RUN_ATTEMPT:'2'};
  assert.doesNotThrow(()=>validateAttempt(meta,env));
  for(const bad of [{...meta,attemptId:'123:1'},{...meta,finishedAt:'invalid'},{...meta,finishedAt:undefined},{...meta,finishedAt:new Date(Date.now()+3600000).toISOString()}]) assert.throws(()=>validateAttempt(bad,env));
});
test('tracked site is not its own competitor',()=>{
  const r=classifyResults(['https://example.com/','https://competitor.test/'],'example.com');
  assert.equal(r.rank,1);assert.deepEqual(r.competitors,{'competitor.test':2});
});
test('fatal empty snapshot falls back to labeled preserved history',async()=>{
  const nodes=await renderDashboard({'rank-history.json':{'example.com':{keyword:row(2)}},'latest-run.json':{date:'2026-11-05',finishedAt:'2026-11-05T12:00:00.000Z',status:'error',successful:0,total:0,error:{message:'Broken config'}},'snapshot-2026-11-05.json':{}});
  assert.match(nodes.app.innerHTML,/Observed #2/);assert.match(nodes['collection-status'].textContent,/showing stored history, not current ranks/);assert.match(nodes['collection-status'].textContent,/Broken config/);
});


for (const [name,opts] of [['challenge',{blocked:true}],['consent',{consent:true}],['HTTP 403',{status:403}],['HTTP 429',{status:429}]]) {
  test(`${name} stops further Google queries across all clients`,async t=>{
    const dir=fixture(t); const before=fs.readFileSync(path.join(dir,'rank-history.json'),'utf8');
    fs.writeFileSync(path.join(dir,'keywords.json'),JSON.stringify({clients:[{site:'example.com',keywords:['a','b']},{site:'other.test',keywords:['c']}]}));
    const browser=fakeBrowser(opts);
    const result=await run({rootDir:dir,now,wait:instant,launch:async()=>browser,attemptId:'circuit-test'});
    assert.equal(browser.closed,1,'Only one Google page may be opened');
    assert.deepEqual({...result.summary,attemptId:undefined,startedAt:undefined,finishedAt:undefined,date:undefined,report:undefined},
      {total:3,successful:0,failed:1,skipped:2,notAttempted:2,status:'error',attemptId:undefined,startedAt:undefined,finishedAt:undefined,date:undefined,report:undefined});
    const skipped=result.results['other.test'].keywords.c;
    assert.equal(skipped.status,'skipped');assert.equal(skipped.attempted,false);assert.equal(skipped.checkedAt,null);
    assert.equal(D.label(skipped),'Not checked');assert.equal(D.valid(skipped),false);
    assert.equal(fs.readFileSync(path.join(dir,'rank-history.json'),'utf8'),before);
    assert.equal(result.summary.report.status,'pending');assert.equal(result.summary.report.attemptId,'circuit-test');
    assert.match(buildReport(result.results).text,/2 not attempted/);
  });
}
function reportFixture(t,report) {
  const dir=fixture(t);
  const latest={attemptId:'run:1',date:new Date().toISOString().slice(0,10),finishedAt:new Date().toISOString(),status:'error',successful:0,total:1,failed:1,report};
  fs.writeFileSync(path.join(dir,'latest-run.json'),JSON.stringify(latest));
  fs.writeFileSync(path.join(dir,`snapshot-${latest.date}.json`),JSON.stringify({'example.com':{keywords:{keyword:errorRow}}}));
  return {dir,latest,env:{RESEND_API_KEY:'fixture-key',GITHUB_RUN_ID:'run',GITHUB_RUN_ATTEMPT:'1'}};
}
test('provider rejection is recorded without leaking raw provider content',async t=>{
  const {run:reportRun}=require('../reporter');const {dir,env}=reportFixture(t);
  await assert.rejects(reportRun({rootDir:dir,env,send:async()=>({error:{name:'validation_error',message:'The sevengensystems.com domain is not verified. secret-do-not-log'}})}),/sender domain is not verified/);
  const saved=fs.readFileSync(path.join(dir,'latest-run.json'),'utf8');
  const latest=JSON.parse(saved);assert.equal(latest.report.status,'failed');assert.equal(latest.report.error.code,'sender_domain_unverified');assert.equal(latest.report.attemptId,'run:1');assert.doesNotMatch(saved,/secret-do-not-log|fixture-key/);
});
test('provider acceptance is not claimed as inbox delivery and duplicate sends are refused',async t=>{
  const {run:reportRun}=require('../reporter');const {dir,env}=reportFixture(t);let calls=0;
  const send=async payload=>{calls++;assert.deepEqual(payload.to,['Ben@sevengensystems.com']);assert.equal(payload.from,'SEO Monitor <Ben@sevengensystems.com>');return {data:{id:'receipt'}};};
  await reportRun({rootDir:dir,env,send});
  const latest=JSON.parse(fs.readFileSync(path.join(dir,'latest-run.json')));
  assert.equal(latest.report.status,'accepted');assert.match(D.reportStatusText(latest),/Inbox delivery is not verified/);
  await assert.rejects(reportRun({rootDir:dir,env,send}),/refusing a duplicate/);assert.equal(calls,1);
});
test('transport failure has uncertain outcome and must not be retried automatically',async t=>{
  const {run:reportRun}=require('../reporter');const {dir,env}=reportFixture(t);let calls=0;
  const send=async()=>{calls++;throw new Error('timeout secret-do-not-log');};
  await assert.rejects(reportRun({rootDir:dir,env,send}),/outcome unknown/);
  const saved=fs.readFileSync(path.join(dir,'latest-run.json'),'utf8');assert.equal(JSON.parse(saved).report.status,'unknown');assert.doesNotMatch(saved,/secret-do-not-log/);
  await assert.rejects(reportRun({rootDir:dir,env,send}),/refusing a duplicate/);assert.equal(calls,1);
});
test('missing key records not configured and fails instead of implying a sent report',async t=>{
  const {run:reportRun}=require('../reporter');const {dir,env}=reportFixture(t);delete env.RESEND_API_KEY;
  await assert.rejects(reportRun({rootDir:dir,env,send:async()=>{throw new Error('must not call');}}),/not configured/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'latest-run.json'))).report.status,'not_configured');
});
test('missing acceptance receipt is an unknown send outcome',async()=>{
  const {sendEmail}=require('../reporter');
  assert.equal((await sendEmail('2026-11-06','text','html',{env:{RESEND_API_KEY:'fixture-key'},send:async()=>({data:{}})})).status,'unknown');
});
test('report status from another attempt is never presented as current',()=>{
  assert.match(D.reportStatusText({attemptId:'new',report:{attemptId:'old',status:'accepted'}}),/unavailable/);
  assert.match(D.reportStatusText({attemptId:'new',report:{attemptId:'new',status:'pending'}}),/not yet sent/);
});
test('dashboard displays sender failure independently of collection status',async()=>{
  const nodes=await renderDashboard({'rank-history.json':{},'latest-run.json':{attemptId:'a',date:'2026-11-06',finishedAt:new Date().toISOString(),status:'error',successful:0,total:1,skipped:0,report:{attemptId:'a',status:'failed',error:{message:'The configured sender domain is not verified in Resend.'}}},'snapshot-2026-11-06.json':{'example.com':{keywords:{keyword:errorRow}}}});
  assert.match(nodes['report-status'].textContent,/Report not sent:.*not verified/);assert.match(nodes.app.innerHTML,/Check failed/);
});
for (const error of [{name:'application_error',statusCode:null,message:'Unable to fetch data'}, {name:'internal_server_error',statusCode:500}, {name:'future_unknown_error'}, {name:'validation_error',statusCode:503}]) {
  test(`ambiguous SDK error ${error.name}/${error.statusCode} prevents a retry`,async t=>{
    const {run:reportRun}=require('../reporter');const {dir,env}=reportFixture(t);let calls=0;
    const send=async()=>{calls++;return {data:null,error};};
    await assert.rejects(reportRun({rootDir:dir,env,send}),/outcome unknown/);
    const latest=JSON.parse(fs.readFileSync(path.join(dir,'latest-run.json')));assert.equal(latest.report.status,'unknown');
    await assert.rejects(reportRun({rootDir:dir,env,send}),/refusing a duplicate/);assert.equal(calls,1);
  });
}
test('success before a challenge updates only that history entry',async t=>{
  const initial={'example.com':{a:row(2),b:row(3),c:row(2)}};
  const dir=fixture(t,initial);
  fs.writeFileSync(path.join(dir,'keywords.json'),JSON.stringify({clients:[{site:'example.com',keywords:['a','b','c']}]}));
  const good=fakeBrowser();const blocked=fakeBrowser({blocked:true});let opened=0;
  const browser={close:instant,newPage:async()=>{opened++;return (opened===1?good:blocked).newPage();}};
  const result=await run({rootDir:dir,now,wait:instant,launch:async()=>browser});
  assert.equal(opened,2);assert.equal(result.summary.status,'partial');
  assert.equal(result.summary.successful,1);assert.equal(result.summary.failed,1);assert.equal(result.summary.skipped,1);
  const stored=JSON.parse(fs.readFileSync(path.join(dir,'rank-history.json')));
  assert.equal(stored['example.com'].a.rank,1);assert.deepEqual(stored['example.com'].b,initial['example.com'].b);assert.deepEqual(stored['example.com'].c,initial['example.com'].c);
});
test('browser launch failure does not claim an attempted search',async t=>{
  const dir=fixture(t);const result=await run({rootDir:dir,now,wait:instant,launch:async()=>{throw new Error('browser missing');}});
  const failed=result.results['example.com'].keywords.keyword;
  assert.equal(result.summary.notAttempted,1);assert.equal(failed.status,'error');assert.equal(failed.attempted,false);assert.equal(failed.checkedAt,null);
});
test('a persisted in-flight send is not automatically repeated',async t=>{
  const {run:reportRun}=require('../reporter');const {dir,env}=reportFixture(t,{attemptId:'run:1',status:'sending'});let calls=0;
  await assert.rejects(reportRun({rootDir:dir,env,send:async()=>{calls++;return {data:{id:'receipt'}};}}),/refusing a duplicate/);assert.equal(calls,0);
});
test('local reporting also requires a nonempty attempt identity',()=>{
  const {validateAttempt}=require('../reporter');
  assert.throws(()=>validateAttempt({date:'2026-11-06',finishedAt:new Date().toISOString()},{}),/metadata/);
});
