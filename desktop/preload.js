"use strict";
const {contextBridge,ipcRenderer}=require("electron");
contextBridge.exposeInMainWorld("posBridge",{loadMenu:()=>ipcRenderer.invoke("pos:load-menu"),openService:service=>ipcRenderer.invoke("pos:open-service",service),pollOnlineOrders:()=>ipcRenderer.invoke("pos:poll-online-orders"),printWebOrder:order=>ipcRenderer.invoke("pos:print-web-order",order),openPOS:()=>ipcRenderer.invoke("pos:open-dashboard")});
