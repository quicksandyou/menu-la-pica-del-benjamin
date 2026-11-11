"use strict";
const fs=require("node:fs");
const vm=require("node:vm");
const path=require("node:path");
const root=process.cwd();
const htmlFiles=["index.html","desktop/app/index.html","reparto.html"];
const jsFiles=["desktop/main.js","desktop/preload.js"];
let count=0;
for(const file of htmlFiles){
 if(!fs.existsSync(path.join(root,file))) continue;
 const html=fs.readFileSync(path.join(root,file),"utf8");
 const scripts=[...html.matchAll(/<script\\b([^>]*)>([\\s\\S]*?)<\\/script>/gi)];
 for(let i=0;i<scripts.length;i++){
  const attrs=scripts[i][1]||"", code=scripts[i][2]||"";
  if(/\\bsrc\\s*=/.test(attrs)||!code.trim()) continue;
  new vm.Script(code,{filename:file+" inline script #"+(i+1)});
  count++;
 }
}
for(const file of jsFiles){
 const full=path.join(root,file);if(!fs.existsSync(full))continue;
 new vm.Script(fs.readFileSync(full,"utf8"),{filename:file});count++;
}
const menu=JSON.parse(fs.readFileSync(path.join(root,"menu.json"),"utf8"));
const index=fs.readFileSync(path.join(root,"index.html"),"utf8");
const testFn=index.match(/async function enableStaffTestMode\\s*\\([\\s\\S]*?\\n}/);
if(!testFn||!testFn[0].includes("await fetch"))throw new Error("enableStaffTestMode debe ser async y validar el modo de prueba");
const groups=index.match(/const APP_CATEGORY_GROUPS=\\[([\\s\\S]*?)\\n\\];/);
if(!groups)throw new Error("No se encontró APP_CATEGORY_GROUPS");
for(const m of groups[1].matchAll(/categories:\\[([^\\]]*)\\]/g)){
 for(const c of m[1].matchAll(/"([^"]+)"/g)){
  if(!menu.categories.includes(c[1]))throw new Error("Categoría de APK no existe en menu.json: "+c[1]);
 }
}
const pos=fs.readFileSync(path.join(root,"desktop/app/index.html"),"utf8");
for(const id of ["tabs","products","cartLines","catPrev","catNext"])if(!new RegExp('id=["\\']'+id+'["\\']').test(pos))throw new Error("Falta elemento requerido en POS: #"+id);
for(const handler of ["tabs.addEventListener('click'","products.addEventListener('click'","cartLines').addEventListener('click'","catPrev').addEventListener('click'","catNext').addEventListener('click'"])if(!pos.includes(handler))throw new Error("Falta evento POS: "+handler);
console.log("JavaScript válido: "+count+" bloques/archivos. Carta: "+menu.products.length+" productos, "+menu.categories.length+" categorías. Categorías APK y eventos POS verificados.");
