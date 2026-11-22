const {app,BrowserWindow,shell,dialog,ipcMain,net}=require("electron");
const {execFile}=require("child_process");
const {promisify}=require("util");
const execFileAsync=promisify(execFile);
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
 whatsapp:{url:"https://web.whatsapp.com/",title:"WhatsApp | La Picá del Benjamín",partition:"persist:lapica-whatsapp"},
 youtubeMusic:{url:"https://music.youtube.com/",title:"YouTube Music · La Picá del Benjamín",partition:"persist:lapica-youtube-music"}
};

const printedOrderIds=new Set();
const printedOrdersFile=path.join(app.getPath("userData"),"printed-web-orders.json");
const printerSettingsFile=path.join(app.getPath("userData"),"printer-settings.json");
const screenSettingsFile=path.join(app.getPath("userData"),"screen-settings.json");
let savedScreenSettings={width:1440,height:920,fullscreen:false};
try{const candidate=JSON.parse(fs.readFileSync(screenSettingsFile,"utf8"));const validSizes=[[800,600],[1024,768],[1280,720],[1280,1024],[1366,768],[1440,900],[1440,920],[1600,900],[1920,1080]];if(validSizes.some(([w,h])=>candidate.width===w&&candidate.height===h))savedScreenSettings={width:candidate.width,height:candidate.height,fullscreen:!!candidate.fullscreen};}catch(_){}
function persistScreenSettings(){try{fs.mkdirSync(path.dirname(screenSettingsFile),{recursive:true});fs.writeFileSync(screenSettingsFile,JSON.stringify(savedScreenSettings,null,2),"utf8");}catch(e){console.warn("No se pudo guardar configuración de pantalla:",e.message);}}
let selectedPrinterName="";
let printerMode="manual";
try{
 const savedPrinterSettings=JSON.parse(fs.readFileSync(printerSettingsFile,"utf8"));
 selectedPrinterName=String(savedPrinterSettings.selectedPrinter||"");
 printerMode=savedPrinterSettings.mode==="automatic"?"automatic":"manual";
}catch(_){}
function persistPrinterSettings(){
 fs.mkdirSync(path.dirname(printerSettingsFile),{recursive:true});
 fs.writeFileSync(printerSettingsFile,JSON.stringify({selectedPrinter:selectedPrinterName,mode:printerMode,updatedAt:new Date().toISOString()},null,2),"utf8");
}
function persistPrinterSelection(name){selectedPrinterName=String(name||"");persistPrinterSettings();}
function persistPrinterMode(mode){printerMode=mode==="automatic"?"automatic":"manual";persistPrinterSettings();}
try{for(const id of JSON.parse(fs.readFileSync(printedOrdersFile,"utf8")))printedOrderIds.add(String(id));}catch(_){}
function persistPrintedOrderIds(){try{fs.writeFileSync(printedOrdersFile,JSON.stringify([...printedOrderIds].slice(-2000)),"utf8");}catch(e){console.warn("No se pudo guardar historial de comandas:",e.message);}}

let printQueueTail=Promise.resolve();
function runPrintExclusive(job){const next=printQueueTail.then(job,job);printQueueTail=next.catch(()=>{});return next;}
function escposClean(value){return String(value??"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/[^\x20-\x7E]/g," ").replace(/\s+/g," ").trim();}
function escposLine(value){return Buffer.from(escposClean(value)+"\n","ascii");}
async function printEscPosRaw(lines){
 const printer="80mm Series Printer",chunks=[Buffer.from([0x1b,0x40,0x1b,0x61,0x01,0x1b,0x45,0x01])];
 for(const line of lines)chunks.push(escposLine(line));
 chunks.push(Buffer.from([0x1b,0x45,0x00,0x1b,0x61,0x00,0x0a,0x0a,0x0a]));
 const payload=Buffer.concat(chunks).toString("base64");
 const ps=["$ErrorActionPreference='Stop'","Add-Type -TypeDefinition @'","using System;","using System.Runtime.InteropServices;","public class RawPosPrinter {",
 " [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public class DOCINFO { [MarshalAs(UnmanagedType.LPWStr)] public string pDocName; [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile; [MarshalAs(UnmanagedType.LPWStr)] public string pDataType; }",
 " [DllImport(\"winspool.drv\", SetLastError=true, CharSet=CharSet.Unicode)] public static extern bool OpenPrinter(string name, out IntPtr handle, IntPtr defaults);",
 " [DllImport(\"winspool.drv\", SetLastError=true)] public static extern bool ClosePrinter(IntPtr handle);",
 " [DllImport(\"winspool.drv\", SetLastError=true, CharSet=CharSet.Unicode)] public static extern int StartDocPrinter(IntPtr handle, int level, [In] DOCINFO info);",
 " [DllImport(\"winspool.drv\", SetLastError=true)] public static extern bool EndDocPrinter(IntPtr handle);",
 " [DllImport(\"winspool.drv\", SetLastError=true)] public static extern bool StartPagePrinter(IntPtr handle);",
 " [DllImport(\"winspool.drv\", SetLastError=true)] public static extern bool EndPagePrinter(IntPtr handle);",
 " [DllImport(\"winspool.drv\", SetLastError=true)] public static extern bool WritePrinter(IntPtr handle, byte[] bytes, int count, out int written);","}","'@",
 "$printer='80mm Series Printer'","$bytes=[Convert]::FromBase64String('" + payload + "')","$h=[IntPtr]::Zero",
 "if(-not [RawPosPrinter]::OpenPrinter($printer,[ref]$h,[IntPtr]::Zero)){throw \"OpenPrinter fallo: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())\"}",
 "$doc=New-Object RawPosPrinter+DOCINFO","$doc.pDocName='La Pica - Comanda ESC POS'; $doc.pDataType='RAW'","$id=[RawPosPrinter]::StartDocPrinter($h,1,$doc)",
 "if($id -eq 0){[void][RawPosPrinter]::ClosePrinter($h);throw \"StartDocPrinter fallo: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())\"}",
 "try {"," if(-not [RawPosPrinter]::StartPagePrinter($h)){throw \"StartPagePrinter fallo: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())\"}",
 " $written=0"," if(-not [RawPosPrinter]::WritePrinter($h,$bytes,$bytes.Length,[ref]$written)){throw \"WritePrinter fallo: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())\"}",
 " if($written -ne $bytes.Length){throw \"Escritura incompleta: $written de $($bytes.Length) bytes\"}",
 " [void][RawPosPrinter]::EndPagePrinter($h); [void][RawPosPrinter]::EndDocPrinter($h)"," Write-Output \"RAW_OK:$written\"","} finally { [void][RawPosPrinter]::ClosePrinter($h) }"].join("\n");
 const encoded=Buffer.from(ps,"utf16le").toString("base64");
 const result=await execFileAsync("powershell.exe",["-NoProfile","-NonInteractive","-EncodedCommand",encoded],{windowsHide:true,timeout:15000,maxBuffer:1024*1024});
 if(!String(result.stdout||"").includes("RAW_OK:"))throw new Error(String(result.stderr||result.stdout||"Windows no confirmó el envío RAW").trim());
 return {printer,method:"ESC/POS RAW",message:String(result.stdout).trim()};
}

function escapeReceipt(value){return String(value??"").replace(/[&<>"']/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));}
async function findThermalPrinter(webContents){
 const printers=await webContents.getPrintersAsync();
 if(selectedPrinterName){
  const found=printers.find(p=>String(p.name||"").trim().toLowerCase()===selectedPrinterName.trim().toLowerCase());
  if(found)return found.name;
  throw new Error("La impresora configurada («"+selectedPrinterName+"») no está disponible. Abre Configuraciones → Dispositivos y selecciona una impresora conectada.");
 }
 const defaultPrinter=printers.find(p=>p.isDefault);
 if(defaultPrinter)return defaultPrinter.name;
 throw new Error("No hay impresoras instaladas o disponibles en Windows. Abre Configuraciones → Dispositivos para detectarlas.");
}
async function printHtmlToThermalPrinter(receiptWindow,html,label,options={}){
 await receiptWindow.loadURL("data:text/html;charset=utf-8,"+encodeURIComponent(html));
 const printerName=options.useNamedThermalPrinter?await findThermalPrinter(receiptWindow.webContents):null;
 const printOptions={silent:!options.systemDialog,printBackground:true};
 if(options.systemDialog){receiptWindow.show();receiptWindow.focus();}
 if(printerName)printOptions.deviceName=printerName;
 await new Promise((resolve,reject)=>{
  let settled=false;
  const finish=(error)=>{
   if(settled)return;
   settled=true;
   clearTimeout(timeout);
   error?reject(error):resolve();
  };
  const timeout=setTimeout(()=>finish(new Error("Windows no respondió a la impresión en 20 segundos. Revisa la cola de impresión y vuelve a intentarlo.")),20000);
  try{
   receiptWindow.webContents.print(printOptions,(success,reason)=>{
    if(success)finish();
    else finish(new Error(reason||"Windows no pudo completar la impresión."));
   });
  }catch(error){finish(error);}
 });
 console.log(label+" enviado a "+(printerName||"la impresora predeterminada de Windows"));
 return printerName||"Impresora predeterminada de Windows";
}
ipcMain.handle("pos:list-printers",async()=>{
 if(!win||win.isDestroyed())throw new Error("La ventana del POS no está disponible.");
 const printers=await win.webContents.getPrintersAsync();
 return {printers:printers.map(p=>({name:p.name,isDefault:!!p.isDefault,status:p.status||""})),selected:selectedPrinterName,defaultPrinter:printers.find(p=>p.isDefault)?.name||"",mode:printerMode};
});
ipcMain.handle("pos:save-printer",async(_event,name)=>{
 const requested=String(name||"").trim();
 if(!requested)throw new Error("Nombre de impresora vacío.");
 if(!win||win.isDestroyed())throw new Error("La ventana del POS no está disponible.");
 const printers=await win.webContents.getPrintersAsync();
 const found=printers.find(p=>p.name===requested);
 if(!found)throw new Error("La impresora ya no aparece instalada en Windows. Actualiza la lista.");
 persistPrinterSelection(found.name);
 return {ok:true,selected:found.name};
});
ipcMain.handle("pos:save-printer-mode",async(_event,mode)=>{
 const requested=mode==="automatic"?"automatic":"manual";
 if(requested==="automatic"){
  if(!win||win.isDestroyed())throw new Error("La ventana del POS no está disponible.");
  const printers=await win.webContents.getPrintersAsync();
  if(!selectedPrinterName&&!printers.some(p=>p.isDefault))throw new Error("Selecciona una impresora o define una impresora predeterminada de Windows antes de activar el modo automático.");
 }
 persistPrinterMode(requested);
 return {ok:true,mode:printerMode};
});
ipcMain.handle("pos:test-printer",async(_event,name)=>runPrintExclusive(async()=>{
 const requested=String(name||"").trim();
 if(!requested)throw new Error("Selecciona una impresora.");
 if(!win||win.isDestroyed())throw new Error("La ventana del POS no está disponible.");
 const printers=await win.webContents.getPrintersAsync();
 if(!printers.some(p=>p.name===requested))throw new Error("La impresora no está disponible en Windows.");
 const testWindow=new BrowserWindow({show:false,width:400,height:300,webPreferences:{nodeIntegration:false,contextIsolation:true}});
 try{
  const html="<!doctype html><html><head><meta charset='utf-8'><style>@page{size:80mm auto;margin:0}body{width:72mm;margin:0;padding:4mm;font:14px Arial;text-align:center;color:#000}.title{font-size:19px;font-weight:bold;margin:8px 0}.rule{border-top:1px dashed #333;margin:12px 0}</style></head><body><div class='title'>LA PICÁ DEL BENJAMÍN</div><div class='rule'></div><h2>PRUEBA DE IMPRESIÓN</h2><p>La impresora está configurada correctamente.</p><div class='rule'></div><p>"+escapeReceipt(requested)+"</p><p>"+new Date().toLocaleString("es-CL")+"</p></body></html>";
  await testWindow.loadURL("data:text/html;charset=utf-8,"+encodeURIComponent(html));
  await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error("Tiempo de espera agotado al imprimir la prueba.")),20000);testWindow.webContents.print({silent:true,printBackground:true,deviceName:requested},(ok,reason)=>{clearTimeout(timeout);ok?resolve():reject(new Error(reason||"Windows rechazó la impresión."));});});
  return {ok:true,printer:requested};
 }finally{if(!testWindow.isDestroyed())testWindow.close();}
}));
ipcMain.handle("pos:print-local-receipt",(_event,payload)=>runPrintExclusive(async()=>{
 const content=String(payload?.html||"").trim();
 if(!content)return {ok:false,error:"La comanda está vacía."};
 const receiptWindow=new BrowserWindow({show:false,width:420,height:900,autoHideMenuBar:true,webPreferences:{nodeIntegration:false,contextIsolation:true}});
 try{
  const html=`<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Comanda local</title><style>
  @page{size:80mm auto;margin:0}*{box-sizing:border-box}
  html,body{width:80mm;margin:0;padding:0;background:#fff;color:#000}
  body{padding:2mm;font:11px/1.2 Arial,Helvetica,sans-serif;font-weight:700}
  .ticket-brand{text-align:center;font-size:15px;line-height:1.15;font-weight:900}
  .ticket-brand-sub{text-align:center;font-size:9px;font-weight:700;margin:1px 0}
  .ticket-type{text-align:center;font-size:10px;font-weight:900;margin-top:3px}
  .ticket-order{text-align:center;font-size:16px;line-height:1.1;font-weight:900;margin:2px 0}
  .ticket-rule{border-top:1px dashed #333;margin:3px 0}
  .ticket-meta{display:flex;justify-content:space-between;gap:4px;font-size:9px;font-weight:700}
  .ticket-section{font-size:10px;line-height:1.15;font-weight:900;margin:3px 0 2px}
  .ticket-customer{font-size:11px;font-weight:900;line-height:1.2}
  .ticket-method{display:inline-block;font-size:10px;font-weight:800}
  .ticket-item{padding:3px 0;border-bottom:1px dashed #555;break-inside:avoid}
  .ticket-item-main{display:flex;gap:4px;font-size:12px;font-weight:900;line-height:1.15}
  .ticket-qty{font-size:12px;font-weight:900;min-width:25px}
  .ticket-product{text-transform:uppercase;font-size:12px;font-weight:900;line-height:1.15;overflow-wrap:anywhere}
  .ticket-item-price{text-align:right;font-size:10px;font-weight:900;margin-top:1px}
  .ticket-total{display:flex;justify-content:space-between;font-size:16px;line-height:1.15;font-weight:900;margin:4px 0}
  .ticket-notes{border:1px solid #333;padding:3px;font-size:10px;line-height:1.2;font-weight:900;white-space:pre-wrap}
  .ticket-footer{text-align:center;font-size:9px;font-weight:700;margin-top:4px;line-height:1.2}
  .ticket-footer strong{font-size:10px;font-weight:900}
  </style></head><body>${content}</body></html>`;
  await receiptWindow.loadURL("data:text/html;charset=utf-8,"+encodeURIComponent(html));
  const printerName=await findThermalPrinter(receiptWindow.webContents);
  await new Promise((resolve,reject)=>{
   const timeout=setTimeout(()=>reject(new Error("Windows no respondió a la impresión en 20 segundos.")),20000);
   try{receiptWindow.webContents.print({silent:true,printBackground:true,deviceName:printerName},(success,reason)=>{clearTimeout(timeout);success?resolve():reject(new Error(reason||"Windows no pudo completar la impresión."));});}
   catch(error){clearTimeout(timeout);reject(error);}
  });
  return {ok:true,method:"Impresión automática",printer:printerName};
 }catch(error){console.error("Error impresión local POS:",error);return {ok:false,error:error.message||"Error de impresión"};}
 finally{if(!receiptWindow.isDestroyed())receiptWindow.close();}
}));
ipcMain.handle("pos:print-web-order",(_event,order)=>runPrintExclusive(async()=>{
 if(!order||!order.id)throw new Error("Pedido inválido para impresión.");
 const id=String(order.id);
 if(printedOrderIds.has(id)&&!order._reprint)return {ok:true,duplicate:true};
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
 
 /* Comanda 80mm unificada: tipografía grande y alto contraste */
 body{font:15px/1.4 Arial,Helvetica,sans-serif}
 .brand{font-size:21px}
 .brand-sub{font-size:12px;letter-spacing:1.5px}
 .ticket-type{font-size:14px;font-weight:900}
 .order{font-size:25px}
 .meta{font-size:12px}
 .section-title{font-size:14px}
 .customer{font-size:15px}
 .customer strong{font-size:16px}
 .method{font-size:13px}
 .item{padding:8px 0}
 .item-main{font-size:15px;font-weight:800;line-height:1.4}
 .qty{min-width:31px}
 .item-detail{font-size:13px}
 .item-price{font-size:14px}
 .total-row{font-size:21px}
 .notes{font-size:14px;line-height:1.4;padding:8px}
 .footer{font-size:12px}
 .footer strong{font-size:14px}
 
 /* Diseño unificado de comanda 80mm: prioridad absoluta al pedido */
 .ticket-type{font-size:16px;font-weight:900;letter-spacing:1px}
 .section-title{font-size:15px;font-weight:900}
 .customer,.customer strong{font-size:15px;font-weight:900;line-height:1.5}
 .item{padding:10px 0;border-bottom:2px solid #222}
 .item-main{font-size:18px;font-weight:900;line-height:1.3}
 .qty{font-size:19px;font-weight:900;min-width:36px}
 .product{text-transform:uppercase;font-size:18px;font-weight:900}
 .item-detail{text-transform:uppercase;font-size:14px;font-weight:800;color:#111}
 .item-price{font-size:15px;font-weight:900}
 .total-row{font-size:25px;font-weight:900;margin:13px 0}
 .notes{font-size:15px;font-weight:800;line-height:1.45}
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
  const printerName=await printHtmlToThermalPrinter(receiptWindow,html,"Comanda web/APK",{systemDialog:true});
  const sent={printer:printerName,method:"Windows/Electron · formato 80mm"};
  console.log("Comanda web/APK enviada:",sent);printedOrderIds.add(id);
  persistPrintedOrderIds();
  return {ok:true,duplicate:false,printer:sent.printer,method:sent.method};
 }finally{
  if(!receiptWindow.isDestroyed())receiptWindow.close();
 }
}));
ipcMain.handle("pos:poll-remote-print-jobs",async()=>{
 if(!win||win.isDestroyed())return {ok:false,jobs:[],error:"POS no disponible."};
 try{
  const response=await win.webContents.session.fetch("https://menu-la-pica-del-benjamin-pago.onrender.com/api/remoto/cola",{credentials:"include",headers:{"Accept":"application/json"}});
  const data=await response.json().catch(()=>({}));
  if(!response.ok)return {ok:false,jobs:[],error:data.error||("Cola remota HTTP "+response.status)};
  return {ok:true,jobs:Array.isArray(data.jobs)?data.jobs:[]};
 }catch(error){return {ok:false,jobs:[],error:error.message||"No se pudo consultar la cola remota."};}
});
ipcMain.handle("pos:ack-remote-print-job",async(_event,payload={})=>{
 if(!win||win.isDestroyed())return {ok:false,error:"POS no disponible."};
 const jobId=Number(payload.job_id),status=String(payload.status||""),note=String(payload.note||"").slice(0,300);
 if(!Number.isSafeInteger(jobId)||jobId<1||!["printed","failed"].includes(status))return {ok:false,error:"Resultado de trabajo remoto inválido."};
 try{
  const response=await win.webContents.session.fetch("https://menu-la-pica-del-benjamin-pago.onrender.com/api/remoto/resultado",{method:"POST",credentials:"include",headers:{"Accept":"application/json","Content-Type":"application/json"},body:JSON.stringify({job_id:jobId,status,note})});
  const data=await response.json().catch(()=>({}));
  if(!response.ok)return {ok:false,error:data.error||("Confirmación HTTP "+response.status)};
  return {ok:true};
 }catch(error){return {ok:false,error:error.message||"No se pudo confirmar el trabajo remoto."};}
});
ipcMain.handle("pos:print-remote-order",(_event,job)=>runPrintExclusive(async()=>{
 if(!job||!job.id)throw new Error("Trabajo remoto inválido.");
 const id="remote-"+String(job.id);
 if(printedOrderIds.has(id))return {ok:true,duplicate:true};
 const payload=job.payload_json&&typeof job.payload_json==="object"?job.payload_json:{};
 const money=value=>"$"+Number(value||0).toLocaleString("es-CL");
 const orderText=String(payload.order||"Pedido remoto").trim();
 const items=orderText.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
 const rows=items.map((item,index)=>'<div class="item"><div class="item-main"><span class="qty">'+(items.length>1?(index+1)+'.':'')+'</span><span class="product">'+escapeReceipt(item)+'</span></div></div>').join("");
 const created=payload.created_at?new Date(payload.created_at).toLocaleString("es-CL",{timeZone:"America/Santiago"}):new Date().toLocaleString("es-CL",{timeZone:"America/Santiago"});
 const html=`<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Comanda remota</title><style>
 @page{size:80mm auto;margin:0}*{box-sizing:border-box}html,body{width:80mm;margin:0;padding:0;background:#fff;color:#111}body{padding:4mm;font:15px/1.4 Arial,Helvetica,sans-serif}.brand{text-align:center;font-size:21px;font-weight:900}.brand-sub{text-align:center;font-size:12px;letter-spacing:1.5px;margin-top:2px}.ticket-type{text-align:center;font-size:16px;font-weight:900;margin-top:9px}.order{text-align:center;font-size:25px;font-weight:900;margin:3px 0 7px}.rule{border-top:1px dashed #333;margin:8px 0}.meta{font-size:12px}.section-title{font-size:15px;font-weight:900;margin:7px 0 5px}.customer{font-size:15px;font-weight:900;line-height:1.5}.item{padding:10px 0;border-bottom:2px solid #222}.item-main{font-size:18px;font-weight:900;line-height:1.3;display:flex;gap:5px}.qty{font-size:18px;min-width:18px}.product{text-transform:uppercase;font-size:18px;font-weight:900;overflow-wrap:anywhere}.total-row{display:flex;justify-content:space-between;font-size:25px;font-weight:900;margin:13px 0}.notes{font-size:15px;font-weight:800;line-height:1.45;border:1px solid #333;padding:8px;white-space:pre-wrap;overflow-wrap:anywhere}.footer{text-align:center;font-size:12px;margin-top:12px}.footer strong{font-size:14px}</style></head><body><div class="brand">LA PICÁ DEL BENJAMÍN</div><div class="brand-sub">SABOR QUE SE COMPARTE</div><div class="ticket-type">COMANDA REMOTA</div><div class="order">REM-${escapeReceipt(job.id)}</div><div class="meta"><strong>FECHA</strong> ${escapeReceipt(created)}<br><strong>ENVIADO POR</strong> ${escapeReceipt(payload.sender||"Personal autorizado")}</div><div class="rule"></div><div class="section-title">DATOS DEL CLIENTE</div><div class="customer">${escapeReceipt(payload.name||"Sin nombre")}<br>Tel: ${escapeReceipt(payload.phone||"No informado")}<br>${escapeReceipt(payload.address||"Dirección no informada")}</div><div class="rule"></div><div class="section-title">DETALLE DEL PEDIDO</div>${rows||'<div class="item">Sin detalle</div>'}<div class="rule"></div><div class="total-row"><span>TOTAL</span><span>${money(payload.total_clp)}</span></div>${payload.notes?'<div class="section-title">OBSERVACIONES PARA COCINA</div><div class="notes">'+escapeReceipt(payload.notes)+'</div>':""}<div class="rule"></div><div class="footer"><strong>¡GRACIAS POR TU COMPRA!</strong><br>La Picá del Benjamín</div></body></html>`;
 const receiptWindow=new BrowserWindow({show:false,width:400,height:800,webPreferences:{nodeIntegration:false,contextIsolation:true}});
 try{
  const printerName=await printHtmlToThermalPrinter(receiptWindow,html,"Comanda remota",{systemDialog:false,useNamedThermalPrinter:true});
  printedOrderIds.add(id);persistPrintedOrderIds();
  return {ok:true,printer:printerName};
 }finally{if(!receiptWindow.isDestroyed())receiptWindow.close();}
}));
let youtubeMusicRestoreTimer=null;
ipcMain.handle("pos:duck-youtube-music",async(_event,durationMs=4500)=>{
 const musicWin=serviceWindows.get("youtubeMusic");
 if(!musicWin||musicWin.isDestroyed())return {ok:false,reason:"not-open"};
 clearTimeout(youtubeMusicRestoreTimer);
 musicWin.webContents.setAudioMuted(true);
 youtubeMusicRestoreTimer=setTimeout(()=>{
  if(!musicWin.isDestroyed())musicWin.webContents.setAudioMuted(false);
 },Math.max(1000,Math.min(15000,Number(durationMs)||4500)));
 return {ok:true};
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
    width:savedScreenSettings.width,height:savedScreenSettings.height,minWidth:800,minHeight:600,
    title:"La Picá del Benjamín",backgroundColor:"#100b07",autoHideMenuBar:true,
    webPreferences:{
      preload:path.join(__dirname,"preload.js"),
      contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true,
      partition:"persist:lapica-local"
    }
  });
  if(savedScreenSettings.fullscreen)win.setFullScreen(true);
  win.on("resize",()=>{if(!win.isFullScreen()&&!win.isMaximized()){const [width,height]=win.getSize();savedScreenSettings.width=width;savedScreenSettings.height=height;persistScreenSettings();}});
  win.on("enter-full-screen",()=>{savedScreenSettings.fullscreen=true;persistScreenSettings();});
  win.on("leave-full-screen",()=>{savedScreenSettings.fullscreen=false;persistScreenSettings();});
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
ipcMain.handle("pos:set-window-size",async(_event,width,height)=>{const w=Number(width),h=Number(height);const allowed=[[800,600],[1024,768],[1280,720],[1280,1024],[1366,768],[1440,900],[1440,920],[1600,900],[1920,1080]];if(!allowed.some(([aw,ah])=>aw===w&&ah===h))throw new Error("Resolución no permitida.");if(!win||win.isDestroyed())throw new Error("Ventana POS no disponible.");if(win.isFullScreen())win.setFullScreen(false);win.setSize(w,h);win.center();savedScreenSettings={width:w,height:h,fullscreen:false};persistScreenSettings();return {ok:true,width:w,height:h};});
ipcMain.handle("pos:toggle-fullscreen",async()=>{if(!win||win.isDestroyed())throw new Error("Ventana POS no disponible.");const next=!win.isFullScreen();win.setFullScreen(next);savedScreenSettings.fullscreen=next;persistScreenSettings();return {ok:true,fullscreen:next};});
ipcMain.handle("pos:set-fullscreen",async(_event,value)=>{if(!win||win.isDestroyed())throw new Error("Ventana POS no disponible.");const next=!!value;win.setFullScreen(next);savedScreenSettings.fullscreen=next;persistScreenSettings();return {ok:true,fullscreen:next};});
ipcMain.handle("pos:focus-window",async()=>{
 if(!win||win.isDestroyed())return false;
 if(win.isMinimized())win.restore();
 if(!win.isVisible())win.show();
 win.focus();
 win.webContents.focus();
 return true;
});
if(gotSingleInstanceLock) app.whenReady().then(()=>{createWindow();configureAutoUpdates();});
app.on("window-all-closed",()=>{if(process.platform!=="darwin")app.quit()});
app.on("activate",()=>{if(BrowserWindow.getAllWindows().length===0)createWindow()});

const onlineCredentialsFile=path.join(app.getPath("userData"),"online-orders-credentials.bin");
function readOnlineCredentials(){
 try{if(!fs.existsSync(onlineCredentialsFile)||!require("electron").safeStorage.isEncryptionAvailable())return null;return JSON.parse(require("electron").safeStorage.decryptString(fs.readFileSync(onlineCredentialsFile)));}catch{return null;}
}
function saveOnlineCredentials(credentials){
 try{const safe=require("electron").safeStorage;if(!safe.isEncryptionAvailable())return false;fs.writeFileSync(onlineCredentialsFile,safe.encryptString(JSON.stringify({username:String(credentials.username||""),password:String(credentials.password||"")})),{mode:0o600});return true;}catch{return false;}
}
ipcMain.handle("pos:get-saved-online-credentials",()=>readOnlineCredentials());
ipcMain.handle("pos:save-online-credentials",(_event,credentials)=>({ok:saveOnlineCredentials(credentials)}));
ipcMain.handle("pos:clear-online-credentials",()=>{try{if(fs.existsSync(onlineCredentialsFile))fs.unlinkSync(onlineCredentialsFile);return {ok:true};}catch{return {ok:false};}});ipcMain.handle("pos:logout-online-orders",async()=>{try{if(fs.existsSync(onlineCredentialsFile))fs.unlinkSync(onlineCredentialsFile);const cookies=await win.webContents.session.cookies.get({url:"https://menu-la-pica-del-benjamin-pago.onrender.com"});for(const cookie of cookies){const url="https://menu-la-pica-del-benjamin-pago.onrender.com";await win.webContents.session.cookies.remove(url,cookie.name);}return {ok:true};}catch{return {ok:false};}});
ipcMain.handle("pos:login-online-orders",async(_event,credentials={})=>{
 if(!win||win.isDestroyed())return {ok:false,error:"POS no disponible."};
 const username=String(credentials.username||"").trim(),password=String(credentials.password||"");
 if(!username||!password)return {ok:false,error:"Ingresa usuario y contraseña."};
 try{
  const response=await win.webContents.session.fetch("https://menu-la-pica-del-benjamin-pago.onrender.com/api/personal/login",{
   method:"POST",credentials:"include",headers:{"Accept":"application/json","Content-Type":"application/json"},
   body:JSON.stringify({username,password})
  });
  const data=await response.json().catch(()=>({}));
  if(!response.ok){
   if(response.status===401||response.status===403){try{if(fs.existsSync(onlineCredentialsFile))fs.unlinkSync(onlineCredentialsFile);}catch{}}
   return {ok:false,error:data.error||("Inicio de sesión HTTP "+response.status),authRejected:response.status===401||response.status===403};
  }
  if(data.mustChangePassword)return {ok:false,error:"La cuenta debe cambiar su contraseña antes de conectar Pedidos Web/APK.",mustChangePassword:true};
  if(!data.user)return {ok:false,error:"El servidor no confirmó el usuario autenticado."};
  saveOnlineCredentials({username,password});
  return {ok:true,user:data.user,mustChangePassword:false};
 }catch(error){return {ok:false,error:error.message||"No se pudo conectar al servidor."};}
});
ipcMain.handle("pos:poll-online-orders",async()=>{
 if(!win||win.isDestroyed())return {ok:false,orders:[],error:"POS no disponible."};
 try{
  const base=new Date(),dates=[];
  for(let d=0;d<7;d++){const day=new Date(base);day.setDate(base.getDate()-d);dates.push(new Intl.DateTimeFormat("en-CA",{timeZone:"America/Santiago",year:"numeric",month:"2-digit",day:"2-digit"}).format(day));}
  const results=await Promise.all(dates.map(async date=>{
   const response=await win.webContents.session.fetch("https://menu-la-pica-del-benjamin-pago.onrender.com/api/reparto/pedidos?date="+date,{credentials:"include",headers:{"Accept":"application/json"}});
   if(!response.ok)throw new Error("Consulta de pedidos "+date+": HTTP "+response.status);
   const data=await response.json();return Array.isArray(data.orders)?data.orders:[];
  }));
  const unique=new Map();
  for(const o of results.flat())if(["online","web","apk","website","delivery","mercadopago","mercado_pago","mp","checkout"].includes(String(o.source||"online").toLowerCase()))unique.set(String(o.id),o);
  return {ok:true,orders:[...unique.values()].map(o=>({id:o.id,order_number:o.order_number,customer_name:o.customer_name,customer_phone:o.customer_phone,delivery_method:o.delivery_method,delivery_address:o.delivery_address,locality:o.locality,total_clp:o.total_clp,payment_status:o.payment_status,approval_status:o.approval_status,delivery_status:o.delivery_status,created_at:o.created_at,items_json:o.items_json,notes:o.notes}))};
 }catch(error){console.warn("No se pudieron consultar pedidos web:",error.message);return {ok:false,orders:[],error:error.message||"No se pudieron consultar pedidos. Revisa tu sesión de personal."};}
});
