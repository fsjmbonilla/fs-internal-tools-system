import type { Server } from 'socket.io';

/**
 * The one io instance, reachable from the service layer.
 *
 * Broadcasting used to live in the socket handler, so only messages sent *over a
 * socket* were delivered in real time. The REST send route and the support
 * automation both call messageService.sendMessage directly, and their messages
 * were never pushed — which meant the AI's replies were invisible until the page
 * was reloaded.
 *
 * Deliberately optional: tests build the app without a socket server, so every
 * caller has to treat a missing io as normal rather than an error.
 */
let io: Server | undefined;

/** Accepts undefined so a test can assert sending works without a socket server. */
export function setIo(server: Server | undefined): void {
  io = server;
}

export function getIo(): Server | undefined {
  return io;
}
