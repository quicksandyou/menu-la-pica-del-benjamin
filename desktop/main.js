const {app,BrowserWindow,shell,dialog,ipcMain,net}=require("electron");
const {autoUpdater}=require("electron-updater");
const path=require("path");
const fs=require("fs");
let win;
let updatePromptOpen=false;
ipcMain.handle("pos:load-menu",async()=>{
  let onlineError=null;
  try {
    const controller=new AbortController();
    const timeout=setTimeout(()=>controller.abort(),15000);
    try {
      const response=await net.fetch("https://menu-la-pica-del-benjamin.onrender.com/menu.json?v="+Date.now(),{signal:controller.signal});
      if(!response.ok) throw new Error("La tienda respondió HTTP "+response.status);
      const data=await response.json();
      if(!Array.isArray(data.products)||!data.products.length) throw new Error("La carta online no contiene productos.");
      data._menuSource="online";
      return data;
    } finally { clearTimeout(timeout); }
  } catch(error) { onlineError=error; }
  try {
    const localPath=path.join(__dirname,"app","menu.json");
    const data=JSON.parse(fs.readFileSync(localPath,"utf8"));
    if(!Array.isArray(data.products)||!data.products.length) throw new Error("La copia local de la carta está vacía.");
    data._menuSource="local";
    data._menuWarning=onlineError?onlineError.message:"Sin conexión con la tienda";
    return data;
  } catch(localError) {
    throw new Error("No se pudo cargar la carta online ni la copia local. Online: "+(onlineError?onlineError.message:"error")+"; local: "+localError.message);
  }
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
