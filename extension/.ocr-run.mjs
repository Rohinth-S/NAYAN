import { createWorker, PSM } from 'tesseract.js';
import {readFile} from 'node:fs/promises';
const w=await createWorker(['eng'],1,{langPath:'./models/ocr/lang-data',gzip:false,cacheMethod:'none',logger:()=>{},errorHandler:()=>{}}); await w.setParameters({tessedit_pageseg_mode:PSM.SINGLE_BLOCK,preserve_interword_spaces:'1',user_defined_dpi:'220'});
for(const f of ['../.runtime/credit.png','../.runtime/aadhaar.png']){const r=await w.recognize(await readFile(f),{}, {blocks:true});console.log('\nFILE',f,'TEXT\n'+r.data.text);for(const b of r.data.blocks??[])for(const p of b.paragraphs??[])for(const l of p.lines??[])console.log(JSON.stringify(l.text),l.confidence,l.words?.map(x=>({t:x.text,c:x.confidence,b:x.bbox})));}await w.terminate();
