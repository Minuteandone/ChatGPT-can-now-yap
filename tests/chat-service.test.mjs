import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {initializeDatabase,chatDatabase} from '../src/storage.mjs';
import {after} from 'node:test';
const sql = new PGlite();
await initializeDatabase(sql);
after(()=>sql.close());
import {ChatService,handleMcp,TOOLS} from '../src/chat-service.mjs';
const vid='25a9bc78-7ff4-4136-a948-aa6fbeea9e92',room='9afefd19-70ff-40c0-aca6-5e92aa01b13c',uid='11111111-1111-4111-8111-111111111111';
const msg='22222222-2222-4222-8222-222222222222';
const time='2026-09-25T00:00:37.469Z',date='2026-09-24';
const data=r=>r.structuredContent;
async function setup(){
 await sql.query('TRUNCATE identities, identity_locks, operations');
 const sqlite=sql; const db=chatDatabase(sql);
 let username='Visitor',postCount=0,reactionCount=0,failPost=false,chatOpen=true;
 const reactions=[];
 const event={id:crypto.randomUUID(),eventIndex:100,createdAt:time,data:{actionType:'USER_TALK',speakerId:uid,speakerName:'George',content:'Hello',messageId:msg,roomId:room,hasBeenApproved:true}};
 const events=[event];const calls=[];
 const fetcher=async(url,init={})=>{
  const u=new URL(url),path=u.pathname.replace('/village/api',''),method=init.method??'GET',body=init.body?JSON.parse(init.body):null;calls.push({path,method,body,query:u.search});
  const response=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
  if(path==='/villages' || path===`/villages/${vid}`)return response({id:vid,slug:'open-chat',isChatOpen:chatOpen,turnId:null,chatRooms:[{id:room,name:'general'}],agents:[]});
  if(path==='/users'&&method==='POST')return response({id:uid});
  if(path==='/users/display-name'){if(method==='PUT')username=body.name;return response({displayName:username});}
  if(path==='/events')return response({events:structuredClone(events),hasMore:false,lastEventIndex:events.at(-1)?.eventIndex??100,windowDate:date});
  if(path==='/chat/messages'&&method==='POST'){postCount++;if(failPost)throw new Error('network');const id=crypto.randomUUID();events.push({id:crypto.randomUUID(),eventIndex:200,createdAt:new Date().toISOString(),data:{actionType:'USER_TALK',speakerId:uid,speakerName:username,content:body.content,messageId:id,roomId:room,hasBeenApproved:false}});return response({messageId:id,hasBeenApproved:false});}
  if(path==='/reactions'){if(method==='POST'){reactionCount++;let n=reactions.indexOf(body.emoji);n<0?reactions.push(body.emoji):reactions.splice(n,1);}return response({counts:{[msg]:Object.fromEntries(reactions.map(e=>[e,1]))},userReactions:{[msg]:reactions}});}
  throw new Error(`Unexpected route ${method} ${path}`);
 };
 const service=new ChatService(db,'owner-one',fetcher);
 return {service,db,fetcher,events,calls,sqlite,counts:()=>({postCount,reactionCount}),setFail:()=>{failPost=true;},close:()=>{chatOpen=false;}};
}
test('reading filters other pending and hidden posts, creates no identity, retains source date',async()=>{
 const x=await setup();x.events.push({id:crypto.randomUUID(),eventIndex:101,createdAt:time,data:{actionType:'USER_TALK',speakerId:'someone',content:'pending',hasBeenApproved:false}},{id:crypto.randomUUID(),eventIndex:102,createdAt:time,data:{actionType:'USER_TALK',content:'hidden',isHidden:true}});
 const r=data(await x.service.call('read_messages',{}));assert.equal(r.messages.length,1);assert.equal(r.window_date,date);assert.equal(data(await x.service.call('get_identity',{})).initialized,false);assert.equal(x.calls.some(c=>c.method!=='GET'),false);
});
test('cursor does not skip unseen messages when bounded',async()=>{const x=await setup();for(let n=101;n<106;n++)x.events.push({...x.events[0],id:crypto.randomUUID(),eventIndex:n});const r=data(await x.service.call('read_messages',{after_event_index:100,limit:2}));assert.deepEqual(r.messages.map(m=>m.event_index),[101,102]);assert.equal(r.next_after_event_index,102);assert.equal(r.more_messages_in_page,true);});
test('username persists and identity never leaks into another owner',async()=>{const x=await setup();assert.equal(data(await x.service.call('change_username',{username:'starPetter'})).username,'starPetter');const second=new ChatService(x.db,'owner-one',x.fetcher);assert.equal(data(await second.call('get_identity',{})).username,'starPetter');const other=new ChatService(x.db,'owner-two',x.fetcher);assert.equal(data(await other.call('get_identity',{})).initialized,false);assert.equal('local_key' in data(await second.call('get_identity',{})),false);});
test('message text is exact, moderation preserved, idempotent retry sends once',async()=>{const x=await setup();await x.service.call('change_username',{username:'test'});const a={content:'Hello\nworld ❤️',operation_id:'test-send-0001'};const r=await x.service.call('post_message',a);assert.equal(data(r).status,'pending_moderation');assert.equal(x.calls.find(c=>c.path==='/chat/messages').body.content,a.content);assert.deepEqual(await x.service.call('post_message',{operation_id:a.operation_id,content:a.content}),r);assert.equal(x.counts().postCount,1);await assert.rejects(x.service.call('post_message',{...a,content:'different'}),e=>e.code==='operation_id_reused');});
test('unknown send outcome survives retries without a second upstream post',async()=>{const x=await setup();await x.service.call('change_username',{username:'test'});x.setFail();const a={content:'hello',operation_id:'test-send-0002'};const r=await x.service.call('post_message',a);assert.equal(r.isError,true);assert.equal(data(r).outcome_uncertain,true);await assert.rejects(x.service.call('post_message',a),e=>e.code==='outcome_uncertain');assert.equal(x.counts().postCount,1);assert.equal(data(await x.service.call('get_action_result',{operation_id:a.operation_id})).state,'pending');});
test('add reaction twice and then remove changes upstream exactly twice',async()=>{const x=await setup();await x.service.call('change_username',{username:'test'});const a={message_id:msg,message_created_at:time,date,emoji:'❤️',action:'add',operation_id:'reaction-0001'};assert.equal(data(await x.service.call('react_to_message',a)).present,true);assert.equal(data(await x.service.call('react_to_message',{...a,operation_id:'reaction-0002'})).changed,false);assert.equal(data(await x.service.call('react_to_message',{...a,action:'remove',operation_id:'reaction-0003'})).present,false);assert.equal(x.counts().reactionCount,2);});
test('missing identity, closed chat, bad target, and invalid fields cannot cause a public mutation',async()=>{const x=await setup();const r=await x.service.call('post_message',{content:'hi',operation_id:'blocked-0001'});assert.equal(r.isError,true);await x.service.call('change_username',{username:'test'});x.close();const c=await x.service.call('post_message',{content:'hi',operation_id:'blocked-0002'});assert.equal(data(c).error,'chat_closed');await assert.rejects(x.service.call('change_username',{username:'test',user_id:uid}),e=>e.code==='invalid_arguments');await assert.rejects(x.service.call('read_messages',{date:'2026-99-99'}),e=>e.code==='invalid_arguments');const b=await x.service.call('react_to_message',{message_id:msg,message_created_at:'2026-09-25T01:00:00Z',emoji:'❤️',action:'add',date,operation_id:'blocked-0003'});assert.equal(data(b).error,'message_timestamp_mismatch');assert.deepEqual(x.counts(),{postCount:0,reactionCount:0});});
test('MCP lifecycle, tools, authentication and origin policy',async()=>{const x=await setup();const request=(body,headers={})=>new Request('https://example.chatgpt.site/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream',...headers},body:JSON.stringify(body)});const init=await handleMcp(request({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18'}}),{DB:x.db},x.fetcher);assert.equal((await init.json()).result.serverInfo.name,'ai-village-open-chat');const listed=await handleMcp(request({jsonrpc:'2.0',id:2,method:'tools/list'}),{DB:x.db},x.fetcher);assert.equal((await listed.json()).result.tools.length,8);const call={jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'get_identity',arguments:{}}};const noauth=await handleMcp(request(call),{DB:x.db},x.fetcher);assert.equal((await noauth.json()).result.isError,true);const auth=await handleMcp(request(call,{'oai-authenticated-user-id':'owner-one'}),{DB:x.db},x.fetcher,'owner-one');assert.equal((await auth.json()).result.structuredContent.initialized,false);const bad=await handleMcp(request(call,{origin:'https://evil.example'}),{DB:x.db},x.fetcher);assert.equal(bad.status,403);assert.equal((await handleMcp(request({jsonrpc:'2.0',method:'notifications/initialized'}),{DB:x.db},x.fetcher)).status,202);assert.equal((await handleMcp(new Request('https://example.chatgpt.site/mcp'),{DB:x.db},x.fetcher)).status,405);});
