// DEX-maintained Markdown renderer. No frontmatter configuration, external resources,
// caller-supplied executable paths, scripts, or arbitrary filesystem destinations.
import puppeteer from 'puppeteer-core';
import {marked} from 'marked';
const PDF_KEYS=new Set(['format','width','height','landscape','printBackground','preferCSSPageSize','scale','pageRanges','margin','displayHeaderFooter']);
export function pdfOptions(options={}){
 if(!options||typeof options!=='object'||Array.isArray(options))throw new Error('Invalid PDF options');
 for(const key of Object.keys(options))if(key!=='pdf_options')throw new Error('Unsupported PDF option: '+key);
 const pdf=options.pdf_options??{};
 if(!pdf||typeof pdf!=='object'||Array.isArray(pdf))throw new Error('Invalid pdf_options');
 for(const key of Object.keys(pdf))if(!PDF_KEYS.has(key))throw new Error('Unsupported PDF option: '+key);
 if(pdf.margin!==undefined){
  if(typeof pdf.margin!=='object'||pdf.margin===null||Array.isArray(pdf.margin))throw new Error('Invalid PDF margin');
  if(Object.keys(pdf.margin).some(key=>!['top','bottom','left','right'].includes(key)))throw new Error('Invalid PDF margin key');
 }
 return {...pdf,timeout:10000};
}
export async function renderMarkdown(markdown,options,executablePath){
 const pdf=pdfOptions(options);
 if(!executablePath)throw new Error('DEX PDF generation requires an already installed Chrome or Chromium');
 const html=marked.parse(markdown);
 const browser=await puppeteer.launch({executablePath,headless:true,timeout:10000,protocolTimeout:10000});
 try{
  const page=await browser.newPage();
  await page.setJavaScriptEnabled(false);
  await page.setRequestInterception(true);
  page.on('request',request=>{
   if(request.url().startsWith('data:')||request.url()==='about:blank')void request.continue();
   else void request.abort();
  });
  await page.setContent('<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'; font-src data:; base-uri \'none\'; form-action \'none\'"><meta charset="utf-8"><style>body{font-family:Arial,sans-serif;margin:32px;line-height:1.5}pre{white-space:pre-wrap}img{max-width:100%}table{border-collapse:collapse}td,th{border:1px solid #bbb;padding:4px}</style></head><body>'+html+'</body></html>',{waitUntil:'load',timeout:10000});
  return Buffer.from(await page.pdf(pdf));
 }finally{
  const child=browser.process();
  let timer;
  try{await Promise.race([browser.close(),new Promise(resolve=>{timer=setTimeout(resolve,2000);})]);}
  finally{if(timer)clearTimeout(timer);if(child&&child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}
 }
}
