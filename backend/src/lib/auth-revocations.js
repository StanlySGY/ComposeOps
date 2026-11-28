import { EventEmitter } from 'node:events';
const events = new EventEmitter();
events.setMaxListeners(0);
export const notifyAuthRevoked = () => events.emit('revoked');
export function onAuthRevoked(callback) { events.on('revoked', callback); return () => events.off('revoked', callback); }
