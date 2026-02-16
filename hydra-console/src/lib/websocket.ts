// WebSocket client for real-time updates

import type { WsEvent, WsEventType } from '@/types';

type EventHandler = (event: WsEvent) => void;

class HydraWebSocket {
  private ws: WebSocket | null = null;
  private url: string;
  private handlers: Map<WsEventType | '*', Set<EventHandler>> = new Map();
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000;
  private shouldReconnect = true;

  constructor(url?: string) {
    this.url = url || `ws://${typeof window !== 'undefined' ? window.location.hostname : 'localhost'}:3340/ws`;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        resolve();
        return;
      }

      try {
        this.ws = new WebSocket(this.url);

        this.ws.onopen = () => {
          console.log('[HydraWS] Connected');
          this.reconnectAttempts = 0;
          resolve();
        };

        this.ws.onmessage = (event) => {
          try {
            const data: WsEvent = JSON.parse(event.data);
            data.timestamp = new Date(data.timestamp);
            this.emit(data);
          } catch (err) {
            console.error('[HydraWS] Failed to parse message:', err);
          }
        };

        this.ws.onclose = () => {
          console.log('[HydraWS] Disconnected');
          this.handleReconnect();
        };

        this.ws.onerror = (error) => {
          console.error('[HydraWS] Error:', error);
          reject(error);
        };
      } catch (err) {
        reject(err);
      }
    });
  }

  private handleReconnect() {
    if (!this.shouldReconnect) return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('[HydraWS] Max reconnect attempts reached');
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
    console.log(`[HydraWS] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

    setTimeout(() => {
      this.connect().catch(() => {
        // Will retry via onclose handler
      });
    }, delay);
  }

  disconnect() {
    this.shouldReconnect = false;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  on(event: WsEventType | '*', handler: EventHandler) {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler);

    // Return unsubscribe function
    return () => {
      this.handlers.get(event)?.delete(handler);
    };
  }

  off(event: WsEventType | '*', handler: EventHandler) {
    this.handlers.get(event)?.delete(handler);
  }

  private emit(wsEvent: WsEvent) {
    // Call specific event handlers
    this.handlers.get(wsEvent.type)?.forEach((handler) => handler(wsEvent));
    // Call wildcard handlers
    this.handlers.get('*')?.forEach((handler) => handler(wsEvent));
  }

  send(type: WsEventType, payload: unknown) {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      console.warn('[HydraWS] Cannot send - not connected');
      return false;
    }

    this.ws.send(
      JSON.stringify({
        type,
        payload,
        timestamp: new Date().toISOString(),
      })
    );
    return true;
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}

// Singleton instance
let instance: HydraWebSocket | null = null;

export function getWebSocket(): HydraWebSocket {
  if (!instance) {
    const wsUrl = process.env.NEXT_PUBLIC_ORCHESTRATOR_WS_URL;
    instance = new HydraWebSocket(wsUrl);
  }
  return instance;
}

export { HydraWebSocket };
