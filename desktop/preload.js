"use strict";
const {contextBridge,ipcRenderer}=require("electron");
contextBridge.exposeInMainWorld("posBridge",{loadMenu:()=>ipcRenderer.invoke("pos:load-menu"),openService:service=>ipcRenderer.invoke("pos:open-service",service),openStaff:()=>ipcRenderer.invoke("pos:open-staff"),openTestMode:()=>ipcRenderer.invoke("pos:open-test-mode"),pollOnlineOrders:()=>ipcRenderer.invoke("pos:poll-online-orders"),printWebOrder:order=>ipcRenderer.invoke("pos:print-web-order",order),openPOS:()=>ipcRenderer.invoke("pos:open-dashboard")});
