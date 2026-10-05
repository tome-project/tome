import * as yauzl from 'yauzl';
import path from 'path';
import { XMLParser } from 'fast-xml-parser';

export interface EpubMetadata {
  title: string; author: string; description: string | null;
  publisher: string | null; language: string | null; coverImage: Buffer | null;
}
const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, processEntities: false });
const list = (value: any): any[] => value == null ? [] : Array.isArray(value) ? value : [value];
const text = (value: any): string | null => {
  const first=list(value)[0]; return first == null ? null : typeof first === 'object' ? String(first['#text'] || '') : String(first);
};

/** Read only metadata and a bounded cover; do not extract an untrusted archive to disk. */
export async function extractEpubMetadata(filePath: string): Promise<EpubMetadata> {
  const zip = await new Promise<yauzl.ZipFile>((resolve,reject) => yauzl.open(filePath,{lazyEntries:true,autoClose:false},(err,value)=>err?reject(err):resolve(value)));
  try {
    const entries = new Map<string,yauzl.Entry>();
    await new Promise<void>((resolve,reject)=>{
      zip.on('error',reject);zip.on('end',resolve);
      zip.on('entry',(entry:yauzl.Entry)=>{
        if(entries.size>=100000){ reject(new Error('EPUB contains too many entries'));return; }
        entries.set(entry.fileName,entry);zip.readEntry();
      });zip.readEntry();
    });
    const read = async (name:string,limit=2*1024*1024):Promise<Buffer> => {
      const entry=entries.get(name);if(!entry)throw new Error(`Missing EPUB entry: ${name}`);
      if(entry.uncompressedSize>limit)throw new Error('EPUB metadata exceeds size limit');
      const stream=await new Promise<NodeJS.ReadableStream>((resolve,reject)=>zip.openReadStream(entry,(err,value)=>err?reject(err):resolve(value)));
      const chunks:Buffer[]=[];let size=0;
      for await (const chunk of stream){const bytes=Buffer.from(chunk);size+=bytes.length;if(size>limit)throw new Error('EPUB expansion exceeds limit');chunks.push(bytes);}
      return Buffer.concat(chunks);
    };
    const container=parser.parse((await read('META-INF/container.xml')).toString('utf8'));
    const opfPath=list(container.container?.rootfiles?.rootfile)[0]?.['@_full-path'];
    if(typeof opfPath!=='string')throw new Error('EPUB has no package document');
    const pkg=parser.parse((await read(opfPath)).toString('utf8')).package;
    if(!pkg)throw new Error('Invalid EPUB package');
    const metadata=pkg.metadata||{};const items=list(pkg.manifest?.item);
    const coverId=list(metadata.meta).find(m=>m['@_name']==='cover')?.['@_content'];
    const cover=items.find(item=>item['@_properties']?.split(' ').includes('cover-image')) || items.find(item=>item['@_id']===coverId);
    let coverImage:Buffer|null=null;
    if(cover?.['@_href']){try{coverImage=await read(path.posix.normalize(path.posix.join(path.posix.dirname(opfPath),decodeURIComponent(cover['@_href']))),16*1024*1024);}catch{/* optional cover */}}
    return {title:text(metadata.title)||'Unknown',author:text(metadata.creator)||'Unknown',description:text(metadata.description),publisher:text(metadata.publisher),language:text(metadata.language),coverImage};
  } finally { zip.close(); }
}
