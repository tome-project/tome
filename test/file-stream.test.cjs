const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path');
const {parseRange,containedPath}=require('../dist/services/file-stream');
test('ranges support seek, open ends, suffixes and clamp oversized ends',()=>{
 assert.deepEqual(parseRange('bytes=10-19',100),{start:10,end:19});
 assert.deepEqual(parseRange('bytes=90-',100),{start:90,end:99});
 assert.deepEqual(parseRange('bytes=-10',100),{start:90,end:99});
 assert.deepEqual(parseRange('bytes=90-999',100),{start:90,end:99});
 for(const r of ['bytes=100-','bytes=20-10','bytes=-0','bytes=1-2,5-6','bytes=a-b','bytes=9007199254740992-'])assert.equal(parseRange(r,100),null);
 assert.equal(parseRange('bytes=0-',0),null);
});
test('path boundary rejects sibling directories and symlink escapes',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'tome-path-'));
 try {fs.mkdirSync(path.join(root,'library'));fs.writeFileSync(path.join(root,'outside'),'x');
 fs.symlinkSync(path.join(root,'outside'),path.join(root,'library','link'));
 assert.equal(containedPath(path.join(root,'library'),'../library-other/book'),null);
 assert.equal(containedPath(path.join(root,'library'),'link'),null);
 assert.equal(containedPath(path.join(root,'library'),'book'),path.join(root,'library','book'));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
