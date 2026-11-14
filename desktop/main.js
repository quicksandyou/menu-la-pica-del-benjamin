const {app,BrowserWindow,shell,dialog,ipcMain,net}=require("electron");
const gotSingleInstanceLock=app.requestSingleInstanceLock();
if(!gotSingleInstanceLock) app.quit();
else app.on("second-instance",()=>{
 if(win&&!win.isDestroyed()){
  if(win.isMinimized())win.restore();
  win.focus();
 }
});
const {autoUpdater}=require("electron-updater");
const path=require("path");
const fs=require("fs");
let win;
let updatePromptOpen=false;
const serviceWindows=new Map();
const SERVICE_CONFIG={
 gmail:{url:"https://mail.google.com/mail/u/?authuser=lapicadadelbenjamin%40gmail.com",title:"Gmail · lapicadadelbenjamin@gmail.com",partition:"persist:lapica-gmail"},
 whatsapp:{url:"https://web.whatsapp.com/",title:"WhatsApp | La Picá del Benjamín",partition:"persist:lapica-whatsapp"}
};

const printedOrderIds=new Set();
const printedOrdersFile=path.join(app.getPath("userData"),"printed-web-orders.json");
try{for(const id of JSON.parse(fs.readFileSync(printedOrdersFile,"utf8")))printedOrderIds.add(String(id));}catch(_){}
function persistPrintedOrderIds(){try{fs.writeFileSync(printedOrdersFile,JSON.stringify([...printedOrderIds].slice(-2000)),"utf8");}catch(e){console.warn("No se pudo guardar historial de comandas:",e.message);}}
function escapeReceipt(value){return String(value??"").replace(/[&<>"']/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));}
ipcMain.handle("pos:print-web-order",async(_event,order)=>{
 if(!order||!order.id)throw new Error("Pedido inválido para impresión.");
 const id=String(order.id);
 if(printedOrderIds.has(id))return {ok:true,duplicate:true};
 const items=Array.isArray(order.items_json)?order.items_json:(()=>{try{return JSON.parse(order.items_json||"[]")}catch(_){return []}})();
 const money=value=>"$"+Number(value||0).toLocaleString("es-CL");
 const rows=items.map(item=>{
  const qty=Number(item.quantity||item.qty||1);
  const name=escapeReceipt(item.name||item.product||item.title||"Producto");
  const detail=escapeReceipt(item.variant||item.details||item.notes||"");
  const unit=Number(item.unit_price_clp??item.price_clp??item.price??0);
  const subtotal=Number(item.subtotal_clp??(unit*qty));
  const priceLine=subtotal>0?'<div class="item-price">'+money(subtotal)+'</div>':"";
  return '<div class="item"><div class="item-main"><span class="qty">'+qty+' ×</span><span class="product">'+name+'</span></div>'+(detail?'<div class="item-detail">'+detail+'</div>':"")+priceLine+'</div>';
 }).join("");
 const orderLabel=escapeReceipt(order.order_number||("Pedido #"+id));
 const created=order.created_at?new Date(order.created_at).toLocaleString("es-CL",{timeZone:"America/Santiago"}):new Date().toLocaleString("es-CL",{timeZone:"America/Santiago"});
 const address=[order.delivery_address,order.locality].filter(Boolean).join(", ");
 const method=String(order.delivery_method||"").toLowerCase();
 const isPickup=method.includes("retiro")||method.includes("local");
 const customer=escapeReceipt(order.customer_name||"Sin nombre");
 const phone=escapeReceipt(order.customer_phone||"No informado");
 const notes=escapeReceipt(order.notes||order.customer_notes||"");
 const html=`<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Comanda ${orderLabel}</title><style>
 @page{size:80mm auto;margin:0}
 *{box-sizing:border-box}
 html,body{width:80mm;margin:0;padding:0;background:#fff;color:#111}
 body{padding:4mm;font:12px/1.35 Arial,Helvetica,sans-serif}
 .brand{text-align:center;font-weight:900;font-size:19px;line-height:1.05;letter-spacing:.2px}
 .brand-sub{text-align:center;font-size:10px;letter-spacing:2px;margin-top:2px}
 .ticket-type{text-align:center;font-size:11px;font-weight:800;letter-spacing:1.4px;margin-top:9px}
 .order{text-align:center;font-size:22px;font-weight:900;margin:3px 0 7px}
 .rule{border-top:1px dashed #333;margin:8px 0}
 .meta{display:flex;justify-content:space-between;gap:8px;font-size:10px}
 .section-title{font-size:11px;font-weight:900;letter-spacing:.8px;margin:7px 0 5px}
 .customer{font-size:12px;line-height:1.45}
 .customer strong{font-size:13px}
 .method{display:inline-block;border:1px solid #111;padding:3px 6px;font-size:10px;font-weight:800;margin-top:5px}
 .item{padding:6px 0;border-bottom:1px dotted #aaa}
 .item-main{display:flex;gap:6px;align-items:flex-start;font-size:12px;font-weight:700}
 .qty{min-width:27px;white-space:nowrap}
 .product{flex:1;overflow-wrap:anywhere}
 .item-detail{font-size:10px;margin:3px 0 0 33px;color:#333;overflow-wrap:anywhere}
 .item-price{text-align:right;font-size:11px;font-weight:700;margin-top:2px}
 .total-row{display:flex;justify-content:space-between;align-items:center;font-size:17px;font-weight:900;margin:9px 0}
 .notes{border:1px solid #333;padding:6px;font-size:11px;white-space:pre-wrap;overflow-wrap:anywhere}
 .footer{text-align:center;font-size:10px;margin-top:12px;line-height:1.5}
 .footer strong{font-size:12px}
 </style></head><body>
 <div class="brand">LA PICÁ DEL BENJAMÍN</div>
 <div class="brand-sub">SABOR QUE SE COMPARTE</div>
 <div class="ticket-type">COMANDA DE PEDIDO</div>
 <div class="order">${orderLabel}</div>
 <div class="meta"><span>FECHA</span><strong>${escapeReceipt(created)}</strong></div>
 <div class="rule"></div>
 <div class="section-title">DATOS DEL CLIENTE</div>
 <div class="customer"><strong>${customer}</strong><br>Tel: ${phone}<br>${isPickup?"Retiro en local":escapeReceipt(address||"Dirección no informada")}<br><span class="method">${escapeReceipt(order.delivery_method||"Modalidad no informada")}</span></div>
 <div class="rule"></div>
 <div class="section-title">DETALLE DEL PEDIDO</div>
 ${rows||'<div class="item">Sin detalle de productos</div>'}
 <div class="rule"></div>
 <div class="total-row"><span>TOTAL</span><span>${money(order.total_clp)}</span></div>
 ${notes?'<div class="section-title">OBSERVACIONES</div><div class="notes">'+notes+'</div>':""}
 <div class="rule"></div>
 <div class="footer"><strong>¡GRACIAS POR TU COMPRA!</strong><br>La Picá del Benjamín</div>
 </body></html>`;
 const receiptWindow=new BrowserWindow({show:false,width:400,height:800,webPreferences:{nodeIntegration:false,contextIsolation:true}});
 try{
  await receiptWindow.loadURL("data:text/html;charset=utf-8,"+encodeURIComponent(html));
  await new Promise((resolve,reject)=>receiptWindow.webContents.print({silent:true,printBackground:true},(success,reason)=>success?resolve():reject(new Error(reason||"No se pudo imprimir la comanda."))));
  printedOrderIds.add(id);
  persistPrintedOrderIds();
  return {ok:true,duplicate:false};
 }finally{
  if(!receiptWindow.isDestroyed())receiptWindow.close();
 }
});
ipcMain.handle("pos:open-service",async(_event,service)=>{
 const config=SERVICE_CONFIG[service];
 if(!config)throw new Error("Servicio no permitido.");
 if(service==="whatsapp"){
   await shell.openExternal("https://web.whatsapp.com/");
   return true;
 }
 let serviceWin=serviceWindows.get(service);
 if(serviceWin&&!serviceWin.isDestroyed()){
   if(serviceWin.isMinimized())serviceWin.restore();
   serviceWin.focus();
   return true;
 }
 serviceWin=new BrowserWindow({
   width:1280,height:850,minWidth:900,minHeight:650,
   title:config.title,backgroundColor:"#ffffff",autoHideMenuBar:true,
   webPreferences:{
     partition:config.partition,
     contextIsolation:true,nodeIntegration:false,sandbox:true,
     webSecurity:true
   }
 });
 serviceWindows.set(service,serviceWin);
 serviceWin.webContents.setWindowOpenHandler(({url})=>{
   if(url.startsWith("https://")){shell.openExternal(url);return {action:"deny"};}
   return {action:"deny"};
 });
 serviceWin.webContents.on("will-navigate",(event,url)=>{
   if(!url.startsWith("https://"))event.preventDefault();
 });
 serviceWin.on("closed",()=>serviceWindows.delete(service));
 await serviceWin.loadURL(config.url);
 return true;
});

function validateMenu(data){
 if(!data||!Array.isArray(data.products)||!data.products.length||!Array.isArray(data.categories)||!data.categories.length)throw new Error("Carta incompleta.");
 const categories=new Set(data.categories),seen=new Set();
 for(const p of data.products){if(!p||typeof p.category!=="string"||!p.category.trim()||typeof p.name!=="string"||!p.name.trim())throw new Error("Producto sin nombre o categoría.");if(!categories.has(p.category))throw new Error("Categoría no declarada: "+p.category);if(p.price_clp!==null&&(!Number.isFinite(Number(p.price_clp))||Number(p.price_clp)<0))throw new Error("Precio inválido: "+p.name);const k=p.category+"::"+p.name;if(seen.has(k))throw new Error("Producto duplicado: "+p.name);seen.add(k);}
 return data;
}
ipcMain.handle("pos:load-menu",async()=>{
 const packagedPath=path.join(__dirname,"app","menu.json");
 const cacheDir=path.join(app.getPath("userData"),"menu-cache");
 const cachePath=path.join(cacheDir,"menu.json");
 let localData=null,localError=null;
 for(const localPath of [cachePath,packagedPath]){try{const candidate=validateMenu(JSON.parse(fs.readFileSync(localPath,"utf8")));if(!localData||String(candidate.revision||"")>String(localData.revision||"")){localData=candidate;localData._menuSource=localPath===cachePath?"cache-local":"local-instalado";}}catch(e){localError=e;}}
 const sources=["https://menu-la-pica-del-benjamin.onrender.com/menu.json?v="+Date.now(),"https://raw.githubusercontent.com/quicksandyou/menu-la-pica-del-benjamin/main/menu.json"];
 const errors=[];
 for(const url of sources){const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),5000);try{const response=await net.fetch(url,{signal:controller.signal});if(!response.ok)throw new Error("HTTP "+response.status);const data=validateMenu(await response.json());data._menuSource=url.includes("raw.githubusercontent.com")?"github":"web";try{fs.mkdirSync(cacheDir,{recursive:true});const temp=cachePath+".tmp";fs.writeFileSync(temp,JSON.stringify(data),"utf8");fs.renameSync(temp,cachePath);}catch(cacheError){console.warn("No se pudo actualizar caché de carta:",cacheError.message);}return data;}catch(e){errors.push(url.includes("raw.githubusercontent.com")?"GitHub: "+e.message:"Web: "+e.message);}finally{clearTimeout(timeout);}}
 if(localData){localData._menuWarning=errors.join(" | ");return localData;}
 throw new Error("No se pudo cargar una carta válida. "+errors.join(" | ")+" | copia local: "+(localError?localError.message:"no disponible"));
});

function configureAutoUpdates(){
  if(!app.isPackaged || process.platform!=="win32") return;
  autoUpdater.autoDownload=true;
  autoUpdater.autoInstallOnAppQuit=true;
  autoUpdater.on("error",error=>{
    console.error("Error del actualizador:",error.message);
  });
  autoUpdater.on("update-downloaded",async()=>{
    if(updatePromptOpen || !win || win.isDestroyed()) return;
    updatePromptOpen=true;
    const answer=await dialog.showMessageBox(win,{
      type:"info",
      buttons:["Reiniciar y actualizar","Más tarde"],
      defaultId:1,
      cancelId:1,
      title:"Actualización lista",
      message:"Hay una nueva versión de La Picá del Benjamín lista para instalar.",
      detail:"Guarda o termina el pedido actual antes de reiniciar. La aplicación se actualizará al volver a abrirse."
    });
    updatePromptOpen=false;
    if(answer.response===0) autoUpdater.quitAndInstall(false,true);
  });
  setTimeout(()=>{
    autoUpdater.checkForUpdates().catch(error=>{
      console.error("No se pudo comprobar actualizaciones:",error.message);
    });
  },8000);
}

function createWindow(){
  win=new BrowserWindow({
    width:1440,height:920,minWidth:1100,minHeight:720,
    title:"La Picá del Benjamín",backgroundColor:"#100b07",autoHideMenuBar:true,
    webPreferences:{
      preload:path.join(__dirname,"preload.js"),
      contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true,
      partition:"persist:lapica-local"
    }
  });
  // Inicio directo del POS local, como en la versión anterior.
  win.loadFile(path.join(__dirname,"app","index.html"));
  win.webContents.setWindowOpenHandler(({url})=>{
    if(url.startsWith("https://menu-la-pica-del-benjamin.onrender.com/")||
       url.startsWith("https://menu-la-pica-del-benjamin-pago.onrender.com/")) win.loadURL(url);
    else if(url.startsWith("https://")) shell.openExternal(url);
    return {action:"deny"};
  });
  win.webContents.on("will-navigate",(e,url)=>{
    if(!url.startsWith("file://")&&
       !url.startsWith("https://menu-la-pica-del-benjamin.onrender.com/")&&
       !url.startsWith("https://menu-la-pica-del-benjamin-pago.onrender.com/")) e.preventDefault();
  });
  win.on("closed",()=>win=null);
}
if(gotSingleInstanceLock) app.whenReady().then(()=>{createWindow();configureAutoUpdates();});
app.on("window-all-closed",()=>{if(process.platform!=="darwin")app.quit()});
app.on("activate",()=>{if(BrowserWindow.getAllWindows().length===0)createWindow()});

ipcMain.handle("pos:poll-online-orders",async()=>{
 if(!win||win.isDestroyed())return {ok:false,orders:[]};
 try{
  const localDate=new Intl.DateTimeFormat("en-CA",{timeZone:"America/Santiago",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
  const response=await win.webContents.session.fetch("https://menu-la-pica-del-benjamin-pago.onrender.com/api/reparto/pedidos?date="+localDate,{headers:{"Accept":"application/json"}});
  if(!response.ok)return {ok:false,status:response.status,orders:[]};
  const data=await response.json(),orders=Array.isArray(data.orders)?data.orders:[];
  return {ok:true,orders:orders.filter(o=>String(o.source||"online").toLowerCase()==="online").map(o=>({id:o.id,order_number:o.order_number,customer_name:o.customer_name,customer_phone:o.customer_phone,delivery_method:o.delivery_method,delivery_address:o.delivery_address,locality:o.locality,total_clp:o.total_clp,payment_status:o.payment_status,created_at:o.created_at,items_json:o.items_json,notes:o.notes}))};
 }catch(error){console.warn("No se pudieron consultar pedidos web:",error.message);return {ok:false,orders:[]};}
});
