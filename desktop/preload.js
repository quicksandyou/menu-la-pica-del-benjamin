"use strict";
const {contextBridge,ipcRenderer}=require("electron");
contextBridge.exposeInMainWorld("posBridge",{loadMenu:()=>ipcRenderer.invoke("pos:load-menu"),openService:service=>ipcRenderer.invoke("pos:open-service",service),duckYouTubeMusic:duration=>ipcRenderer.invoke("pos:duck-youtube-music",duration),pollOnlineOrders:()=>ipcRenderer.invoke("pos:poll-online-orders"),printWebOrder:order=>ipcRenderer.invoke("pos:print-web-order",order),printLocalReceipt:payload=>ipcRenderer.invoke("pos:print-local-receipt",payload),openPOS:()=>ipcRenderer.invoke("pos:open-dashboard")});
