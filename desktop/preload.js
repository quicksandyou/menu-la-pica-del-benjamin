"use strict";
const {contextBridge,ipcRenderer}=require("electron");
contextBridge.exposeInMainWorld("posBridge",{loadMenu:()=>ipcRenderer.invoke("pos:load-menu"),openService:service=>ipcRenderer.invoke("pos:open-service",service),pollDeliveryOrders:()=>ipcRenderer.invoke("pos:poll-delivery-orders")});
