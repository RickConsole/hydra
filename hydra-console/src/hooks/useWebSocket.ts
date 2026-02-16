'use client';

import { useEffect, useState, useCallback } from 'react';
import { getWebSocket } from '@/lib/websocket';
import type { WsEvent, WsEventType } from '@/types';

export function useWebSocket() {
  const [isConnected, setIsConnected] = useState(false);
  const ws = getWebSocket();

  useEffect(() => {
    ws.connect()
      .then(() => setIsConnected(true))
      .catch(() => setIsConnected(false));

    // Listen for connection state changes via events
    const unsubscribe = ws.on('*', () => {
      setIsConnected(ws.isConnected);
    });

    return () => {
      unsubscribe();
    };
  }, [ws]);

  const subscribe = useCallback(
    (event: WsEventType | '*', handler: (event: WsEvent) => void) => {
      return ws.on(event, handler);
    },
    [ws]
  );

  const send = useCallback(
    (type: WsEventType, payload: unknown) => {
      return ws.send(type, payload);
    },
    [ws]
  );

  return {
    isConnected,
    subscribe,
    send,
  };
}
