'use strict';
const fs=require('fs'),vm=require('vm'),Module=require('module');let checked=0;const failures=[];
for(const file of fs.readdirSync('.').filter(f=>f.endsWith('.html')))for(const m of fs.readFileSync(file,'utf8').matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)){
 if(/\bsrc\s*=/.test(m[1])||!m[2].trim())continue;
 try{new vm.Script(m[2],{filename:file});checked++;}catch(e){failures.push(file+': '+e.message);}
}
for(const dir of ['backend','assets','branding','scripts','tests'])for(const f of fs.readdirSync(dir).filter(f=>f.endsWith('.js'))){
 try{new vm.Script(Module.wrap(fs.readFileSync(dir+'/'+f,'utf8')),{filename:dir+'/'+f});checked++;}catch(e){failures.push(dir+'/'+f+': '+e.message);}
}
const result={checked,failures};fs.writeFileSync('tests/syntax-results.json',JSON.stringify(result,null,2));console.log(result);if(failures.length)process.exit(1);
