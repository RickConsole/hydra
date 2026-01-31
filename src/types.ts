export interface RegisteredGroup {
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
}

export interface Session {
  [folder: string]: string;
}

export interface NewMessage {
  id: string;
  chat_jid: string;
  sender: string;
  content: string;
  timestamp: string;
}
