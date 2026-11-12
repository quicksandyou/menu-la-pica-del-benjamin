const {app,BrowserWindow,shell,dialog,ipcMain,net}=require("electron");
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
app.whenReady().then(()=>{createWindow();configureAutoUpdates();});
app.on("window-all-closed",()=>{if(process.platform!=="darwin")app.quit()});
app.on("activate",()=>{if(BrowserWindow.getAllWindows().length===0)createWindow()});
