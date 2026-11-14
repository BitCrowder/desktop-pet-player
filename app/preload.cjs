const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('pet', {
  on: (name, callback) => ipcRenderer.on(`pet:${name}`, (_event, data) => callback(data)),
  send: (name, data) => ipcRenderer.send(`pet:${name}`, data),
});
