const test=require('node:test'),assert=require('node:assert/strict');
const {createClient}=require('@supabase/supabase-js');
const hub=require('../dist/services/hub');
const {ensureCatalog}=require('../dist/services/scan-on-startup');
const book={absolutePath:require('node:path').resolve('library/fixture.epub'),mediaType:'epub',metadata:{title:'Fixture without author',authors:[]}};
function client(fetch){return createClient('https://fixture.invalid','public-fixture',{auth:{persistSession:false},global:{fetch}});}
function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json'}});}
test('a known file retains its catalog identity without author or ISBN',async()=>{
 let calls=0;hub.hubClient=()=>client(async(url)=>{calls++;assert.ok(String(url).includes('library_server_books'));return json([{book:{id:'existing'}}]);});
 assert.equal((await ensureCatalog(book,'server')).id,'existing');assert.equal(calls,1);
});
test('authorless new files reuse matching title rather than minting another catalog title',async()=>{
 hub.hubClient=()=>client(async(url,options)=>{
  assert.ok(!options.method || options.method==='GET');
  if(String(url).includes('library_server_books'))return json([]);
  assert.ok(String(url).includes('authors=eq.%7B%7D'));return json([{id:'known-title'}]);
 });
 assert.equal((await ensureCatalog(book,'server')).id,'known-title');
});
test('a failed identity lookup aborts rather than minting duplicate catalog records',async()=>{
 hub.hubClient=()=>client(async()=>json({message:'temporary cloud failure'},503));
 await assert.rejects(ensureCatalog(book,'server'));
});
