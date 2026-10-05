const test=require('node:test'),assert=require('node:assert/strict');
const {createClient}=require('@supabase/supabase-js');
const hub=require('../dist/services/hub'),scheduler=require('../dist/services/background-job');
let runner,messages=[],notification,devices;
require.cache[require.resolve('firebase-admin/app')]={exports:{getApps:()=>[{}],initializeApp(){},applicationDefault(){}}};
require.cache[require.resolve('firebase-admin/messaging')]={exports:{getMessaging:()=>({sendEachForMulticast:async(message)=>{
 messages.push(message);
 return {responses:message.tokens.map(token=>token==='device-B' && messages.length===1 ? {error:{code:'messaging/internal-error'}} : {})};
}})}};
const {startPushNotifications}=require('../dist/services/push-notifications');
function setup(age=0){
 messages=[];devices=[{token:'device-A'},{token:'device-B'}];
 notification={id:'notification',user_id:'reader',request_id:'request',book_id:'book',title:'Ready',body:'Fixture',attempts:0,delivered_tokens:[],created_at:new Date(Date.now()-age).toISOString()};
 process.env.GOOGLE_APPLICATION_CREDENTIALS='/fixture/private.json';
 hub.isHubMode=()=>true;
 hub.hubClient=()=>createClient('https://fixture.invalid','public-fixture',{auth:{persistSession:false,autoRefreshToken:false},global:{fetch:async(url,options)=>{
  const outbox=String(url).includes('notification_outbox');
  if(options.method==='PATCH')Object.assign(notification,JSON.parse(options.body));
  const data=outbox ? [notification] : devices;
  return new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}});
 }}});
 scheduler.startBackgroundJob=job=>{runner=job.run;return()=>{}};
 startPushNotifications();
}
test('partial delivery retries only the failed device and acknowledges all recipients',async()=>{
 setup();await runner(new AbortController().signal);
 assert.deepEqual(messages[0].tokens,['device-A','device-B']);assert.deepEqual(notification.delivered_tokens,['device-A']);
 assert.ok(notification.next_attempt_at);assert.equal(notification.sent_at,undefined);
 await runner(new AbortController().signal);
 assert.deepEqual(messages[1].tokens,['device-B']);assert.deepEqual(notification.delivered_tokens,['device-A','device-B']);
 assert.ok(notification.sent_at);assert.equal(messages[0].android.notification.tag,'request');
});
test('expired queued alerts are completed without sending a stale message',async()=>{
 setup(86400001);await runner(new AbortController().signal);assert.equal(messages.length,0);assert.ok(notification.sent_at);
});
