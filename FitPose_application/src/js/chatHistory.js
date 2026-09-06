import { Auth, Store } from './store.js';

function key() { const e = Auth.currentEmail(); return e ? `fitpose_chat_history_v2_${e.toLowerCase()}` : 'fitpose_chat_history_v2_guest'; }
function read() { try { return JSON.parse(localStorage.getItem(key()) || '[]'); } catch { return []; } }
function write(v) { localStorage.setItem(key(), JSON.stringify(v)); }
export function listChats() { return read().sort((a,b) => new Date(b.updatedAt)-new Date(a.updatedAt)); }
export function createChat(title='New conversation') { const chats=read(); const c={id:crypto.randomUUID?.()||String(Date.now()),title,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),messages:[]}; chats.unshift(c); write(chats); return c; }
export function saveChat(chat) { const chats=read(); const i=chats.findIndex(x=>x.id===chat.id); chat.updatedAt=new Date().toISOString(); if(i<0) chats.unshift(chat); else chats[i]=chat; write(chats); return chat; }
export function getChat(id) { return read().find(x=>x.id===id) || null; }
export function deleteChat(id) { write(read().filter(x=>x.id!==id)); }
export function renameChat(id,title) { const c=getChat(id); if(!c) return null; c.title=title.trim()||'Untitled conversation'; return saveChat(c); }
export function clearChats() { localStorage.removeItem(key()); }
