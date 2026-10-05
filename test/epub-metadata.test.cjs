const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {extractEpubMetadata} = require('../dist/services/epub-metadata');
test('EPUB namespaced metadata and relative cover are read without extraction',async()=>{
 const metadata=await extractEpubMetadata(path.join(__dirname,'fixtures/metadata.epub'));
 assert.equal(metadata.title,'Offline Reader');assert.equal(metadata.author,'Tome Fixture');
 assert.equal(metadata.language,'en');assert.equal(metadata.coverImage.toString(),'fixture-cover');
});
test('compressed oversized XML is rejected before expansion',async()=>{
 await assert.rejects(extractEpubMetadata(path.join(__dirname,'fixtures/oversized-metadata.epub')),/size limit/);
});
