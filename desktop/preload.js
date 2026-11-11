"use strict";
const {contextBridge,ipcRenderer}=require("electron");
contextBridge.exposeInMainWorld("posBridge",{loadMenu:()=>ipcRenderer.invoke("pos:load-menu")});
