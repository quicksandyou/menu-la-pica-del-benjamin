const {app,BrowserWindow,shell,dialog,ipcMain,net,Tray,Menu,nativeImage,safeStorage}=require("electron");
const {autoUpdater}=require("electron-updater");
// Permite que las alertas sonoras del POS funcionen automáticamente, sin clic previo del usuario.
app.commandLine.appendSwitch("autoplay-policy","no-user-gesture-required");
const path=require("path");
const fs=require("fs");
let win;
let tray=null;
let allowAppQuit=false;
let updatePromptOpen=false;
const serviceWindows=new Map();
const SERVICE_CONFIG={
 gmail:{url:"https://mail.google.com/mail/u/?authuser=lapicadadelbenjamin%40gmail.com",title:"Gmail · lapicadadelbenjamin@gmail.com",partition:"persist:lapica-gmail"},
 whatsapp:{url:"https://web.whatsapp.com/",title:"WhatsApp | La Picá del Benjamín",partition:"persist:lapica-whatsapp"}
};

const printedOrderIds=new Set();
const printedOrdersFile=path.join(app.getPath("userData"),"printed-web-orders.json");
const posDeviceTokenFile=path.join(app.getPath("userData"),"pos-device-token.enc");
function readPosDeviceToken(){try{if(!safeStorage.isEncryptionAvailable())return null;const encrypted=fs.readFileSync(posDeviceTokenFile,"utf8");return safeStorage.decryptString(Buffer.from(encrypted,"base64"));}catch(_){return null;}}
function savePosDeviceToken(token){if(!safeStorage.isEncryptionAvailable())throw new Error("El almacenamiento seguro de Windows no está disponible.");fs.writeFileSync(posDeviceTokenFile,safeStorage.encryptString(token).toString("base64"),{mode:0o600});}
try{for(const id of JSON.parse(fs.readFileSync(printedOrdersFile,"utf8")))printedOrderIds.add(String(id));}catch(_){}
function persistPrintedOrderIds(){try{fs.writeFileSync(printedOrdersFile,JSON.stringify([...printedOrderIds].slice(-2000)),"utf8");}catch(e){console.warn("No se pudo guardar historial de comandas:",e.message);}}
function escapeReceipt(value){return String(value??"").replace(/[&<>"']/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));}
ipcMain.handle("pos:print-web-order",async(_event,order)=>{
 if(!order||!order.id)throw new Error("Pedido inválido para impresión.");
 const id=String(order.id);
 if(printedOrderIds.has(id))return {ok:true,duplicate:true};
 const items=Array.isArray(order.items_json)?order.items_json:(()=>{try{return JSON.parse(order.items_json||"[]")}catch(_){return []}})();
 const rows=items.map(item=>'<div class="item"><span>'+escapeReceipt(item.quantity||item.qty||1)+' × '+escapeReceipt(item.name||item.product||item.title||"Producto")+'</span></div>').join("");
 const html='<!doctype html><html lang="es"><meta charset="utf-8"><style>@page{size:80mm auto;margin:0}html,body{width:80mm;margin:0;padding:0;background:#fff;color:#000;font:13px/1.35 Arial,sans-serif}body{padding:4mm;box-sizing:border-box}h2{text-align:center;font-size:18px;margin:0 0 3mm}.center{text-align:center}.line{border-top:1px dashed #333;margin:3mm 0}.item{padding:2mm 0;border-bottom:1px dashed #bbb;overflow-wrap:anywhere}.small{font-size:11px}.total{font-size:17px;font-weight:bold;text-align:right;margin-top:3mm}b{font-weight:700}</style><h2>LA PICÁ DEL BENJAMÍN</h2><div class="center"><b>COMANDA WEB</b><br>'+escapeReceipt(order.order_number||("Pedido #"+id))+'</div><div class="line"></div><p><b>Fecha:</b> '+escapeReceipt(order.created_at?new Date(order.created_at).toLocaleString("es-CL",{timeZone:"America/Santiago"}):new Date().toLocaleString("es-CL"))+'</p><p><b>Cliente:</b> '+escapeReceipt(order.customer_name||"Sin nombre")+'</p><p><b>Teléfono:</b> '+escapeReceipt(order.customer_phone||"No informado")+'</p><p><b>Modalidad:</b> '+escapeReceipt(order.delivery_method||"No informada")+'</p><p><b>Dirección:</b> '+escapeReceipt([order.delivery_address,order.locality].filter(Boolean).join(", ")||"Retiro en local")+'</p><div class="line"></div><b>PRODUCTOS</b>'+rows+'<div class="line"></div><div class="total">TOTAL: '+Number(order.total_clp||0).toLocaleString("es-CL")+'</div><p class="small"><b>Pago:</b> '+escapeReceipt(order.payment_status||"pendiente")+'</p><p class="small"><b>Observaciones:</b> '+escapeReceipt(order.notes||"Sin observaciones")+'</p><div class="line"></div><div class="center small">Comanda automática · La Picá del Benjamín</div></html>';
 const printWin=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
 try{
  await printWin.loadURL("data:text/html;charset=utf-8,"+encodeURIComponent(html));
  const result=await new Promise((resolve,reject)=>printWin.webContents.print({silent:true,printBackground:true},(success,failureReason)=>success?resolve(true):reject(new Error(failureReason||"La impresora no aceptó la comanda."))));
  printedOrderIds.add(id);persistPrintedOrderIds();return {ok:result,duplicate:false};
 }finally{if(!printWin.isDestroyed())printWin.close();}
});

ipcMain.handle("pos:open-staff",async()=>{
 const service="staff";
 let staffWin=serviceWindows.get(service);
 if(staffWin&&!staffWin.isDestroyed()){
  if(staffWin.isMinimized())staffWin.restore();
  staffWin.focus();
  return true;
 }
 staffWin=new BrowserWindow({
  width:1440,height:950,minWidth:1000,minHeight:700,
  title:"Repartidor / Jefatura · La Picá del Benjamín",
  backgroundColor:"#100b07",autoHideMenuBar:true,
  webPreferences:{preload:path.join(__dirname,"preload.js"),partition:"persist:lapica-local",contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true}
 });
 serviceWindows.set(service,staffWin);
 staffWin.webContents.setWindowOpenHandler(({url})=>{
  if(url.startsWith("https://menu-la-pica-del-benjamin-pago.onrender.com/"))return {action:"allow"};
  if(url.startsWith("https://")){shell.openExternal(url);return {action:"deny"};}
  return {action:"deny"};
 });
 staffWin.webContents.on("will-navigate",(event,url)=>{
  if(!url.startsWith("https://menu-la-pica-del-benjamin-pago.onrender.com/"))event.preventDefault();
 });
 staffWin.webContents.on("did-fail-load",(_event,errorCode,errorDescription,validatedURL)=>{
  console.warn("No se pudo cargar el panel de personal:",errorCode,errorDescription,validatedURL);
 });
 staffWin.on("closed",()=>serviceWindows.delete(service));
 await staffWin.loadURL("https://menu-la-pica-del-benjamin-pago.onrender.com/personal.html?desktopPos=1");
 return true;
});

ipcMain.handle("pos:open-test-mode",async()=>{
 const service="test-mode";
 let testWin=serviceWindows.get(service);
 if(testWin&&!testWin.isDestroyed()){if(testWin.isMinimized())testWin.restore();testWin.focus();return true;}
 testWin=new BrowserWindow({width:1280,height:900,minWidth:1000,minHeight:700,title:"Acceso Jefatura · Modo de prueba",backgroundColor:"#100b07",autoHideMenuBar:true,webPreferences:{partition:"persist:lapica-local",contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true}});
 serviceWindows.set(service,testWin);
 testWin.webContents.setWindowOpenHandler(({url})=>url.startsWith("https://menu-la-pica-del-benjamin-pago.onrender.com/")?{action:"allow"}:{action:"deny"});
 testWin.webContents.on("will-navigate",(event,url)=>{if(!url.startsWith("https://menu-la-pica-del-benjamin-pago.onrender.com/"))event.preventDefault();});
 testWin.on("closed",()=>serviceWindows.delete(service));
 await testWin.loadURL("https://menu-la-pica-del-benjamin-pago.onrender.com/personal.html");
 return true;
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
  win.on("close",(event)=>{if(!allowAppQuit){event.preventDefault();win.hide();if(tray)tray.displayBalloon?.({title:"La Picá del Benjamín",content:"El POS sigue activo en segundo plano y avisará cuando llegue un pedido."});}});
  win.on("closed",()=>win=null);
}

function showMainWindow(){if(!win||win.isDestroyed())createWindow();else{if(win.isMinimized())win.restore();win.show();win.focus();}}
function createTray(){
 if(tray)return;
 const iconPath=path.join(__dirname,"build","icon.ico");
 let icon=nativeImage.createFromPath(iconPath);
 if(icon.isEmpty())icon=nativeImage.createEmpty();
 tray=new Tray(icon);
 tray.setToolTip("La Picá del Benjamín · Avisos de pedidos activos");
 tray.setContextMenu(Menu.buildFromTemplate([
  {label:"Abrir POS",click:showMainWindow},
  {label:"Estado: avisos activos",enabled:false},
  {type:"separator"},
  {label:"Salir completamente",click:()=>{allowAppQuit=true;app.quit();}}
 ]));
 tray.on("double-click",showMainWindow);
}
app.whenReady().then(()=>{createTray();createWindow();configureAutoUpdates();});
app.on("window-all-closed",()=>{ /* Se mantiene activo en la bandeja del sistema. */ });
app.on("before-quit",()=>{allowAppQuit=true;});
app.on("activate",()=>showMainWindow());

ipcMain.handle("pos:enroll-device",async()=>{
 const staffWin=serviceWindows.get("staff");
 if(!staffWin||staffWin.isDestroyed())throw new Error("Abre el portal de Jefatura e inicia sesión primero.");
 const base="https://menu-la-pica-del-benjamin-pago.onrender.com";
 const cookies=await staffWin.webContents.session.cookies.get({url:base});
 const cookieHeader=cookies.map(c=>c.name+"="+c.value).join("; ");
 if(!cookieHeader.includes("pb_session="))throw new Error("No se encontró la sesión de Jefatura. Inicia sesión nuevamente.");
 const responseData=await new Promise((resolve,reject)=>{
  const request=net.request({method:"POST",url:base+"/api/personal/pos-device/issue",session:staffWin.webContents.session,headers:{"Accept":"application/json","Content-Type":"application/json","Cookie":cookieHeader}});
  request.on("response",response=>{let raw="";response.on("data",chunk=>raw+=chunk.toString());response.on("end",()=>{let body={};try{body=JSON.parse(raw||"{}");}catch{}resolve({status:response.statusCode,body});});});
  request.on("error",reject);request.write(JSON.stringify({device_name:require("os").hostname()+" · POS Windows"}));request.end();
 });
 if(responseData.status<200||responseData.status>=300)throw new Error(responseData.body.error||"El servidor no autorizó este equipo.");
 if(!/^[a-f0-9]{64}$/i.test(responseData.body.device_token||""))throw new Error("El servidor devolvió una autorización inválida.");
 savePosDeviceToken(responseData.body.device_token);
 return {ok:true,device_name:responseData.body.device_name||"POS Windows"};
});
ipcMain.handle("pos:poll-online-orders",async()=>{
 if(!win||win.isDestroyed())return {ok:false,orders:[],error:"POS no disponible"};
 try{
  const base="https://menu-la-pica-del-benjamin-pago.onrender.com";
  const localDate=new Intl.DateTimeFormat("en-CA",{timeZone:"America/Santiago",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
  const deviceToken=readPosDeviceToken();
  let requestUrl,headers={"Accept":"application/json"};
  if(deviceToken){requestUrl=base+"/api/pos/device-orders?date="+localDate;headers.Authorization="Bearer "+deviceToken;}
  else{
   const cookies=await win.webContents.session.cookies.get({url:base});
   const cookieHeader=cookies.map(c=>c.name+"="+c.value).join("; ");
   if(!cookieHeader.includes("pb_session="))return {ok:false,orders:[],status:401,error:"Este POS aún no está autorizado. Inicia sesión una vez como Jefatura y autoriza este equipo."};
   requestUrl=base+"/api/reparto/pedidos?date="+localDate;headers.Cookie=cookieHeader;
  }
  const responseData=await new Promise((resolve,reject)=>{
   const request=net.request({method:"GET",url:requestUrl,session:win.webContents.session,headers});
   request.on("response",response=>{let raw="";response.on("data",chunk=>raw+=chunk.toString());response.on("end",()=>{let body={};try{body=JSON.parse(raw||"{}");}catch{}resolve({status:response.statusCode,body});});});
   request.on("error",reject);request.end();
  });
  const data=responseData.body;
  if(responseData.status<200||responseData.status>=300)return {ok:false,status:responseData.status,orders:[],error:data.error||"El servidor rechazó la consulta de pedidos."};
  const orders=Array.isArray(data.orders)?data.orders:[];
  return {ok:true,orders:orders.filter(o=>String(o.source||"online").toLowerCase()==="online").map(o=>({id:o.id,order_number:o.order_number,customer_name:o.customer_name,customer_phone:o.customer_phone,delivery_method:o.delivery_method,delivery_address:o.delivery_address,locality:o.locality,total_clp:o.total_clp,payment_status:o.payment_status,created_at:o.created_at,items_json:o.items_json,notes:o.notes}))};
 }catch(error){console.warn("No se pudieron consultar pedidos web:",error.message);return {ok:false,orders:[],error:error.message};}
});
