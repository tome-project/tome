import { initializeApp, applicationDefault, getApps } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import { hubClient, isHubMode } from './hub';
import { startBackgroundJob } from './background-job';

/** Only the hub delivers notifications; scoped library machines cannot read device tokens. */
export function startPushNotifications(): void {
  if (!isHubMode() || !process.env.GOOGLE_APPLICATION_CREDENTIALS) return;
  if (!getApps().length) initializeApp({ credential: applicationDefault() });
  startBackgroundJob({name:'request-notifications',intervalMs:30_000,timeoutMs:25_000,run:async signal=>{
    const hub=hubClient();
    const {data:pending,error}=await hub.from('notification_outbox').select('*').is('sent_at',null)
      .lte('next_attempt_at',new Date().toISOString()).order('created_at').limit(20).abortSignal(signal);
    if(error)throw error;
    for(const notification of pending||[]){
      signal.throwIfAborted();
      if(Date.now()-Date.parse(notification.created_at)>=86400000){
        const {error}=await hub.from('notification_outbox').update({sent_at:new Date().toISOString()}).eq('id',notification.id).abortSignal(signal);
        if(error)throw error;continue;
      }
      const {data:registered,error:deviceError}=await hub.from('notification_devices').select('token').eq('user_id',notification.user_id).abortSignal(signal);
      if(deviceError)throw deviceError;
      const delivered=notification.delivered_tokens||[];
      const devices=(registered||[]).filter(d=>!delivered.includes(d.token));
      if(!registered?.length){
        // A reader can opt in later; retain unsent notifications for one day.
        if(Date.now()-Date.parse(notification.created_at)<86400000){
          const {error}=await hub.from('notification_outbox').update({next_attempt_at:new Date(Date.now()+300000).toISOString()}).eq('id',notification.id).abortSignal(signal);
          if(error)throw error;continue;
        }
      }else if(devices.length){
        const results=await getMessaging().sendEachForMulticast({tokens:devices.map(d=>d.token),
          notification:{title:notification.title,body:notification.body},data:{book_id:notification.book_id||'',request_id:notification.request_id},
          android:{collapseKey:notification.request_id,notification:{channelId:'app.tome.readtogether.requests',tag:notification.request_id},ttl:86400000},
          apns:{payload:{aps:{sound:'default'}},headers:{'apns-collapse-id':notification.request_id,'apns-expiration':String(Math.floor(Date.now()/1000)+86400)}}});
        let retry=false;
        for(let i=0;i<results.responses.length;i++){
          const failure=results.responses[i].error;
          if(!failure){delivered.push(devices[i].token);continue;}
          if(['messaging/registration-token-not-registered','messaging/invalid-registration-token'].includes(failure.code))
            await hub.from('notification_devices').delete().eq('token',devices[i].token).abortSignal(signal);
          else retry=true;
        }
        const {error:ackError}=await hub.from('notification_outbox').update({delivered_tokens:delivered}).eq('id',notification.id).abortSignal(signal);
        if(ackError)throw ackError;
        if(retry){
          const attempts=notification.attempts+1;
          const {error}=await hub.from('notification_outbox').update({attempts,next_attempt_at:new Date(Date.now()+Math.min(3600000,30000*2**Math.min(attempts,7))).toISOString()}).eq('id',notification.id).abortSignal(signal);
          if(error)throw error;continue;
        }
      }
      const {error}=await hub.from('notification_outbox').update({sent_at:new Date().toISOString()}).eq('id',notification.id).abortSignal(signal);
      if(error)throw error;
    }
  }});
}
